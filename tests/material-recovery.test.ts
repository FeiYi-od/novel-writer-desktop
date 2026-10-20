import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-material-recovery-'));
  const original = new Workspace(path.join(root, 'original-local'), path.join(root, 'original-materials'));
  await original.initialize(); const book = path.join(root, 'book'); await fs.mkdir(book);
  const project = await original.attach(book), materials = path.join(root, 'restored-materials');
  const fresh = new Workspace(path.join(root, 'fresh-local'), materials); await fresh.initialize();
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, book, project, fresh, materials };
}

test('资料恢复导入：拒绝来源目录/子目录链接，不把外书资料装入本书', async t => {
  for (const nested of [false, true]) await t.test(nested ? 'nested link' : 'root link', async t => {
    const f = await fixture(t), outside = path.join(f.root, 'other-book'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, '别书原件.txt'), '另一部虚构小说');
    const packaged = path.join(f.book, '资料');
    if (nested) await fs.mkdir(packaged);
    await fs.symlink(outside, nested ? path.join(packaged, '角色原件') : packaged, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.fresh.attach(f.book), /资料|链接|越界/u);
    assert.equal(f.fresh.listProjects().length, 0);
    assert.equal(await fs.readFile(path.join(outside, '别书原件.txt'), 'utf8'), '另一部虚构小说');
  });
});

test('资料恢复导入：新标记验证版本、projectId和本书目录，不吞错误', async t => {
  const f = await fixture(t), marker = path.join(f.book, '小说资料', 'restore-materials.json');
  for (const value of [
    '{broken', JSON.stringify({ schemaVersion: 2, projectId: f.project.id, directory: '资料' }),
    JSON.stringify({ schemaVersion: 1, projectId: 'other', directory: '资料' }),
    JSON.stringify({ schemaVersion: 1, projectId: f.project.id, directory: '../other-book' })
  ]) {
    await fs.writeFile(marker, value);
    await assert.rejects(f.fresh.attach(f.book), /恢复|资料|版本|归属/u);
    assert.equal(await fs.readFile(marker, 'utf8'), value);
    assert.equal(f.fresh.listProjects().length, 0);
  }
});

test('资料恢复导入：目标链接拒绝，已有真实资料不会被覆盖', async t => {
  const f = await fixture(t), packaged = path.join(f.book, '资料'); await fs.mkdir(packaged);
  await fs.writeFile(path.join(packaged, '世界观原件.txt'), '备份中的世界观');
  await fs.mkdir(f.materials); const target = path.join(f.materials, f.project.id), other = path.join(f.root, 'existing'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, '世界观原件.txt'), '正在写的世界观');
  await fs.symlink(other, target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.fresh.attach(f.book), /资料|链接/u);
  await fs.unlink(target); await fs.mkdir(target);
  await fs.writeFile(path.join(target, '世界观原件.txt'), '正在写的世界观');
  await f.fresh.attach(f.book);
  assert.equal(await fs.readFile(path.join(target, '世界观原件.txt'), 'utf8'), '正在写的世界观');
});
