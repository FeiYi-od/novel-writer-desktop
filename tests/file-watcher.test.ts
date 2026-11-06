import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChapterWatcher } from '../src/main/file-watcher';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-watch-'));
  const book = path.join(root, '甲');
  await fs.mkdir(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, book };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('文件监听：排除小说资料与 Word 锁文件，同时保留子目录章节', async t => {
  const { book } = await fixture(t);
  const events: string[][] = [];
  let send!: (event: string, name: string | null) => void;
  const watcher = new ChapterWatcher((_id, paths) => events.push(paths), 20, (_folder, listener) => { send = listener; return { close() {} }; });
  t.after(() => watcher.unwatch());
  watcher.watchProject('p1', book);
  for (const filename of ['小说资料/style-sources/sample.txt', '小说资料\\trash\\old.docx', '分卷/小说资料/note.txt', '~$第一章.docx', '分卷\\~$第二章.docx', '分卷/第二章.txt']) send('change', filename);
  await wait(100);
  assert.deepEqual(events, [['分卷/第二章.txt']]);
});

test('文件监听：合并短时间内的多次保存，只报告正文文件', async t => {
  const { book } = await fixture(t);
  const events: { projectId: string; paths: string[] }[] = [];
  const watcher = new ChapterWatcher((projectId, paths) => events.push({ projectId, paths }), 120);
  t.after(() => watcher.unwatch());
  watcher.watchProject('p1', book);
  await fs.writeFile(path.join(book, '第一章.docx'), 'a');
  await fs.writeFile(path.join(book, '第一章.docx'), 'ab');
  await fs.writeFile(path.join(book, '无关.json'), '{}');
  await wait(500);
  assert.equal(events.length, 1, '同一批改动应合并成一次通知');
  assert.equal(events[0].projectId, 'p1');
  assert.ok(events[0].paths.every(name => /\.(docx|txt)$/u.test(name)), '只报告正文文件');
});

test('文件监听：切书后旧订阅的迟到事件被丢弃', async t => {
  const { root, book } = await fixture(t);
  const other = path.join(root, '乙'); await fs.mkdir(other);
  const events: string[] = [];
  const watcher = new ChapterWatcher((projectId, paths) => events.push(`${projectId}:${paths.join(',')}`), 100);
  t.after(() => watcher.unwatch());
  watcher.watchProject('p1', book);
  await fs.writeFile(path.join(book, '第一章.docx'), 'a');
  watcher.watchProject('p2', other); // switch before the debounce fires
  await wait(400);
  assert.equal(events.length, 0, '切换前未完成的通知不得再发给旧书');
  assert.equal(watcher.watchedProject, 'p2');
  await fs.writeFile(path.join(other, '第二章.txt'), 'b');
  await wait(500);
  assert.ok(events.some(item => item.startsWith('p2:')), '新书要能收到自己的变更');
});

test('文件监听：取消订阅后不再回调，重复取消不报错', async t => {
  const { book } = await fixture(t);
  const events: string[] = [];
  const watcher = new ChapterWatcher((_projectId, paths) => events.push(paths.join(',')), 80);
  watcher.watchProject('p1', book);
  watcher.unwatch();
  watcher.unwatch();
  await fs.writeFile(path.join(book, '第三章.docx'), 'c');
  await wait(400);
  assert.deepEqual(events, []);
  assert.equal(watcher.watchedProject, null);
});
