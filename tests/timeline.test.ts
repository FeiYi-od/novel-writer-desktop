import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { TimelineStore } from '../src/main/timeline';
import { compareLabels, normalizeEntry, sortTimeline, type TimelineEntry } from '../src/core/timeline';

const entry = (when: string, title: string): TimelineEntry => ({ id: '', when, title, note: '' });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-timeline-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const store = new TimelineStore(workspace);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, project, store };
}

test('时间线：数字按数值比较，同标签保持原顺序', () => {
  assert.ok(compareLabels('第2天', '第10天') < 0);
  assert.equal(compareLabels('第3天', '第3天'), 0);
  const sorted = sortTimeline([entry('第10天', '十'), entry('第2天', '二'), entry('第2天', '二之二'), entry('序章', '零')]);
  assert.deepEqual(sorted.map(item => item.title), ['零', '二', '二之二', '十']);
});

test('时间线：空时间点/空标题/超长内容直接拒绝，不静默截断', () => {
  assert.throws(() => normalizeEntry({ when: '  ', title: 'x' }), /时间点/u);
  assert.throws(() => normalizeEntry({ when: '第1天', title: '' }), /标题/u);
  assert.throws(() => normalizeEntry({ when: '第1天', title: 'x'.repeat(121) }), /过长/u);
  assert.deepEqual(normalizeEntry({ when: ' 第1天 ', title: ' 出发 ' }).when, '第1天');
});

test('时间线：保存后读回排序结果，哈希变化可检出并发修改', async t => {
  const f = await fixture(t);
  const empty = await f.store.read(f.project.id);
  assert.deepEqual(empty.entries, []);
  const saved = await f.store.save(f.project.id, [entry('第10天', '十'), entry('第2天', '二')], empty.hash);
  assert.deepEqual(saved.entries.map(item => item.title), ['二', '十']);
  assert.ok(saved.entries.every(item => /^[0-9a-f-]{36}$/u.test(item.id)), '保存时应补齐稳定 id');
  const reloaded = await f.store.read(f.project.id);
  assert.deepEqual(reloaded.entries.map(item => item.title), ['二', '十']);
  assert.equal(reloaded.hash, saved.hash);
  await assert.rejects(f.store.save(f.project.id, [entry('第1天', '改')], 'deadbeef'), /已被其他窗口修改/u);
  // A successful second save keeps the previous version in history.
  const second = await f.store.save(f.project.id, [entry('第3天', '三'), entry('第2天', '二')], reloaded.hash);
  assert.deepEqual(second.entries.map(item => item.title), ['二', '三']);
  const history = await fs.readdir(path.join(f.project.root, '小说资料', '时间线历史')).catch(() => [] as string[]);
  assert.ok(history.length >= 1, '覆盖保存时应留下历史版本');
});
