import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CharacterTagMappingStore, type CharacterTagMapping } from '../src/main/character-tag-mapping';
import type { Workspace } from '../src/main/workspace';
import type { CharacterStore } from '../src/main/characters';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/tag-map-054-'));
  const id = randomUUID(), otherId = randomUUID(), first = randomUUID(), second = randomUUID();
  const folders = new Map<string, string>();
  for (const [key, name] of [[id, '甲'], [otherId, '乙']]) {
    const book = path.join(root, name); folders.set(key, book);
    await fs.mkdir(path.join(book, '小说资料'), { recursive: true });
    await fs.writeFile(path.join(book, '小说资料', 'project.json'), JSON.stringify({ schemaVersion: 1, id: key, name }));
  }
  const workspace = { getProject(key: string) { const folder = folders.get(key); if (!folder) throw new Error('未知小说'); return { id: key, name: path.basename(folder), root: folder }; } } as unknown as Workspace;
  const hashes = new Map<string, string>([[id, 'a'.repeat(64)], [otherId, 'b'.repeat(64)]]);
  const characters = { async read(key: string) { return { hash: hashes.get(key)!, value: { schemaVersion: 1, projectId: key, cards: key === id ? [{ id: first, projectId: id }, { id: second, projectId: id }] : [{ id: randomUUID(), projectId: otherId }] }, portraits: {} }; } } as unknown as Pick<CharacterStore, 'read'>;
  return { root, id, otherId, first, second, hashes, folders, store: new CharacterTagMappingStore(workspace, characters) };
}

test('酒馆角色关联：显式确认每角色 avatar/tag，未知与空标签分开，并按小说隔离', async () => {
  const f = await fixture(), initial = await f.store.read(f.id), otherBefore = await f.store.read(f.otherId);
  assert.deepEqual(initial.mappings, []); assert.equal(initial.hash, ''); assert.equal(initial.stale, false);
  const entries: CharacterTagMapping[] = [ { characterId: f.first, avatarKey: '林夏-原头像', tagIds: null }, { characterId: f.second, avatarKey: '阿岚', tagIds: [] } ];
  const saved = await f.store.save(f.id, entries, initial.hash, initial.characterHash);
  assert.equal(saved.stale, false); assert.deepEqual(saved.mappings, entries);
  entries[0].avatarKey = '后续改动'; assert.equal((await f.store.read(f.id)).mappings[0].avatarKey, '林夏-原头像');
  assert.deepEqual(await f.store.read(f.otherId), otherBefore);
  const raw = JSON.parse(await fs.readFile(path.join(f.folders.get(f.id)!, '小说资料', '酒馆角色关联.json'), 'utf8'));
  assert.equal(raw.schemaVersion, 1); assert.equal(raw.projectId, f.id); assert.equal(raw.characterHash, 'a'.repeat(64));
});

test('酒馆角色关联：外变拒绝并保留上版，角色变化令映射失效', async () => {
  const f = await fixture(), initial = await f.store.read(f.id), entry = { characterId: f.first, avatarKey: '林夏', tagIds: ['tag-1'] };
  const first = await f.store.save(f.id, [entry], initial.hash, initial.characterHash);
  const next = await f.store.save(f.id, [{ ...entry, tagIds: ['tag-2'] }], first.hash, first.characterHash);
  await assert.rejects(f.store.save(f.id, [entry], first.hash, first.characterHash), /修改|变化/u);
  const history = await fs.readdir(path.join(f.folders.get(f.id)!, '小说资料', '酒馆角色关联历史'));
  assert.equal(history.length, 1); assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.folders.get(f.id)!, '小说资料', '酒馆角色关联历史', history[0]), 'utf8')).mappings, [entry]);
  f.hashes.set(f.id, 'c'.repeat(64));
  assert.equal((await f.store.read(f.id)).stale, true);
  await assert.rejects(f.store.save(f.id, [entry], next.hash, next.characterHash), /角色卡已变化/u);
  const confirmed = await f.store.save(f.id, [entry], next.hash, 'c'.repeat(64));
  assert.equal(confirmed.stale, false); assert.equal(confirmed.characterHash, 'c'.repeat(64));
});

test('酒馆角色关联：拒绝跨书角色、重复 ID、路径注入及未知版本', async () => {
  const f = await fixture(), initial = await f.store.read(f.id);
  const valid = { characterId: f.first, avatarKey: '林夏', tagIds: ['tag-1'] };
  for (const entries of [[{ ...valid, characterId: randomUUID() }], [valid, valid], [valid, { ...valid, characterId: f.second }], [{ ...valid, avatarKey: '../其他' }], [{ ...valid, tagIds: ['x', 'x'] }]]) {
    await assert.rejects(f.store.save(f.id, entries, initial.hash, initial.characterHash));
  }
  const file = path.join(f.folders.get(f.id)!, '小说资料', '酒馆角色关联.json');
  const unknown = JSON.stringify({ schemaVersion: 99, projectId: f.id, updatedAt: '', characterHash: 'a'.repeat(64), mappings: [] });
  await fs.writeFile(file, unknown);
  await assert.rejects(f.store.read(f.id), /版本/u);
  await assert.rejects(f.store.save(f.id, [valid], '', initial.characterHash), /版本/u);
  assert.equal(await fs.readFile(file, 'utf8'), unknown);
});

test('酒馆角色关联：书籍归属变更及元数据目录链接拒绝', async () => {
  const f = await fixture(), original = await f.store.read(f.id);
  const file = path.join(f.folders.get(f.id)!, '小说资料', 'project.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, id: f.otherId, name: '甲' }));
  await assert.rejects(f.store.read(f.id), /归属/u);
  await assert.rejects(f.store.save(f.id, [], original.hash, original.characterHash), /归属/u);
  const third = randomUUID(), linkedRoot = path.join(f.root, '丙'); await fs.mkdir(linkedRoot);
  await fs.symlink(path.join(f.folders.get(f.otherId)!, '小说资料'), path.join(linkedRoot, '小说资料'), process.platform === 'win32' ? 'junction' : 'dir');
  f.folders.set(third, linkedRoot);
  await assert.rejects(f.store.read(third), /链接|越界/u);
});

test('酒馆角色关联：外部编辑的重复映射不能绕过校验', async () => {
  const f = await fixture(), initial = await f.store.read(f.id);
  const entry = { characterId: f.first, avatarKey: '林夏', tagIds: ['tag-1'] };
  const saved = await f.store.save(f.id, [entry], initial.hash, initial.currentCharacterHash);
  const file = path.join(f.folders.get(f.id)!, '小说资料', '酒馆角色关联.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.mappings.push(entry);
  const tampered = JSON.stringify(raw);
  await fs.writeFile(file, tampered);
  await assert.rejects(f.store.read(f.id), /损坏|版本/u);
  await assert.rejects(f.store.save(f.id, [entry], saved.hash, saved.currentCharacterHash), /损坏|版本/u);
  assert.equal(await fs.readFile(file, 'utf8'), tampered);
});

test('酒馆角色关联：读取期间文件或角色卡变化不能返回旧关联', async t => {
  const f = await fixture(), initial = await f.store.read(f.id);
  await f.store.save(f.id, [{ characterId: f.first, avatarKey: '原头像', tagIds: ['tag-1'] }], initial.hash, initial.currentCharacterHash);
  const record = (f.store as unknown as { record: { read: (id: string) => Promise<any> } }).record;
  const original = record.read.bind(record); let changed = false;
  t.mock.method(record, 'read', async (id: string) => {
    const value = await original(id);
    if (!changed) {
      changed = true;
      const file = path.join(f.folders.get(id)!, '小说资料', '酒馆角色关联.json');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      data.mappings[0].avatarKey = '外部更新';
      await fs.writeFile(file, JSON.stringify(data));
    }
    return value;
  });
  await assert.rejects(f.store.read(f.id), /变化|修改/u);
});
