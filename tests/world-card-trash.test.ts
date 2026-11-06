import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { WorldInfoStore } from '../src/main/world-info';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/world-trash-'));
  const folder = path.join(root, '虚构甲'); await fs.mkdir(folder);
  const workspace = new Workspace(path.join(root, 'profile'), path.join(root, 'materials')); await workspace.initialize();
  const project = await workspace.attach(folder), store = new WorldInfoStore(workspace);
  const json = { name: '世界', extensions: { custom: [1, 2] }, entries: {
    '1': { comment: '虚构港', key: ['港'], content: '港口资料', unknown: { plugin: 7 }, characterFilter: { names: ['某人'] } },
    '2': { comment: '高地', key: ['山'], content: '保留此卡' }
  } };
  await store.import(project.id, '世界', json);
  return { root, folder, workspace, project, store, json, file: path.join(folder, '小说资料', '世界书', '世界.json'), trash: path.join(folder, '小说资料', '世界设定卡回收站') };
}

test('删除和恢复单卡：保留未知字段，恢复时不回滚其他卡的后续修改', async () => {
  const f = await fixture(), id = f.project.id; const before = await fs.readFile(f.file);
  const snapshot = await f.store.readSnapshot(id, '世界');
  const removed = await f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: snapshot.hash });
  assert.deepEqual(await fs.readFile(path.join(f.folder, '小说资料', '世界书修改备份', removed.backup)), before);
  const afterDelete = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(Object.hasOwn(afterDelete.entries, '1'), false); assert.deepEqual(afterDelete.entries['2'], f.json.entries['2']);
  const listed = await f.store.listEntryTrash(id); assert.equal(listed.items[0]!.id, removed.trashId); assert.equal(listed.items[0]!.name, '虚构港');
  const edited = await f.store.saveEntry({ projectId: id, book: '世界', entryId: '2', expectedHash: removed.hash, comment: '高地', content: '后续修改', keys: ['山'] });
  await f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: edited.hash });
  const restored = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(restored.entries['1'], f.json.entries['1']); assert.equal(restored.entries['2'].content, '后续修改'); assert.deepEqual(restored.extensions, f.json.extensions);
  assert.equal((await f.store.listEntryTrash(id)).items.length, 1, '恢复后备份继续保留');
  const latest = await f.store.readSnapshot(id, '世界');
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: latest.hash }), /同 ID 条目/u);
});

test('删除及恢复不覆盖外部更改，备份不能跨书读取', async () => {
  const f = await fixture(), id = f.project.id, snapshot = await f.store.readSnapshot(id, '世界');
  const external = JSON.stringify({ ...f.json, changedOutside: true }); await fs.writeFile(f.file, external);
  await assert.rejects(f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: snapshot.hash }), /外部变化/u);
  assert.equal(await fs.readFile(f.file, 'utf8'), external);
  const fresh = await f.store.readSnapshot(id, '世界'); const removed = await f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: fresh.hash });
  const changedAgain = (await fs.readFile(f.file, 'utf8')) + '\n'; await fs.writeFile(f.file, changedAgain);
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: removed.hash }), /外部变化/u);
  assert.equal(await fs.readFile(f.file, 'utf8'), changedAgain);
  const otherFolder = path.join(f.root, '虚构乙'); await fs.mkdir(otherFolder); const other = await f.workspace.attach(otherFolder);
  await assert.rejects(f.store.restoreEntry({ projectId: other.id, trashId: removed.trashId, expectedHash: removed.hash }));
  assert.deepEqual((await f.store.listEntryTrash(other.id)).items, []);
});

test('数组条目删除和恢复保留原顺序、扩展与完整备份，其他条目修改时拒绝恢复', async () => {
  const f = await fixture(), id = f.project.id;
  const input = { name: '数组世界', extensions: { setting: true }, entries: [{ comment: '甲', content: '甲', extra: { source: 1 } }, { comment: '乙', content: '乙' }, { comment: '丙', content: '丙' }] };
  await f.store.import(id, '数组世界', input);
  const file = path.join(f.folder, '小说资料', '世界书', '数组世界.json'), original = await fs.readFile(file), snapshot = await f.store.readSnapshot(id, '数组世界');
  assert.equal(snapshot.container, 'array');
  await assert.rejects(f.store.deleteEntry({ projectId: id, book: '数组世界', entryId: '01', expectedHash: snapshot.hash }), /编号无效/u);
  const removed = await f.store.deleteEntry({ projectId: id, book: '数组世界', entryId: '1', expectedHash: snapshot.hash });
  assert.deepEqual(await fs.readFile(path.join(f.folder, '小说资料', '世界书修改备份', removed.backup)), original);
  const list = await f.store.listEntryTrash(id); assert.equal(list.items[0]!.container, 'array');
  const after = JSON.parse(await fs.readFile(file, 'utf8')); assert.deepEqual(after.entries, [input.entries[0], input.entries[2]]);
  after.entries[0].content = '外部的新修改'; await fs.writeFile(file, JSON.stringify(after));
  const changed = await f.store.readSnapshot(id, '数组世界'); const changedBytes = await fs.readFile(file);
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: changed.hash }), /数组条目在删除后发生变化/u);
  assert.deepEqual(await fs.readFile(file), changedBytes);
  after.entries[0].content = '甲'; after.extensions.setting = false; await fs.writeFile(file, JSON.stringify(after));
  const current = await f.store.readSnapshot(id, '数组世界');
  await f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: current.hash });
  const restored = JSON.parse(await fs.readFile(file, 'utf8')); assert.deepEqual(restored.entries, input.entries); assert.equal(restored.extensions.setting, false);
  const latest = await f.store.readSnapshot(id, '数组世界');
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: latest.hash }), /数组条目在删除后发生变化/u);
  assert.equal((await f.store.listEntryTrash(id)).items.length, 1);
});

test('数组连续删除只能在列表匹配时按逆序恢复，不覆盖后续条目', async () => {
  const f = await fixture(), id = f.project.id;
  const input = { entries: [{ comment: '甲', content: '甲' }, { comment: '乙', content: '乙' }, { comment: '丙', content: '丙' }] };
  await f.store.import(id, '数组连续', input);
  const snapshot = await f.store.readSnapshot(id, '数组连续');
  const first = await f.store.deleteEntry({ projectId: id, book: '数组连续', entryId: '0', expectedHash: snapshot.hash });
  const second = await f.store.deleteEntry({ projectId: id, book: '数组连续', entryId: '0', expectedHash: first.hash });
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: first.trashId, expectedHash: second.hash }), /数组条目在删除后发生变化/u);
  const undoSecond = await f.store.restoreEntry({ projectId: id, trashId: second.trashId, expectedHash: second.hash });
  await f.store.restoreEntry({ projectId: id, trashId: first.trashId, expectedHash: undoSecond.hash });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.folder, '小说资料', '世界书', '数组连续.json'), 'utf8')).entries, input.entries);
});

test('数组其他条目变化后可显式追加备份，保留修改与扩展且阻止同标识重复', async () => {
  const f = await fixture(), id = f.project.id;
  const input = { entries: [{ uid: 11, comment: '甲', content: '甲' }, { uid: 12, comment: '乙', content: '乙', extensions: { plugin: 1 } }, { uid: 13, comment: '丙', content: '丙' }] };
  await f.store.import(id, '数组追加', input);
  const file = path.join(f.folder, '小说资料', '世界书', '数组追加.json'), snapshot = await f.store.readSnapshot(id, '数组追加');
  const removed = await f.store.deleteEntry({ projectId: id, book: '数组追加', entryId: '1', expectedHash: snapshot.hash });
  const changed = JSON.parse(await fs.readFile(file, 'utf8')); changed.entries[0].content = '甲的新修改'; await fs.writeFile(file, JSON.stringify(changed));
  changed.entries[0].uid = 12; await fs.writeFile(file, JSON.stringify(changed));
  const conflicting = await f.store.readSnapshot(id, '数组追加');
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: conflicting.hash, mode: 'append' }), /相同 uid 标识/u);
  changed.entries[0].uid = 11; await fs.writeFile(file, JSON.stringify(changed));
  const current = await f.store.readSnapshot(id, '数组追加');
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: current.hash }), /数组条目在删除后发生变化/u);
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: removed.hash, mode: 'append' }), /外部变化/u);
  const appended = await f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: current.hash, mode: 'append' });
  const result = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(result.entries[0].content, '甲的新修改'); assert.deepEqual(result.entries[1], input.entries[2]); assert.deepEqual(result.entries[2], input.entries[1]);
  assert.ok(await fs.stat(path.join(f.folder, '小说资料', '世界书修改备份', appended.backup)));
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: appended.hash, mode: 'append' }), /相同 uid 标识/u);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), result);
});

test('追加恢复拒绝语义未变的重复卡、冲突标识和对象世界书', async () => {
  const f = await fixture(), id = f.project.id;
  const input = { entries: [{ comment: '甲', content: '甲', extra: { a: 1, b: 2 } }, { comment: '乙', content: '乙' }] };
  await f.store.import(id, '重复保护', input);
  const file = path.join(f.folder, '小说资料', '世界书', '重复保护.json'), snapshot = await f.store.readSnapshot(id, '重复保护');
  const removed = await f.store.deleteEntry({ projectId: id, book: '重复保护', entryId: '0', expectedHash: snapshot.hash });
  const current = JSON.parse(await fs.readFile(file, 'utf8')); current.entries.push({ extra: { b: 2, a: 1 }, content: '甲', comment: '甲' }); await fs.writeFile(file, JSON.stringify(current));
  const changed = await f.store.readSnapshot(id, '重复保护');
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: changed.hash, mode: 'append' }), /相同内容/u);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), current);
  const objects = await f.store.readSnapshot(id, '世界'); const deletedObject = await f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: objects.hash });
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: deletedObject.trashId, expectedHash: deletedObject.hash, mode: 'append' }), /只有数组格式/u);
});

test('清理回收记录只删除已确认的单条备份，不改变世界书或完整原书备份', async () => {
  const f = await fixture(), id = f.project.id, original = await fs.readFile(f.file), snapshot = await f.store.readSnapshot(id, '世界');
  const removed = await f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: snapshot.hash });
  const after = await fs.readFile(f.file), item = (await f.store.listEntryTrash(id)).items[0]!;
  const preview = await f.store.previewEntryTrash({ projectId: id, trashId: item.id, expectedHash: item.hash });
  assert.equal(preview.comment, '虚构港'); assert.equal(preview.content, '港口资料'); assert.deepEqual(preview.keys, ['港']);
  assert.deepEqual(await fs.readFile(f.file), after);
  const otherFolder = path.join(f.root, '清理隔离书'); await fs.mkdir(otherFolder); const other = await f.workspace.attach(otherFolder);
  await assert.rejects(f.store.previewEntryTrash({ projectId: other.id, trashId: item.id, expectedHash: item.hash }));
  await assert.rejects(f.store.purgeEntryTrash({ projectId: other.id, trashId: item.id, expectedHash: item.hash }));
  const record = path.join(f.trash, `${item.id}.json`), raw = await fs.readFile(record);
  await fs.writeFile(record, Buffer.concat([raw, Buffer.from('\n')]));
  await assert.rejects(f.store.previewEntryTrash({ projectId: id, trashId: item.id, expectedHash: item.hash }), /备份已变化/u);
  await assert.rejects(f.store.purgeEntryTrash({ projectId: id, trashId: item.id, expectedHash: item.hash }), /备份已变化/u);
  assert.deepEqual(await fs.readFile(f.file), after);
  const updated = (await f.store.listEntryTrash(id)).items[0]!;
  await f.store.purgeEntryTrash({ projectId: id, trashId: item.id, expectedHash: updated.hash });
  assert.equal((await f.store.listEntryTrash(id)).items.length, 0); assert.deepEqual(await fs.readFile(f.file), after);
  assert.deepEqual(await fs.readFile(path.join(f.folder, '小说资料', '世界书修改备份', removed.backup)), original);
  await assert.rejects(f.store.restoreEntry({ projectId: id, trashId: item.id, expectedHash: removed.hash }));
});

test('作者逐字段合并备份到现有卡，保留未选字段、其他条目与未知扩展', async () => {
  const f = await fixture(), id = f.project.id, setup = JSON.parse(await fs.readFile(f.file, 'utf8'));
  setup.entries['2'].unknown = { plugin: '保留目标扩展' }; await fs.writeFile(f.file, JSON.stringify(setup));
  const initial = await f.store.readSnapshot(id, '世界');
  const removed = await f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: initial.hash });
  const item = (await f.store.listEntryTrash(id)).items[0]!, beforeMerge = await fs.readFile(f.file);
  const result = await f.store.mergeEntryTrash({ projectId: id, trashId: item.id, expectedTrashHash: item.hash, targetEntryId: '2', expectedBookHash: removed.hash, fields: { comment: 'current', content: 'backup', keys: 'backup' } });
  assert.deepEqual(await fs.readFile(path.join(f.folder, '小说资料', '世界书修改备份', result.backup)), beforeMerge);
  const merged = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(merged.entries['2'].comment, '高地'); assert.equal(merged.entries['2'].content, '港口资料'); assert.deepEqual(merged.entries['2'].key, ['港']);
  assert.deepEqual(merged.entries['2'].unknown, { plugin: '保留目标扩展' }); assert.deepEqual(merged.extensions, f.json.extensions); assert.equal((await f.store.listEntryTrash(id)).items.length, 1);
  const updated = await f.store.readSnapshot(id, '世界');
  assert.throws(() => f.store.mergeEntryTrash({ projectId: id, trashId: item.id, expectedTrashHash: item.hash, targetEntryId: '2', expectedBookHash: updated.hash, fields: { comment: 'current', content: 'current', keys: 'current' } }));
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), merged);
});

test('合并前备份或世界书变化以及跨小说访问均拒绝，保留外部版本', async () => {
  const f = await fixture(), id = f.project.id, snapshot = await f.store.readSnapshot(id, '世界');
  const removed = await f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: snapshot.hash });
  const item = (await f.store.listEntryTrash(id)).items[0]!;
  const request = { projectId: id, trashId: item.id, expectedTrashHash: item.hash, targetEntryId: '2', expectedBookHash: removed.hash, fields: { comment: 'backup' as const, content: 'current' as const, keys: 'current' as const } };
  const otherFolder = path.join(f.root, '合并隔离书'); await fs.mkdir(otherFolder); const other = await f.workspace.attach(otherFolder);
  await assert.rejects(f.store.mergeEntryTrash({ ...request, projectId: other.id }));
  const external = (await fs.readFile(f.file, 'utf8')) + '\n'; await fs.writeFile(f.file, external);
  await assert.rejects(f.store.mergeEntryTrash(request), /世界书已在外部变化/u); assert.equal(await fs.readFile(f.file, 'utf8'), external);
  const fresh = await f.store.readSnapshot(id, '世界'), record = path.join(f.trash, `${item.id}.json`); await fs.appendFile(record, '\n');
  await assert.rejects(f.store.mergeEntryTrash({ ...request, expectedBookHash: fresh.hash }), /备份已变化/u); assert.equal(await fs.readFile(f.file, 'utf8'), external);
});

test('特殊字段和条目 ID 在备份与恢复后仍为原始 JSON 属性', async () => {
  const f = await fixture(), id = f.project.id;
  const special = JSON.parse('{"entries":{"__proto__":{"comment":"特殊卡","content":"内容","__proto__":{"extension":"原样保留"},"constructor":"扩展"}}}');
  await f.store.import(id, '特殊世界', special);
  const snapshot = await f.store.readSnapshot(id, '特殊世界');
  const removed = await f.store.deleteEntry({ projectId: id, book: '特殊世界', entryId: '__proto__', expectedHash: snapshot.hash });
  await f.store.restoreEntry({ projectId: id, trashId: removed.trashId, expectedHash: removed.hash });
  const restored = JSON.parse(await fs.readFile(path.join(f.folder, '小说资料', '世界书', '特殊世界.json'), 'utf8'));
  assert.deepEqual(restored, special);
  assert.equal(Object.hasOwn(restored.entries, '__proto__'), true);
  assert.equal(Object.hasOwn(restored.entries.__proto__, '__proto__'), true);
});

test('回收记录被破坏时拒绝删除，世界书不变', async t => {
  const f = await fixture(), id = f.project.id, original = await fs.readFile(f.file), snapshot = await f.store.readSnapshot(id, '世界');
  const mutable = fs as unknown as { lstat: (...args: any[]) => Promise<any> }; const lstat = mutable.lstat.bind(fs); let reads = 0, injected = false;
  t.mock.method(mutable, 'lstat', async (...args: any[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === f.file && ++reads === 3) {
      const records = await fs.readdir(f.trash); await fs.writeFile(path.join(f.trash, records[0]!), '损坏的备份'); injected = true;
    }
    return lstat(...args);
  });
  await assert.rejects(f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: snapshot.hash }), /备份已变化/u);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(f.file), original);
  assert.equal((await f.store.listEntryTrash(id)).errors.length, 1);
});

test('单卡删除与整本世界书删除在同一进程串行，过期请求不能删除整本书', async () => {
  const f = await fixture(), id = f.project.id, snapshot = await f.store.readSnapshot(id, '世界');
  const results = await Promise.allSettled([
    f.store.deleteEntry({ projectId: id, book: '世界', entryId: '1', expectedHash: snapshot.hash }),
    f.store.remove(id, '世界', snapshot.hash)
  ]);
  assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected');
  const current = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(Object.hasOwn(current.entries, '1'), false); assert.deepEqual(current.entries['2'], f.json.entries['2']);
});
