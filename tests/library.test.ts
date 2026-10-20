import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { analyzeText, selectedStylePrompt } from '../src/core/style-analysis';

const dialogue = '“你终于来了！”我推开门。\n“当然，我不会错过。”她笑了。\n'.repeat(20);
const narration = '山脉沿着地平线缓缓延伸，暮色笼罩了古老的城墙，远处河流在平原之间曲折穿行，行旅者停下脚步等待最后一班渡船抵达岸边，空气中弥漫着潮湿的泥土与草木气味。'.repeat(20);

test('参考语料形成不同的文风规则，不泄露样本剧情', () => {
  const a = analyzeText(dialogue); const b = analyzeText(narration);
  assert.notEqual(a.rules, b.rules);
  assert.ok(a.metrics.dialogueRatio > b.metrics.dialogueRatio);
  assert.ok(a.metrics.meanParagraphLength < b.metrics.meanParagraphLength);
  assert.doesNotMatch(a.rules, /不会错过/);
  assert.throws(() => analyzeText('短样本'), /至少需要/);
});

test('书架与文风支持重开、冲突保护、小说作用域和分集唯一归属', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-library-test-'));
  t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-library-test-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true }); });
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  const a = path.join(root, '书甲'); const b = path.join(root, '书乙'); await Promise.all([fs.mkdir(a), fs.mkdir(b)]);
  const bookA = await workspace.attach(a); const bookB = await workspace.attach(b);
  const library = new LibraryStore(id => workspace.getProject(id));
  let state = await library.read(bookA.id);
  const cover = await library.addCover(bookA.id, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=', 'base64'));
  state = await library.save(bookA.id, { ...state.value, title: '星雨学园', introduction: '雨天相遇的故事', cover, volumes: [{ id: randomUUID(), title: '第一集', introduction: '初见', cover, chapters: ['第一章.docx'] }] }, state.hash);
  assert.match(state.covers[cover], /^data:image\/png;base64,/);
  await assert.rejects(library.save(bookA.id, state.value, ''), /已更新/);
  assert.equal((await library.read(bookB.id)).value.introduction, '');
  await assert.rejects(library.save(bookB.id, state.value, ''), /另一部小说/);
  await assert.rejects(library.save(bookA.id, { ...state.value, volumes: [...state.value.volumes, { ...state.value.volumes[0], id: randomUUID() }] }, state.hash), /只能属于一个分集/);
  state = await library.addSources(bookA.id, [{ name: '对白.txt', text: dialogue }, { name: '叙述.txt', text: narration }], state.hash);
  state = await library.analyze(bookA.id, '轻快对白', [state.value.sources[0].id], state.hash);
  state = await library.analyze(bookA.id, '沉静叙述', [state.value.sources[1].id], state.hash);
  state = await library.save(bookA.id, { ...state.value, activeStyleId: state.value.styles[1].id }, state.hash);
  const reopened = await new LibraryStore(id => workspace.getProject(id)).read(bookA.id);
  assert.equal(reopened.value.styles.length, 2);
  assert.match(selectedStylePrompt(reopened.value, bookA.id), /沉静叙述/);
  assert.throws(() => selectedStylePrompt(reopened.value, bookB.id), /另一部小说/);
  await assert.rejects(library.analyze(bookB.id, '偷用', [state.value.sources[0].id], ''), /不属于当前小说/);
  assert.equal((await library.read(bookB.id)).value.styles.length, 0);
});
