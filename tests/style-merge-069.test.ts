import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-r2-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '同作者合集');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  let book = await library.read(project.project.id);
  book = await library.addSources(project.project.id, [
    { name: '长篇.txt', text: ('　　长篇叙述，句子较长，描写细密。'.repeat(400)) },
    { name: '短篇.txt', text: ('“短句对白。”他说。'.repeat(20) + '　　短篇正文，节奏快。'.repeat(60)) }
  ], book.hash);
  return { root, workspace, project, library, book };
}

test('参考文本标注：可写入作者与作品，空字符串清除，哈希不符拒绝', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const sourceId = f.book.value.sources[0]!.id;
  const labeled = await f.library.labelStyleSource(f.project.project.id, sourceId, { author: '同一作者', work: '长篇作品' }, f.book.hash);
  const source = labeled.value.sources.find(item => item.id === sourceId)!;
  assert.equal(source.author, '同一作者');
  assert.equal(source.work, '长篇作品');
  await assert.rejects(f.library.labelStyleSource(f.project.project.id, sourceId, { author: 'x' }, f.book.hash), /已更新/u);
  const cleared = await f.library.labelStyleSource(f.project.project.id, sourceId, { author: '' }, labeled.hash);
  assert.equal(cleared.value.sources.find(item => item.id === sourceId)!.author, undefined);
});

test('合并文风：等权与按字数加权得到不同指标，并保留来源与权重', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const [first, second] = f.book.value.sources.map(item => item.id);
  let book = await f.library.analyze(f.project.project.id, '长篇文风', [first!], f.book.hash);
  book = await f.library.analyze(f.project.project.id, '短篇文风', [second!], book.hash);
  const [longStyle, shortStyle] = book.value.styles;
  const equal = await f.library.mergeStyles(f.project.project.id, '作者文风（等权）', [longStyle!.id, shortStyle!.id], 'equal', book.hash);
  const mergedEqual = equal.value.styles.at(-1)!;
  assert.ok(mergedEqual.mergedFrom);
  assert.equal(mergedEqual.mergedFrom!.mode, 'equal');
  assert.deepEqual(mergedEqual.mergedFrom!.styleIds.sort(), [longStyle!.id, shortStyle!.id].sort());
  assert.equal(Math.round((mergedEqual.mergedFrom!.weights[longStyle!.id]! + mergedEqual.mergedFrom!.weights[shortStyle!.id]!) * 1000) / 1000, 1);
  assert.deepEqual([...mergedEqual.sourceIds].sort(), [first!, second!].sort());
  assert.match(mergedEqual.rules, /合并分析（等权，权重：/u);
  const byCharacters = await f.library.mergeStyles(f.project.project.id, '作者文风（按字数）', [longStyle!.id, shortStyle!.id], 'characters', equal.hash);
  const mergedChars = byCharacters.value.styles.at(-1)!;
  assert.equal(mergedChars.mergedFrom!.mode, 'characters');
  assert.ok(mergedChars.mergedFrom!.weights[longStyle!.id]! > mergedChars.mergedFrom!.weights[shortStyle!.id]!, '按字数时长篇权重更高');
  assert.notEqual(mergedChars.metrics.meanParagraphLength, mergedEqual.metrics.meanParagraphLength);
});

test('合并文风：少于两份、重复、不存在、重名都拒绝', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const [first, second] = f.book.value.sources.map(item => item.id);
  const book = await f.library.analyze(f.project.project.id, '唯一文风', [first!, second!], f.book.hash);
  const style = book.value.styles[0]!;
  await assert.rejects(f.library.mergeStyles(f.project.project.id, '合并', [style.id], 'equal', book.hash), /至少|min|2/u as unknown as RegExp);
  await assert.rejects(f.library.mergeStyles(f.project.project.id, '合并', [style.id, style.id], 'equal', book.hash), /重复/u);
  await assert.rejects(f.library.mergeStyles(f.project.project.id, '合并', [style.id, crypto.randomUUID()], 'equal', book.hash), /不存在|已删除/u);
  await assert.rejects(f.library.mergeStyles(f.project.project.id, '唯一文风', [style.id, style.id], 'equal', book.hash), /同名|重复/u);
});

test('合并前对比：返回共同规则与各档案独有规则，目标小说隔离', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const [first, second] = f.book.value.sources.map(item => item.id);
  let book = await f.library.analyze(f.project.project.id, '长篇对比', [first!], f.book.hash);
  book = await f.library.analyze(f.project.project.id, '短篇对比', [second!], book.hash);
  const [longStyle, shortStyle] = book.value.styles;
  const comparison = await f.library.compareStyleArchives(f.project.project.id, [longStyle!.id, shortStyle!.id]);
  assert.ok(Array.isArray(comparison.shared));
  assert.equal(comparison.perStyle.length, 2);
  assert.ok(comparison.ranges.sentenceLength.max >= comparison.ranges.sentenceLength.min);
  const other = await f.workspace.createProject(path.dirname(f.project.root), '别的书');
  await assert.rejects(f.library.compareStyleArchives(other.project.id, [longStyle!.id, shortStyle!.id]), /不存在|已删除/u);
});

test('合并文风权重：规则首行写明百分比，写作提示词带上权重与冲突规则', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const [first, second] = f.book.value.sources.map(item => item.id);
  let book = await f.library.analyze(f.project.project.id, '长篇权重', [first!], f.book.hash);
  book = await f.library.analyze(f.project.project.id, '短篇权重', [second!], book.hash);
  const [longStyle, shortStyle] = book.value.styles;
  const merged = await f.library.mergeStyles(f.project.project.id, '权重文风', [longStyle!.id, shortStyle!.id], 'characters', book.hash);
  const style = merged.value.styles.at(-1)!;
  assert.match(style.rules.split('\n')[0]!, /权重：.*长篇权重 \d+% \/ 短篇权重 \d+%/u);
  const active = { ...merged.value, activeStyleId: style.id };
  const { selectedStylePrompt } = await import('../src/core/style-analysis');
  const prompt = selectedStylePrompt(active, f.project.project.id);
  assert.match(prompt, /合并权重/u);
  assert.match(prompt, /以权重更高的来源为准/u);
  assert.match(prompt, /权重未覆盖的细节以作者本次要求为准/u);
});