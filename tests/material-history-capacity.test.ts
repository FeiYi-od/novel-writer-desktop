import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { MaterialSyncService } from '../src/main/material-sync';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/material-history-capacity-045-'));
  const data = path.join(root, 'profile'), materials = path.join(data, '创作资料');
  const book = path.join(root, '虚构星港'); await fs.mkdir(book);
  const workspace = new Workspace(data, materials); await workspace.initialize();
  const project = await workspace.attach(book);
  const service = new MaterialSyncService(workspace, materials, data);
  const local = path.join(materials, '同步历史', project.id);
  const transport = path.join(book, '小说资料/创作资料同步/版本');
  return { root, data, materials, book, workspace, project, service, local, transport };
}

/** No links are followed when checking that advisory reads leave a fixture untouched. */
async function snapshot(root: string) {
  const entries: Record<string, string> = {};
  async function visit(directory: string) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, name), relative = path.relative(root, file), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) entries[relative] = `link:${await fs.readlink(file)}`;
      else if (stat.isDirectory()) { entries[relative] = 'directory'; await visit(file); }
      else { assert.ok(stat.isFile()); entries[relative] = createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
    }
  }
  await visit(root); return entries;
}

const absent = async (file: string) => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const empty = { entries: 0, exact: true, remaining: 1000, level: 'normal' };

test('capacity counts missing roots as empty without creating sync state, canonical data or history directories', async () => {
  const f = await fixture(), before = await snapshot(f.root);
  const value = await f.service.capacity(f.project.id);
  assert.equal(value.schemaVersion, 1); assert.equal(value.projectId, f.project.id);
  assert.equal(value.limit, 1000); assert.equal(value.warningAt, 800);
  assert.ok(!Number.isNaN(Date.parse(value.checkedAt)));
  assert.deepEqual(value.local, empty); assert.deepEqual(value.transport, empty);
  await absent(f.local); await absent(f.transport); await absent(path.join(f.data, 'material-sync'));
  assert.deepEqual(await snapshot(f.root), before);
});

test('capacity does not read state, recover a pending swap, or parse canonical and history payloads', async () => {
  const f = await fixture();
  const sync = path.join(f.data, 'material-sync'); await fs.mkdir(sync, { recursive: true });
  await fs.writeFile(path.join(sync, `${f.project.id}.json`), '{invalid-state');
  await fs.writeFile(path.join(sync, `${f.project.id}-pending.json`), '{invalid-pending-leave-untouched');
  const canonical = path.join(f.materials, f.project.id); await fs.mkdir(canonical, { recursive: true });
  await fs.writeFile(path.join(canonical, '人物卡.md'), Buffer.from([0xff, 0xfe]));
  const local = path.join(f.local, randomUUID()); await fs.mkdir(local, { recursive: true });
  await fs.writeFile(path.join(local, '坏资料.json'), '{not-json');
  const remote = path.join(f.transport, randomUUID()); await fs.mkdir(remote, { recursive: true });
  await fs.writeFile(path.join(remote, 'manifest.json'), '{not-a-manifest');
  const before = await snapshot(f.root), value = await f.service.capacity(f.project.id);
  assert.equal(value.local.entries, 1); assert.equal(value.transport.entries, 1);
  assert.deepEqual(await snapshot(f.root), before);
  await assert.rejects(f.service.history(f.project.id), /清单|版本|损坏/u);
});

test('capacity reports both roots at 799, 800, 999, 1000, and capped 1001 without treating partial folders as verified versions', async () => {
  const f = await fixture(); await fs.mkdir(f.local, { recursive: true }); await fs.mkdir(f.transport, { recursive: true });
  let count = 0;
  for (const [target, level] of [[799, 'normal'], [800, 'warning'], [999, 'warning'], [1000, 'full'], [1001, 'over-limit'], [1002, 'over-limit']] as const) {
    for (; count < target; count++) {
      const id = `00000000-0000-4000-8000-${String(count).padStart(12, '0')}`;
      await fs.mkdir(path.join(f.local, id)); await fs.mkdir(path.join(f.transport, id));
    }
    const value = await f.service.capacity(f.project.id);
    const expected = { entries: Math.min(target, 1001), exact: target <= 1000, remaining: Math.max(0, 1000 - target), level };
    assert.deepEqual(value.local, expected, `local ${target}`); assert.deepEqual(value.transport, expected, `transport ${target}`);
    assert.equal((await fs.readdir(f.local)).length, target); assert.equal((await fs.readdir(f.transport)).length, target);
  }
  await assert.rejects(f.service.history(f.project.id), /1000|容量/u);
  const again = await f.service.capacity(f.project.id);
  assert.equal(again.local.level, 'over-limit'); assert.equal(again.transport.level, 'over-limit');
});

test('capacity counts unknown names and child links as occupied entries without traversing them', async () => {
  const f = await fixture(); await fs.mkdir(f.local, { recursive: true }); await fs.mkdir(f.transport, { recursive: true });
  const outside = path.join(f.root, '不得读取的虚构目录'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'invalid-manifest.json'), '{broken');
  await fs.writeFile(path.join(f.local, '不是版本.txt'), 'Unknown names still occupy a slot.');
  await fs.mkdir(path.join(f.transport, '未完成目录'));
  await fs.symlink(outside, path.join(f.transport, randomUUID()), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await snapshot(f.root), value = await f.service.capacity(f.project.id);
  assert.equal(value.local.entries, 1); assert.equal(value.transport.entries, 2);
  assert.deepEqual(await snapshot(f.root), before);
});

test('capacity isolates two identically named books and rejects unknown or invalid project IDs', async () => {
  const f = await fixture(), otherBook = path.join(f.root, '其他目录/虚构星港'); await fs.mkdir(otherBook, { recursive: true });
  const other = await f.workspace.attach(otherBook);
  await fs.mkdir(path.join(f.local, randomUUID()), { recursive: true });
  await fs.mkdir(path.join(f.transport, randomUUID()), { recursive: true });
  const before = await snapshot(f.root);
  const first = await f.service.capacity(f.project.id), second = await f.service.capacity(other.id);
  assert.notEqual(first.projectId, second.projectId);
  assert.equal(first.local.entries, 1); assert.equal(first.transport.entries, 1);
  assert.deepEqual(second.local, empty); assert.deepEqual(second.transport, empty);
  await assert.rejects(async () => f.service.capacity(randomUUID()));
  await assert.rejects(async () => f.service.capacity('../another-book'));
  assert.deepEqual(await snapshot(f.root), before);
});

test('capacity checks project ownership before reporting counts', async () => {
  const f = await fixture(), projectFile = path.join(f.book, '小说资料/project.json');
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8')); project.id = randomUUID();
  await fs.writeFile(projectFile, JSON.stringify(project)); const before = await snapshot(f.root);
  await assert.rejects(f.service.capacity(f.project.id), /归属|变化/u);
  assert.deepEqual(await snapshot(f.root), before);
});

test('capacity rejects linked parent roots without following or changing their contents', async t => {
  for (const kind of ['local', 'transport', 'materials'] as const) await t.test(kind, async () => {
    const f = await fixture(), outside = path.join(f.root, '虚构外部资料'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, '不可读取.txt'), '保留虚构原件');
    const target = kind === 'local' ? f.local : kind === 'transport' ? f.transport : f.materials;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await snapshot(f.root);
    await assert.rejects(f.service.capacity(f.project.id), /链接|普通目录/u);
    assert.deepEqual(await snapshot(f.root), before);
  });
});

test('capacity discards a result if the book identity changes after its first snapshot', async () => {
  const f = await fixture(), projectFile = path.join(f.book, '小说资料/project.json');
  // A deterministic boundary hook represents an external raw metadata edit after the
  // initial identity snapshot; all calls still use the public project-bound API.
  const internal = f.service as unknown as { historyLocations: (id: string) => Promise<unknown> };
  const original = internal.historyLocations.bind(f.service); let calls = 0;
  internal.historyLocations = async id => {
    const locations = await original(id);
    if (++calls === 1) await fs.appendFile(projectFile, '\n');
    return locations;
  };
  await assert.rejects(f.service.capacity(f.project.id), /归属.*变化|容量.*变化/u);
  assert.equal(calls, 2);
  await absent(path.join(f.data, 'material-sync')); await absent(f.local); await absent(f.transport);
});
