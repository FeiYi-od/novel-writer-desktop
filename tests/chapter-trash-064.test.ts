import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-trash-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '回收站书');
  const chapter = await workspace.createChapter(project.project.id, undefined, 'docx');
  return { root, workspace, project, chapter };
}

test('删除章节：移到回收站，章节列表消失、原文件不在原位、内容哈希不变', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const before = await fs.readFile(path.join(f.project.root, f.chapter.path));
  const record = await f.workspace.deleteChapter({ projectId: f.project.project.id, path: f.chapter.path, expectedHash: f.chapter.hash });
  assert.equal(await fs.stat(path.join(f.project.root, f.chapter.path)).then(() => true).catch(() => false), false, '原位文件应已移走');
  assert.deepEqual(await fs.readdir(path.join(f.project.root, '小说资料', 'trash', 'chapters', record.id)), [record.name]);
  const trashed = await f.workspace.trashedChapters(f.project.project.id);
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0]!.originalPath, f.chapter.path.split(path.sep).join('/'));
  assert.deepEqual((await f.workspace.chapters(f.project.project.id)).map(item => item.path), [], '回收站内容不能出现在章节列表');
  const restored = await f.workspace.restoreTrashedChapter({ projectId: f.project.project.id, id: record.id });
  assert.equal(restored.path, f.chapter.path);
  assert.deepEqual(await fs.readFile(path.join(f.project.root, f.chapter.path)), before, '恢复后内容必须一致');
  assert.deepEqual(await f.workspace.trashedChapters(f.project.project.id), []);
});

test('删除章节：哈希不符、路径不存在、其它书的路径都拒绝且不动原文件', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await assert.rejects(f.workspace.deleteChapter({ projectId: f.project.project.id, path: f.chapter.path, expectedHash: 'deadbeef' }), /已变化/u);
  await assert.rejects(f.workspace.deleteChapter({ projectId: f.project.project.id, path: '不存在.docx', expectedHash: f.chapter.hash }), /不存在|EPERM|ENOENT/u);
  const other = await f.workspace.createProject(path.dirname(f.project.root), '另一本');
  await assert.rejects(f.workspace.deleteChapter({ projectId: other.project.id, path: f.chapter.path, expectedHash: f.chapter.hash }), /不存在|越界|ENOENT/u);
  assert.ok((await fs.stat(path.join(f.project.root, f.chapter.path))).isFile(), '拒绝时原文件必须保留');
});

test('恢复章节：原路径被占用时另存「-恢复-N」，绝不覆盖新文件', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const record = await f.workspace.deleteChapter({ projectId: f.project.project.id, path: f.chapter.path, expectedHash: f.chapter.hash });
  await fs.writeFile(path.join(f.project.root, f.chapter.path), '新的同路径文件', 'utf8');
  const restored = await f.workspace.restoreTrashedChapter({ projectId: f.project.project.id, id: record.id });
  assert.equal(restored.path, f.chapter.path.replace(/\.docx$/u, '-恢复-1.docx'));
  assert.equal(await fs.readFile(path.join(f.project.root, f.chapter.path), 'utf8'), '新的同路径文件');
  assert.ok((await fs.stat(path.join(f.project.root, restored.path))).isFile());
  await assert.rejects(f.workspace.restoreTrashedChapter({ projectId: f.project.project.id, id: record.id }), /没有这个章节|已恢复/u);
});
