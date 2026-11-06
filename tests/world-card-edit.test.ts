import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { WorldInfoStore } from '../src/main/world-info';

async function setup() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/world-card-edit-'));
  const folder = path.join(root, '虚构甲'); await fs.mkdir(folder);
  const workspace = new Workspace(path.join(root, 'data'), path.join(root, 'materials')); await workspace.initialize();
  const project = await workspace.attach(folder), store = new WorldInfoStore(workspace);
  const json = { name: '虚构世界', extensions: { otherPlugin: { nested: true } }, entries: {
    '7': { comment: '虚构港', key: ['海港'], content: '旧正文', selective: true, keysecondary: ['夜晚'], characterFilter: { names: ['某人'], tags: ['某标签'] }, unknown: { nested: [1, 2] } },
    '8': { comment: '其他地点', key: ['高地'], content: '不能变动' }
  } };
  await store.import(project.id, '世界', json);
  return { root, folder, workspace, project, store, json, source: path.join(folder, '小说资料', '世界书', '世界.json') };
}

test('世界卡编辑仅修改目标字段，保留其他条目与未知扩展并备份原始字节', async () => {
  const f = await setup(); const original = await fs.readFile(f.source);
  const snapshot = await f.store.readSnapshot(f.project.id, '世界');
  const result = await f.store.saveEntry({ projectId: f.project.id, book: '世界', entryId: '7', expectedHash: snapshot.hash, comment: '新港', content: '新正文', keys: ['新港', '码头'] });
  const saved = JSON.parse(await fs.readFile(f.source, 'utf8'));
  assert.deepEqual(saved.entries['7'], { ...f.json.entries['7'], comment: '新港', content: '新正文', key: ['新港', '码头'] });
  assert.deepEqual(saved.entries['8'], f.json.entries['8']); assert.deepEqual(saved.extensions, f.json.extensions);
  assert.deepEqual(await fs.readFile(path.join(f.folder, '小说资料', '世界书修改备份', result.backup)), original);
  assert.equal((await f.store.readSnapshot(f.project.id, '世界')).hash, result.hash);
});

test('世界卡编辑遇到外部修改或错误小说时拒绝，保留外部内容', async () => {
  const f = await setup(); const snapshot = await f.store.readSnapshot(f.project.id, '世界');
  const changed = JSON.stringify({ ...f.json, updatedBy: '外部编辑' });
  await fs.writeFile(f.source, changed);
  const request = { projectId: f.project.id, book: '世界', entryId: '7', expectedHash: snapshot.hash, comment: '拟修改', content: '草稿', keys: ['新港'] };
  await assert.rejects(f.store.saveEntry(request), /外部变化/u);
  assert.equal(await fs.readFile(f.source, 'utf8'), changed);
  const otherFolder = path.join(f.root, '虚构乙'); await fs.mkdir(otherFolder); const other = await f.workspace.attach(otherFolder);
  await assert.rejects(f.store.saveEntry({ ...request, projectId: other.id }));
  assert.equal(await fs.readFile(f.source, 'utf8'), changed);
});

test('世界卡编辑前备份被破坏时拒绝提交', async t => {
  const f = await setup(); const original = await fs.readFile(f.source); const snapshot = await f.store.readSnapshot(f.project.id, '世界');
  const backupDir = path.join(f.folder, '小说资料', '世界书修改备份');
  const mutable = fs as unknown as { lstat: (...args: any[]) => Promise<any> }; const lstat = mutable.lstat.bind(fs);
  let sourceReads = 0, injected = false;
  t.mock.method(mutable, 'lstat', async (...args: any[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === f.source && ++sourceReads === 3) {
      const names = await fs.readdir(backupDir); await fs.writeFile(path.join(backupDir, names[0]!), '被修改的备份'); injected = true;
    }
    return lstat(...args);
  });
  await assert.rejects(f.store.saveEntry({ projectId: f.project.id, book: '世界', entryId: '7', expectedHash: snapshot.hash, comment: '新港', content: '新正文', keys: ['新港'] }), /备份已变化/u);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(f.source), original);
});

test('世界书在保存准备期间发生外部改动时拒绝覆盖', async t => {
  const f = await setup(); const snapshot = await f.store.readSnapshot(f.project.id, '世界');
  const mutable = fs as unknown as { lstat: (...args: any[]) => Promise<any> }; const lstat = mutable.lstat.bind(fs);
  let reads = 0, injected = false; const external = JSON.stringify({ ...f.json, externalChange: true });
  t.mock.method(mutable, 'lstat', async (...args: any[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === f.source && ++reads === 3) { await fs.writeFile(f.source, external); injected = true; }
    return lstat(...args);
  });
  await assert.rejects(f.store.saveEntry({ projectId: f.project.id, book: '世界', entryId: '7', expectedHash: snapshot.hash, comment: '新港', content: '新正文', keys: ['新港'] }), /保存期间变化/u);
  assert.equal(injected, true); assert.equal(await fs.readFile(f.source, 'utf8'), external);
});
