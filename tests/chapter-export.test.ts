import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { exportChapterText, filterDrafts } from '../src/main/chapter-export';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-chap-export-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const chapter = await workspace.createChapter(project.id, textDocument('　　第一段正文。\n　　第二段正文。'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, project, chapter };
}

test('导出单章：Markdown 带标题、正文段落保留真实段首空格、目标存在时拒绝覆盖', async t => {
  const f = await fixture(t);
  const md = path.join(f.root, '导出', '第一章.md');
  const result = await exportChapterText(f.workspace, f.project.id, f.chapter.path, md);
  assert.equal(result.format, 'md');
  assert.ok(result.characters > 0);
  const text = await fs.readFile(md, 'utf8');
  assert.match(text, /^# /u, 'Markdown 应有标题');
  assert.ok(text.includes('\u3000\u3000'), '段首两个全角空格必须保留');
  await assert.rejects(exportChapterText(f.workspace, f.project.id, f.chapter.path, md), /EEXIST/u, '不能覆盖已有文件');
  const txt = path.join(f.root, '导出', '第一章.txt');
  const plain = await exportChapterText(f.workspace, f.project.id, f.chapter.path, txt);
  assert.equal(plain.format, 'txt');
  assert.ok(!(await fs.readFile(txt, 'utf8')).startsWith('# '), '纯文本不加标题');
});

test('恢复区筛选：按章节名过滤，空关键字返回全部', () => {
  const drafts = [{ sourcePath: '第一章.docx' }, { sourcePath: '第二章.docx' }, { sourcePath: '附录/人物表.docx' }];
  assert.equal(filterDrafts(drafts, '').length, 3);
  assert.deepEqual(filterDrafts(drafts, '第二').map(item => item.sourcePath), ['第二章.docx']);
  assert.deepEqual(filterDrafts(drafts, '人物').map(item => item.sourcePath), ['附录/人物表.docx']);
  assert.equal(filterDrafts(drafts, '不存在').length, 0);
});
