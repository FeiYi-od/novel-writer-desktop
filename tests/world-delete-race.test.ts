import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { WorldInfoStore } from '../src/main/world-info';

test('删除前最后一次读取源文件时备份被外部修改，必须保留原件', async t => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/world-delete-race-054-'));
  const folder = path.join(root, '虚构书'); await fs.mkdir(folder);
  const workspace = new Workspace(path.join(root, 'data'), path.join(root, 'materials'));
  await workspace.initialize(); const project = await workspace.attach(folder); const store = new WorldInfoStore(workspace);
  await store.import(project.id, '世界', { name: '世界', entries: { '0': { key: ['星港'], content: '原始虚构设定' } } });
  const selected = (await store.list(project.id))[0]; assert.ok(selected.hash);
  const source = path.join(folder, '小说资料', '世界书', '世界.json');
  const backupDir = path.join(folder, '小说资料', '世界书删除备份');
  const original = await fs.readFile(source); let count = 0, injected = false, backup = '';
  const mutable = fs as unknown as { lstat: (...args: any[]) => Promise<any> };
  const lstat = mutable.lstat.bind(fs);
  t.mock.method(mutable, 'lstat', async (...args: any[]) => {
    if (typeof args[0] === 'string' && path.resolve(args[0]) === source && ++count === 3) {
      const names = await fs.readdir(backupDir); assert.equal(names.length, 1);
      backup = path.join(backupDir, names[0]);
      await fs.writeFile(backup, '外部改变的虚构备份'); injected = true;
    }
    return lstat(...args);
  });
  let error: unknown;
  try { await store.remove(project.id, '世界', selected.hash); } catch (value) { error = value; }
  assert.equal(injected, true, '必须确实进入备份校验之后的最后一次源文件读取');
  assert.ok(error, '备份变化后不得报告删除成功');
  assert.deepEqual(await fs.readFile(source), original, '备份变化时原文件必须保留');
  assert.equal(await fs.readFile(backup, 'utf8'), '外部改变的虚构备份');
});
