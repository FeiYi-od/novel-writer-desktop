import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-create-'));
  const local = path.join(root, 'local'), materials = path.join(root, 'materials'), parent = path.join(root, '我的小说');
  await fs.mkdir(parent);
  const workspace = new Workspace(local, materials); await workspace.initialize();
  return { root, local, materials, parent, workspace };
}

test('应用内新建小说：建目录、进书架、名字正确，可选首章', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const created = await f.workspace.createProject(f.parent, '海上城邦', { firstChapter: true });
  assert.equal(created.project.name, '海上城邦');
  assert.equal(created.root, path.join(await fs.realpath(f.parent), '海上城邦'));
  assert.ok((await fs.stat(path.join(created.root, '小说资料', 'project.json'))).isFile());
  assert.equal((await f.workspace.listProjects()).some(item => item.id === created.project.id), true);
  assert.ok(created.chapter && created.chapter.path.endsWith('.docx'), '首章应为 DOCX');
  assert.deepEqual((await f.workspace.chapters(created.project.id)).map(item => item.path), [created.chapter!.path]);
});

test('应用内新建小说：同名目录、非法书名、保留名、缺失父目录都拒绝且不留垃圾', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.workspace.createProject(f.parent, '重名书');
  await assert.rejects(f.workspace.createProject(f.parent, '重名书'), /同名文件夹已存在/u);
  await assert.rejects(f.workspace.createProject(f.parent, '   '), /书名不能为空/u);
  await assert.rejects(f.workspace.createProject(f.parent, 'CON'), /系统保留名称/u);
  await assert.rejects(f.workspace.createProject(f.parent, 'a'.repeat(61)), /书名过长/u);
  await assert.rejects(f.workspace.createProject(path.join(f.root, '不存在'), '书'), /父目录不存在/u);
  const entries = (await fs.readdir(f.parent)).sort();
  assert.deepEqual(entries, ['重名书'], '失败时不能留下半个目录');
});

test('导入章节：DOCX/TXT 按原字节复制，重名自动加后缀，绝不覆盖既有文件', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const project = await f.workspace.createProject(f.parent, '导入书');
  const docx = new Uint8Array(await encodeDocx(textDocument('　　导入的第一章。')));
  const txt = Buffer.from('　　导入的 TXT 章节。\n', 'utf8');
  // 预置同名文件：导入必须另起名字，不能覆盖
  const existing = Buffer.from('原稿必须保留', 'utf8');
  await fs.writeFile(path.join(project.root, '旧稿.txt'), existing);
  const result = await f.workspace.importChapters(project.project.id, [
    { name: '第一章.docx', data: docx },
    { name: '旧稿.txt', data: txt },
    { name: '第一章.docx', data: docx }
  ]);
  assert.equal(result.imported.length, 3, JSON.stringify(result));
  assert.deepEqual(result.imported.map(item => item.name).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')), ['第一章-导入-1.docx', '第一章.docx', '旧稿-导入-1.txt']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(await fs.readFile(path.join(project.root, '旧稿.txt')), existing, '既有文件不能被覆盖');
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(project.root, '第一章.docx'))), docx, 'DOCX 必须逐字节相同');
  assert.deepEqual(await fs.readFile(path.join(project.root, '旧稿-导入-1.txt')), txt);
  const listed = (await f.workspace.chapters(project.project.id)).map(item => item.path);
  for (const item of result.imported) assert.ok(listed.includes(item.path), `章节列表应包含 ${item.path}`);
});

test('导入章节：非 UTF-8 TXT、错误扩展名、伪 DOCX、空文件都跳过并说明原因', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const project = await f.workspace.createProject(f.parent, '坏文件书');
  const result = await f.workspace.importChapters(project.project.id, [
    { name: '旧编码.txt', data: new Uint8Array([0xff, 0xfe, 0x41, 0x00]) },
    { name: '笔记.md', data: Buffer.from('不是章节', 'utf8') },
    { name: '假的.docx', data: Buffer.from('PK? no', 'utf8') },
    { name: '空.txt', data: new Uint8Array() }
  ]);
  assert.deepEqual(result.imported, []);
  assert.equal(result.skipped.length, 4);
  assert.match(result.skipped.map(item => item.reason).join(' '), /UTF-8/u);
  assert.match(result.skipped.map(item => item.reason).join(' '), /仅支持 DOCX 或 TXT/u);
  assert.match(result.skipped.map(item => item.reason).join(' '), /ZIP 文件头/u);
  assert.match(result.skipped.map(item => item.reason).join(' '), /文件为空/u);
  assert.deepEqual((await f.workspace.chapters(project.project.id)), [], '失败导入不能产生章节');
});

test('导入章节：文件名里的路径不会越界，书目目录保持不变', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const project = await f.workspace.createProject(f.parent, '路径书');
  const result = await f.workspace.importChapters(project.project.id, [{ name: '../../逃逸.txt', data: Buffer.from('正文', 'utf8') }]);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]!.path, '逃逸.txt');
  assert.equal(await fs.stat(path.join(f.root, '逃逸.txt')).then(() => true).catch(() => false), false, '不能写到小说目录之外');
  assert.ok((await fs.stat(path.join(project.root, '逃逸.txt'))).isFile());
});
