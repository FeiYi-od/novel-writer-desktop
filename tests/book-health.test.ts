import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { inspectBook } from '../src/main/book-health';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-health-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { workspace, project, book };
}

test('体检：正常书没有错误，只有真实问题才报警', async t => {
  const f = await fixture(t);
  await f.workspace.createChapter(f.project.id, textDocument('　　正常正文。'));
  const report = await inspectBook(f.workspace, f.project.id);
  assert.equal(report.ok, true, `不应有错误：${JSON.stringify(report.issues)}`);
  assert.ok(report.checked >= 1);
});

test('体检：外部改动过的 DOCX 报"没有保存记录"，0 字节文件报错误，缺 project.json 报错误', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.project.id, textDocument('　　原始正文。'));
  // 外部软件改过：内容变了，就没有对应的保存状态
  await fs.writeFile(path.join(f.project.root, chapter.path), Buffer.from('外部写入', 'utf8'));
  const changed = await inspectBook(f.workspace, f.project.id);
  const codes = changed.issues.map(issue => issue.code);
  assert.ok(codes.includes('no-managed-state'), `应提示缺少保存记录：${codes.join(',')}`);

  // 0 字节文件
  const empty = path.join(f.project.root, '空章节.docx');
  await fs.writeFile(empty, Buffer.alloc(0));
  const withEmpty = await inspectBook(f.workspace, f.project.id);
  assert.ok(withEmpty.issues.some(issue => issue.code === 'chapter-empty'), '0 字节文件应报错');
  assert.equal(withEmpty.ok, false, '出现错误级问题时 ok 必须为 false');

  // project.json 坏掉
  await fs.writeFile(path.join(f.project.root, '小说资料', 'project.json'), '{坏掉的 json', 'utf8');
  const broken = await inspectBook(f.workspace, f.project.id);
  assert.ok(broken.issues.some(issue => issue.code === 'project-corrupt'), 'project.json 解析失败应报错');
});

test('体检：只读，不修也不移动任何文件', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.project.id, textDocument('　　只读体检。'));
  const file = path.join(f.project.root, chapter.path);
  const before = await fs.readFile(file);
  await inspectBook(f.workspace, f.project.id);
  assert.deepEqual(await fs.readFile(file), before, '体检不能改动正文');
  const listing = await fs.readdir(f.project.root);
  assert.ok(listing.includes('小说资料'), '目录结构保持原样');
});
