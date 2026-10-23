import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';
import { notesMarkdown } from '../src/main/markdown-materials';
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-sync-034-')), book = path.join(root, '虚构书'); await fs.mkdir(book);
  const aData = path.join(root, 'A'), bData = path.join(root, 'B'), aRoot = path.join(aData, '创作资料'), bRoot = path.join(bData, '创作资料');
  const a = new Workspace(aData, aRoot), b = new Workspace(bData, bRoot); await a.initialize(); await b.initialize();
  const p = await a.attach(book); await b.attach(book);
  const canonical = path.join(aRoot, p.id), other = path.join(bRoot, p.id); await fs.mkdir(canonical, { recursive: true }); await fs.mkdir(other, { recursive: true });
  const service = new MaterialSyncService(a, aRoot, aData), second = new MaterialSyncService(b, bRoot, bData);
  const versions = path.join(book, '小说资料/创作资料同步/版本');
  const write = async (side: 'a' | 'b', file: string, text: string) => { const target = path.join(side === 'a' ? canonical : other, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); };
  const sync = () => service.synchronize({ projectId: p.id }), syncB = () => second.synchronize({ projectId: p.id });
  const manifests = async () => { const ids = await fs.readdir(versions); return Promise.all(ids.map(async id => JSON.parse(await fs.readFile(path.join(versions, id, 'manifest.json'), 'utf8')))); };
  return { root, book, a, b, aData, bData, aRoot, bRoot, p, canonical, other, versions, service, second, write, sync, syncB, manifests };
}
test('opt-in publishes only canonical materials; a fresh device inherits sharing and pulls into its fixed path', async () => {
  const f = await fixture();
  await f.write('a', '创作笔记.md', notesMarkdown({ schemaVersion: 1, projectId: f.p.id, world: 'A世界', preset: '', characters: '', style: '' }));
  await f.write('a', 'character-originals/card.json', '{"spec":"chara_card_v2","data":{"name":"虚构"}}');
  await fs.writeFile(path.join(f.aData, 'secret.txt'), 'test-credential-do-not-share');
  assert.equal((await f.sync()).status, 'disabled'); await assert.rejects(fs.access(f.versions));
  await f.service.configure(f.p.id, true); assert.equal((await f.sync()).status, 'clean');
  assert.equal((await f.syncB()).status, 'clean');
  assert.equal(await fs.readFile(path.join(f.other, '创作笔记.md'), 'utf8'), await fs.readFile(path.join(f.canonical, '创作笔记.md'), 'utf8'));
  assert.equal((await f.manifests())[0].entries.length, 2);
  assert.ok(!JSON.stringify(await f.manifests()).includes('secret'));
  await f.write('b', '补充.md', 'B修改'); await f.syncB(); await f.sync();
  assert.equal(await fs.readFile(path.join(f.canonical, '补充.md'), 'utf8'), 'B修改');
  const count = (await f.manifests()).length; await f.sync(); await f.syncB(); assert.equal((await f.manifests()).length, count);
  const restarted = new MaterialSyncService(f.a, f.aRoot, f.aData); assert.equal((await restarted.status(f.p.id)).status, 'clean');
});
test('three-way merge combines independent files and archives every replaced canonical tree', async () => {
  const f = await fixture(); await f.write('a', '共同.md', '基线'); await f.service.configure(f.p.id, true); await f.sync(); await f.syncB();
  await f.write('a', 'A.md', 'A独有'); await f.write('b', 'B.md', 'B独有'); await f.syncB();
  assert.equal((await f.service.status(f.p.id)).status, 'pending'); await f.sync();
  assert.equal(await fs.readFile(path.join(f.canonical, 'B.md'), 'utf8'), 'B独有'); await f.syncB();
  assert.equal(await fs.readFile(path.join(f.other, 'A.md'), 'utf8'), 'A独有');
  const history = path.join(f.aRoot, '同步历史', f.p.id), archives = await fs.readdir(history);
  assert.ok(archives.length); assert.equal(await fs.readFile(path.join(history, archives[0], '共同.md'), 'utf8'), '基线');
});
test('same file and delete/modify conflicts preserve both sides; stale selections cannot overwrite new data', async () => {
  const f = await fixture(); await f.write('a', '共同.md', '基线'); await f.service.configure(f.p.id, true); await f.sync(); await f.syncB();
  await f.write('a', '共同.md', 'A修订'); await f.write('b', '共同.md', 'B修订'); await f.syncB();
  const conflict = await f.sync(); assert.equal(conflict.status, 'conflicts'); assert.equal(conflict.files[0].action, 'conflict');
  assert.equal(await fs.readFile(path.join(f.canonical, '共同.md'), 'utf8'), 'A修订');
  await f.write('a', '共同.md', 'A后续');
  await assert.rejects(f.service.synchronize({ projectId: f.p.id, fingerprint: conflict.fingerprint, resolutions: [{ path: '共同.md', source: 'remote' }] }), /变化/);
  const fresh = await f.service.status(f.p.id);
  await f.service.synchronize({ projectId: f.p.id, fingerprint: fresh.fingerprint, resolutions: [{ path: '共同.md', source: 'remote' }] });
  assert.equal(await fs.readFile(path.join(f.canonical, '共同.md'), 'utf8'), 'B修订');
  await f.syncB(); await fs.unlink(path.join(f.canonical, '共同.md')); await f.write('b', '共同.md', 'B再修订'); await f.syncB();
  const deleted = await f.sync(); assert.equal(deleted.status, 'conflicts'); assert.equal(deleted.files[0].localHash, null);
  await f.service.synchronize({ projectId: f.p.id, fingerprint: deleted.fingerprint, resolutions: [{ path: '共同.md', source: 'local' }] });
  await assert.rejects(fs.access(path.join(f.canonical, '共同.md'))); await f.syncB();
  await assert.rejects(fs.access(path.join(f.other, '共同.md')));
  const archives = await fs.readdir(path.join(f.bRoot, '同步历史', f.p.id));
  assert.ok((await Promise.all(archives.map(id => fs.readFile(path.join(f.bRoot, '同步历史', f.p.id, id, '共同.md'), 'utf8').catch(() => '')))).includes('B再修订'));
});
test('first synchronization without baseline never chooses the winner by timestamp', async () => {
  const f = await fixture(); await f.write('a', '相同.md', 'A'); await f.write('b', '相同.md', 'B'); await f.service.configure(f.p.id, true); await f.sync();
  assert.equal((await f.syncB()).status, 'conflicts'); assert.equal(await fs.readFile(path.join(f.other, '相同.md'), 'utf8'), 'B');
  await f.second.configure(f.p.id, false); assert.equal((await f.syncB()).status, 'disabled');
  assert.equal((await f.manifests()).length, 1); assert.equal(await fs.readFile(path.join(f.other, '相同.md'), 'utf8'), 'B');
});
test('parallel remote leaves require an explicit full snapshot choice and merge retains all parents', async () => {
  const f = await fixture(); await f.write('a', '版本.md', 'base'); await f.service.configure(f.p.id, true); await f.sync(); await f.syncB();
  const before = (await f.manifests())[0];
  // Simulate two clients uploading immutable children of the same complete revision.
  for (const value of ['branch-A', 'branch-B']) {
    const id = randomUUID(), folder = path.join(f.versions, id); await fs.mkdir(folder); await fs.cp(path.join(f.versions, before.revisionId, 'files'), path.join(folder, 'files'), { recursive: true });
    const content = Buffer.from(value); await fs.writeFile(path.join(folder, 'files/版本.md'), content);
    const { createHash } = await import('node:crypto');
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ ...before, revisionId: id, parents: [before.revisionId], entries: [{ path: '版本.md', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }] }));
  }
  const branches = await f.sync(); assert.equal(branches.status, 'conflicts'); assert.equal(branches.remoteRevisions.length, 2);
  assert.equal(await fs.readFile(path.join(f.canonical, '版本.md'), 'utf8'), 'base');
  const revision = branches.remoteRevisions[0].id, preview = await f.service.status(f.p.id, revision);
  await f.service.synchronize({ projectId: f.p.id, remoteRevision: revision, fingerprint: preview.fingerprint });
  const final = await f.service.status(f.p.id); assert.equal(final.status, 'clean'); assert.equal(final.remoteRevisions.length, 1);
  const merged = (await f.manifests()).find(item => item.revisionId === final.remoteRevisions[0].id);
  assert.deepEqual(merged.parents.sort(), branches.remoteRevisions.map(item => item.id).sort());
});
test('partial uploads ignored; complete corrupt manifests, missing parents and changed payloads block', async () => {
  const f = await fixture(); await f.write('a', '文件.md', '初始'); await f.service.configure(f.p.id, true); await f.sync();
  const folder = path.join(f.versions, randomUUID()); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'partial.txt'), 'incomplete');
  assert.equal((await f.service.status(f.p.id)).status, 'clean');
  await fs.writeFile(path.join(folder, 'manifest.json'), '{'); await assert.rejects(f.sync(), /损坏/);
  await fs.unlink(path.join(folder, 'manifest.json'));
  const ids = await fs.readdir(f.versions); const committed = ids.find(id => path.join(f.versions, id) !== folder)!;
  const file = path.join(f.versions, committed, 'manifest.json'), raw = await fs.readFile(file, 'utf8'), parsed = JSON.parse(raw);
  await fs.writeFile(file, JSON.stringify({ ...parsed, parents: [randomUUID()] })); await assert.rejects(f.sync(), /完整/);
  await fs.writeFile(file, raw); await fs.writeFile(path.join(f.versions, committed, 'files/文件.md'), 'tampered');
  await assert.rejects(f.sync(), /哈希/); assert.equal(await fs.readFile(path.join(f.canonical, '文件.md'), 'utf8'), '初始');
});
test('foreign IDs, unknown local schema and unsafe metadata/paths never publish', async () => {
  const f = await fixture(); await f.service.configure(f.p.id, true);
  await f.write('a', '创作笔记.md', notesMarkdown({ schemaVersion: 1, projectId: randomUUID(), world: '不属于本书', preset: '', style: '', characters: '' }));
  await assert.rejects(f.sync(), /归属/); await fs.unlink(path.join(f.canonical, '创作笔记.md'));
  for (const filename of ['connections.json', '缓存.db', '临时.tmp']) {
    await f.write('a', filename, '{}'); await assert.rejects(f.sync(), /临时|数据库|账户/); await fs.unlink(path.join(f.canonical, filename));
  }
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(f.canonical, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.sync(), /链接/); assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(Promise.resolve().then(() => f.service.synchronize({ projectId: randomUUID() })), /关联/);
  await assert.rejects(Promise.resolve().then(() => f.service.synchronize({ projectId: f.p.id, resolutions: [] })), /指纹/);
});
test('source changed before publication aborts with original bytes retained', async () => {
  const f = await fixture(); await f.write('a', '文件.md', '初始'); await f.service.configure(f.p.id, true);
  const service = f.service as any, original = service.assertUnchanged.bind(service); let inject = true;
  service.assertUnchanged = async (...args: any[]) => { if (inject) { inject = false; await f.write('a', '文件.md', '外部新版'); } return original(...args); };
  await assert.rejects(f.sync(), /变化/); assert.equal(await fs.readFile(path.join(f.canonical, '文件.md'), 'utf8'), '外部新版');
  assert.equal((await f.service.status(f.p.id)).remoteRevisions.length, 0);
});
test('unknown local state and malformed remote paths/schema block without altering the canonical tree', async () => {
  const f = await fixture(); await f.write('a', '文件.md', '原件'); await f.service.configure(f.p.id, true); await f.sync();
  const stateFile = path.join(f.aData, 'material-sync', `${f.p.id}.json`), state = await fs.readFile(stateFile, 'utf8');
  await fs.writeFile(stateFile, state.replace('"schemaVersion": 1', '"schemaVersion": 2'));
  await assert.rejects(f.sync(), /版本/); await fs.writeFile(stateFile, state);
  const first = (await f.manifests())[0], file = path.join(f.versions, first.revisionId, 'manifest.json');
  for (const invalid of ['../outside.md', 'C:/outside.md', 'dir/file:secret', 'CON.md', 'dot./a.md']) {
    await fs.writeFile(file, JSON.stringify({ ...first, entries: [{ ...first.entries[0], path: invalid }] }));
    await assert.rejects(f.sync());
    assert.equal(await fs.readFile(path.join(f.canonical, '文件.md'), 'utf8'), '原件');
  }
  await fs.writeFile(file, JSON.stringify({ ...first, entries: [first.entries[0], { ...first.entries[0], path: '文件.MD' }] })); await assert.rejects(f.sync(), /重复|冲突/);
  await fs.writeFile(file, JSON.stringify({ ...first, schemaVersion: 2 })); await assert.rejects(f.sync(), /版本/);
  await fs.writeFile(file, JSON.stringify(first));
  await f.write('a', '过大.md', ''); await fs.truncate(path.join(f.canonical, '过大.md'), 32 * 1024 * 1024 + 1); await assert.rejects(f.sync(), /大小|过大/);
});
test('an interrupted post-swap operation retains the old tree and recovers its journal on next inspection', async () => {
  const f = await fixture(); await f.write('a', '文件.md', '旧版'); await f.service.configure(f.p.id, true); await f.sync(); await f.syncB();
  await f.write('b', '文件.md', '新版'); await f.syncB();
  const service = f.service as any, original = service.recoverPending.bind(service); let calls = 0;
  service.recoverPending = async (...args: any[]) => { if (++calls === 2) throw new Error('injected post-swap interruption'); return original(...args); };
  await assert.rejects(f.sync(), /换入失败/);
  assert.equal(await fs.readFile(path.join(f.canonical, '文件.md'), 'utf8'), '新版');
  const history = path.join(f.aRoot, '同步历史', f.p.id), archives = await fs.readdir(history);
  assert.ok((await Promise.all(archives.map(id => fs.readFile(path.join(history, id, '文件.md'), 'utf8')))).includes('旧版'));
  assert.equal((await f.service.status(f.p.id)).status, 'clean'); await f.sync();
  await assert.rejects(fs.access(path.join(f.aData, 'material-sync', `${f.p.id}-pending.json`)));
});
