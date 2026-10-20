import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { ChapterPaths } from '../src/main/chapter-paths';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-move-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const paths = new ChapterPaths(id => workspace.getProject(id));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const chapter = await workspace.createChapter(project.id, textDocument('虚构正文，可移动。'));
  return { root, book, workspace, project, paths, chapter };
}

test('章节移动：移动到子目录后文件存在，旧路径仍解析到新位置', async t => {
  const f = await fixture(t);
  const from = path.basename(f.chapter.path);
  const moved = await f.paths.move({ projectId: f.project.id, path: from, expectedHash: f.chapter.hash, folder: '第一卷' });
  assert.equal(moved, path.join('第一卷', from));
  const files = await fs.readdir(path.join(f.book, '第一卷'));
  assert.ok(files.includes(from), '文件必须真的在新目录里');
  assert.equal(await f.paths.resolve(f.project.id, from), moved, '旧路径仍要能解析到新位置（摘要/确认不丢来源）');
  assert.equal(await f.paths.resolve(f.project.id, moved), moved);
});

test('章节移动：越界目录、同名覆盖、资料目录与改动后的原文都被拒绝', async t => {
  const f = await fixture(t);
  const from = path.basename(f.chapter.path);
  await assert.rejects(f.paths.move({ projectId: f.project.id, path: from, expectedHash: f.chapter.hash, folder: '../外面' }), /越界|拒绝/u);
  await assert.rejects(f.paths.move({ projectId: f.project.id, path: from, expectedHash: f.chapter.hash, folder: '小说资料' }), /小说资料/u);
  await fs.mkdir(path.join(f.book, '第二卷'));
  await fs.writeFile(path.join(f.book, '第二卷', from), '占位冲突', 'utf8');
  await assert.rejects(f.paths.move({ projectId: f.project.id, path: from, expectedHash: f.chapter.hash, folder: '第二卷' }), /同名|覆盖/u);
  await fs.writeFile(path.join(f.book, '第二卷', from), '占位冲突', 'utf8');
  await fs.rm(path.join(f.book, '第二卷', from));
  await fs.writeFile(path.join(f.book, from), '被外部改过', 'utf8');
  await assert.rejects(f.paths.move({ projectId: f.project.id, path: from, expectedHash: f.chapter.hash, folder: '第二卷' }), /已被其他程序修改/u);
});

test('章节移动：不允许移动到当前所在目录', async t => {
  const f = await fixture(t);
  const from = path.basename(f.chapter.path);
  await assert.rejects(f.paths.move({ projectId: f.project.id, path: from, expectedHash: f.chapter.hash, folder: '' }), /已经在这个文件夹/u);
});
