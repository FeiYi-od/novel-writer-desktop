import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describeProgress, summarizeChapters, type ChapterStat } from '../src/core/chapter-stats';
import { Workspace } from '../src/main/workspace';
import { collectChapterStats } from '../src/main/chapter-stats';
import { textDocument } from '../src/main/text-import';

const stat = (name: string, characters: number, daysAgo: number): ChapterStat => ({
  path: `${name}.docx`, characters, paragraphs: Math.max(1, Math.round(characters / 100)),
  updatedAt: new Date(Date.parse('2026-10-19T00:00:00Z') - daysAgo * 86_400_000).toISOString()
});

test('进度统计：总字数段落、长期未动章节、最长与最短', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const summary = summarizeChapters([stat('一', 1200, 0), stat('二', 300, 40), stat('三', 800, 2)], { staleDays: 14, now });
  assert.equal(summary.totalCharacters, 2300);
  assert.equal(summary.chapters.length, 3);
  assert.deepEqual(summary.stale, ['二.docx']);
  assert.equal(summary.longest?.path, '一.docx');
  assert.equal(summary.shortest?.path, '二.docx');
  assert.match(describeProgress(summary), /3 章 · 2300 字/u);
  assert.match(describeProgress(summary), /1 章超过 14 天没动/u);
  assert.equal(describeProgress(summarizeChapters([], { now })), '还没有章节');
  assert.match(describeProgress(summarizeChapters([stat('一', 100, 0)], { now })), /14 天内都动过/u);
});

test('进度统计（真实文件）：按章读取字数，mtime 反映最后修改', async (t: TestContext) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stats-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const first = await workspace.createChapter(project.id, textDocument('　　第一章的正文内容。'));
  await workspace.createChapter(project.id, textDocument('　　第二章也有内容，稍微长一点点。'));
  // 把第一章的 mtime 改到 40 天前，模拟长期没动
  const old = new Date(Date.now() - 40 * 86_400_000);
  await fs.utimes(path.join(project.root, first.path), old, old);
  const summary = await collectChapterStats(workspace, project.id, { staleDays: 14 });
  assert.equal(summary.chapters.length, 2);
  assert.ok(summary.totalCharacters > 0, '应统计出字数');
  assert.ok(summary.stale.includes(first.path), `应判定第一章长期未动：${JSON.stringify(summary.stale)}`);
});
