import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-preview-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '导入预览书');
  return { root, workspace, project };
}

test('导入预览：默认目标名避让既有文件并标记重复，跳过项与原导入规则一致', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const docx = new Uint8Array(await encodeDocx(textDocument('　　预览章节。')));
  await fs.writeFile(path.join(f.project.root, '旧稿.txt'), '已存在', 'utf8');
  const plan = await f.workspace.planChapterImport(f.project.project.id, [
    { name: '旧稿.txt', data: Buffer.from('新内容', 'utf8') },
    { name: '第一章.docx', data: docx },
    { name: '笔记.md', data: Buffer.from('x', 'utf8') }
  ]);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items.map(item => item.targetName), ['旧稿-导入-1.txt', '第一章.docx']);
  assert.deepEqual(plan.items.map(item => item.duplicate), [true, false]);
  assert.equal(plan.items[1]!.bytes, docx.length);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0]!.reason, /仅支持/u);
  assert.deepEqual((await f.workspace.chapters(f.project.project.id)).map(item => item.path), ['旧稿.txt'], '预览阶段不能写盘，只能看到既有文件');
});

test('提交导入：按修改后的名字写入、可排除条目，令牌只能用一次', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const docx = new Uint8Array(await encodeDocx(textDocument('　　改名后的章节。')));
  const plan = await f.workspace.planChapterImport(f.project.project.id, [
    { name: '第一章.docx', data: docx },
    { name: '第二章.txt', data: Buffer.from('　　第二章正文。', 'utf8') }
  ]);
  const result = await f.workspace.commitChapterImport(f.project.project.id, plan.token, [
    { id: plan.items[0]!.id, include: true, targetName: '开篇.docx' },
    { id: plan.items[1]!.id, include: false }
  ]);
  assert.deepEqual(result.imported.map(item => item.name), ['开篇.docx']);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(f.project.root, '开篇.docx'))), docx);
  assert.equal(await fs.stat(path.join(f.project.root, '第一章.docx')).then(() => true).catch(() => false), false, '改名后不应留下原文件名');
  await assert.rejects(f.workspace.commitChapterImport(f.project.project.id, plan.token, []), /导入计划已失效/u);
});

test('提交导入：跨书令牌、改成已存在文件名、改扩展名、路径改名都被拦住', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const other = await f.workspace.createProject(path.dirname(f.project.root), '另一本书');
  await fs.writeFile(path.join(f.project.root, '占位.txt'), '保留', 'utf8');
  const plan = await f.workspace.planChapterImport(f.project.project.id, [{ name: '章节.txt', data: Buffer.from('正文', 'utf8') }]);
  await assert.rejects(f.workspace.commitChapterImport(other.project.id, plan.token, [{ id: plan.items[0]!.id, include: true }]), /导入计划已失效/u);
  const second = await f.workspace.planChapterImport(f.project.project.id, [{ name: '章节.txt', data: Buffer.from('正文', 'utf8') }]);
  const result = await f.workspace.commitChapterImport(f.project.project.id, second.token, [
    { id: second.items[0]!.id, include: true, targetName: '占位.txt' },
    { id: second.items[0]!.id, include: true, targetName: '改后缀.docx' }
  ]);
  assert.deepEqual(result.imported, []);
  assert.match(result.skipped.map(item => item.reason).join(' '), /已存在/u);
  assert.match(result.skipped.map(item => item.reason).join(' '), /扩展名/u);
  const third = await f.workspace.planChapterImport(f.project.project.id, [{ name: '章节.txt', data: Buffer.from('正文', 'utf8') }]);
  const escaped = await f.workspace.commitChapterImport(f.project.project.id, third.token, [{ id: third.items[0]!.id, include: true, targetName: '../../逃逸.txt' }]);
  assert.deepEqual(escaped.imported.map(item => item.name), ['逃逸.txt']);
  assert.equal(await fs.stat(path.join(f.root, '逃逸.txt')).then(() => true).catch(() => false), false);
});
