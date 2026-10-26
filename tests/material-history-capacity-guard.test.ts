import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(directory, entry.name), relative = path.relative(root, file);
      if (entry.isDirectory()) { result[relative] = 'directory'; await visit(file); }
      else { assert.equal(entry.isFile(), true); result[relative] = hash(await fs.readFile(file)); }
    }
  };
  await visit(root); return result;
}
async function fillTo(directory: string, count: number) {
  await fs.mkdir(directory, { recursive: true });
  const existing = (await fs.readdir(directory)).length;
  for (let index = existing; index < count; index += 32) {
    await Promise.all(Array.from({ length: Math.min(32, count - index) }, () => fs.mkdir(path.join(directory, randomUUID()))));
  }
  assert.equal((await fs.readdir(directory)).length, count);
}
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-history-capacity-guard-045-'));
  const book = path.join(root, '虚构容量边界小说'); await fs.mkdir(book);
  const aData = path.join(root, 'A'), bData = path.join(root, 'B');
  const aRoot = path.join(aData, '创作资料'), bRoot = path.join(bData, '创作资料');
  const a = new Workspace(aData, aRoot), b = new Workspace(bData, bRoot); await a.initialize(); await b.initialize();
  const project = await a.attach(book); await b.attach(book);
  const canonical = path.join(aRoot, project.id), other = path.join(bRoot, project.id);
  await fs.mkdir(canonical, { recursive: true }); await fs.mkdir(other, { recursive: true });
  const service = new MaterialSyncService(a, aRoot, aData), second = new MaterialSyncService(b, bRoot, bData);
  const versions = path.join(book, '小说资料/创作资料同步/版本'), localHistory = path.join(bRoot, '同步历史', project.id);
  const write = (side: 'a' | 'b', file: string, value: string) => fs.writeFile(path.join(side === 'a' ? canonical : other, file), value);
  const sync = () => service.synchronize({ projectId: project.id }), syncB = () => second.synchronize({ projectId: project.id });
  const start = async () => {
    await write('a', '虚构资料.txt', '虚构基线'); await service.configure(project.id, true); await sync(); await syncB();
  };
  return { root, book, aData, bData, aRoot, bRoot, canonical, other, project, versions, localHistory, service, second, write, sync, syncB, start };
}

test('full transport including partial uploads rejects a new revision without leaving entry 1001 or changing state', async () => {
  const f = await fixture(); await f.write('a', '虚构资料.txt', '未发布的新资料');
  await fillTo(f.versions, 1000); await f.service.configure(f.project.id, true);
  const before = await snapshot(f.root);
  await assert.rejects(f.sync(), /1000|容量|历史/u);
  assert.deepEqual(await snapshot(f.root), before, 'Rejected publish must not leave an extra partial-upload directory or any new stage');
  assert.equal((await f.service.status(f.project.id)).status, 'pending');
});

test('full local archive rejects a pull before replacing canonical or changing baseline', async () => {
  const f = await fixture(); await f.start();
  await f.write('a', '虚构资料.txt', '远端新内容'); await f.sync();
  await fillTo(f.localHistory, 1000); const before = await snapshot(f.root);
  await assert.rejects(f.syncB(), /1000|容量|历史/u);
  assert.deepEqual(await snapshot(f.root), before, 'Rejected pull must leave canonical, baseline, histories and stage set untouched');
  assert.equal(await fs.readFile(path.join(f.other, '虚构资料.txt'), 'utf8'), '虚构基线');
  assert.equal((await f.second.status(f.project.id)).status, 'pending');
});

test('full local archive blocks a combined publish and pull before publishing a needless remote revision', async () => {
  const f = await fixture(); await f.start();
  await f.write('a', '远端新增.txt', '远端独立新增'); await f.sync(); await f.write('b', '本机新增.txt', '本机独立新增');
  await fillTo(f.localHistory, 1000); const before = await snapshot(f.root);
  await assert.rejects(f.syncB(), /1000|容量|历史/u);
  assert.deepEqual(await snapshot(f.root), before, 'Capacity must be checked for both sides before publish or canonical staging');
  assert.equal(await fs.readFile(path.join(f.other, '本机新增.txt'), 'utf8'), '本机独立新增');
  await assert.rejects(fs.access(path.join(f.other, '远端新增.txt')));
});

test('transport 999 to 1000 succeeds, clean synchronization still works, and the next new version is rejected', async () => {
  const f = await fixture(); await f.write('a', '虚构资料.txt', '第1000个条目');
  await fillTo(f.versions, 999); await f.service.configure(f.project.id, true);
  assert.equal((await f.sync()).status, 'clean');
  assert.equal((await fs.readdir(f.versions)).length, 1000);
  const versions = await snapshot(f.versions), canonical = await snapshot(f.canonical);
  assert.equal((await f.sync()).status, 'clean');
  assert.deepEqual(await snapshot(f.versions), versions); assert.deepEqual(await snapshot(f.canonical), canonical);
  await f.write('a', '虚构资料.txt', '容量满后尚未同步的内容'); const before = await snapshot(f.root);
  await assert.rejects(f.sync(), /1000|容量|历史/u); assert.deepEqual(await snapshot(f.root), before);
});

test('a full transport permits a pull that does not publish a new version', async () => {
  const f = await fixture(); await f.start(); await fillTo(f.versions, 999);
  await f.write('a', '虚构资料.txt', '无需再发版本的远端内容'); assert.equal((await f.sync()).status, 'clean');
  assert.equal((await fs.readdir(f.versions)).length, 1000); const before = await snapshot(f.versions);
  assert.equal((await f.syncB()).status, 'clean');
  assert.equal(await fs.readFile(path.join(f.other, '虚构资料.txt'), 'utf8'), '无需再发版本的远端内容');
  assert.deepEqual(await snapshot(f.versions), before);
});

test('local archives 999 to 1000 retain old bytes and the next pull is rejected before changes', async () => {
  const f = await fixture(); await f.start(); await fillTo(f.localHistory, 999);
  await f.write('a', '虚构资料.txt', '允许第1000个本机历史'); await f.sync();
  const previous = new Set(await fs.readdir(f.localHistory));
  assert.equal((await f.syncB()).status, 'clean');
  const current = await fs.readdir(f.localHistory); assert.equal(current.length, 1000);
  const added = current.filter(id => !previous.has(id)); assert.equal(added.length, 1);
  assert.equal(await fs.readFile(path.join(f.localHistory, added[0]!, '虚构资料.txt'), 'utf8'), '虚构基线');
  assert.equal((await f.syncB()).status, 'clean'); assert.equal((await fs.readdir(f.localHistory)).length, 1000);
  await f.write('a', '虚构资料.txt', '本机满额后待拉取'); await f.sync(); const before = await snapshot(f.root);
  await assert.rejects(f.syncB(), /1000|容量|历史/u); assert.deepEqual(await snapshot(f.root), before);
});

test('a full local archive permits a pure push that preserves canonical without creating another archive', async () => {
  const f = await fixture(); await f.start(); await fillTo(f.localHistory, 1000);
  await f.write('b', '本机新增.txt', '纯推送无需替换本机'); const local = await snapshot(f.other), old = await snapshot(f.localHistory);
  assert.equal((await f.syncB()).status, 'clean');
  assert.deepEqual(await snapshot(f.other), local); assert.deepEqual(await snapshot(f.localHistory), old);
  assert.equal((await fs.readdir(f.versions)).length, 2);
});

test('a full local archive does not block first pull into a missing canonical directory because no old tree is archived', async () => {
  const f = await fixture(); await f.write('a', '虚构资料.txt', '首次拉取的新本机');
  await f.service.configure(f.project.id, true); await f.sync();
  await fs.rmdir(f.other); // This explicitly named, empty fictional fixture directory only.
  await fillTo(f.localHistory, 1000); const old = await snapshot(f.localHistory);
  assert.equal((await f.syncB()).status, 'clean');
  assert.equal(await fs.readFile(path.join(f.other, '虚构资料.txt'), 'utf8'), '首次拉取的新本机');
  assert.deepEqual(await snapshot(f.localHistory), old);
});

test('transport capacity is checked again after preflight and before creating a publish directory', async () => {
  const f = await fixture(); await f.write('a', '虚构资料.txt', '外部上传与本机发布交错');
  await fillTo(f.versions, 999); await f.service.configure(f.project.id, true);
  const mutable = f.service as unknown as { bookLocations(projectId: string, create: boolean): Promise<{ book: string; versions: string }> };
  const original = mutable.bookLocations.bind(f.service); let injected = false, expected: Record<string, string> | undefined;
  mutable.bookLocations = async (id, create) => {
    const locations = await original(id, create);
    if (create && !injected) {
      injected = true; await fillTo(f.versions, 1000); expected = await snapshot(f.root);
    }
    return locations;
  };
  await assert.rejects(f.sync(), /1000|容量|历史/u); assert.equal(injected, true);
  assert.deepEqual(await snapshot(f.root), expected, 'External entry remains but application must not add another partial directory');
});

test('local capacity filled during staging is rechecked before journal or archive publication', async () => {
  const f = await fixture(); await f.start();
  await f.write('a', '虚构资料.txt', '暂存期间发生外部历史增长'); await f.sync();
  const beforeCanonical = await snapshot(f.other), beforeVersions = await snapshot(f.versions);
  const stateFile = path.join(f.bData, 'material-sync', `${f.project.id}.json`), beforeState = await fs.readFile(stateFile);
  const mutable = f.second as unknown as { writeFiles(directory: string, tree: unknown): Promise<void> };
  const original = mutable.writeFiles.bind(f.second); let staged = '', injected = false;
  mutable.writeFiles = async (directory, tree) => {
    await original(directory, tree);
    if (path.dirname(directory) === f.bRoot && path.basename(directory).startsWith(`sync-stage-${f.project.id}-`)) {
      assert.equal(injected, false); injected = true; staged = directory; await fillTo(f.localHistory, 1000);
    }
  };
  await assert.rejects(f.syncB(), /1000|容量|历史/u); assert.equal(injected, true);
  assert.equal((await fs.readdir(f.localHistory)).length, 1000);
  assert.deepEqual(await snapshot(f.other), beforeCanonical); assert.deepEqual(await snapshot(f.versions), beforeVersions);
  assert.deepEqual(await fs.readFile(stateFile), beforeState);
  await assert.rejects(fs.access(path.join(f.bData, 'material-sync', `${f.project.id}-pending.json`)));
  assert.equal(await fs.readFile(path.join(staged, '虚构资料.txt'), 'utf8'), '暂存期间发生外部历史增长');
});
