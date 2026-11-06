import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-large-style-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '虚构大语料书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  return { root, project, library, book: await library.read(project.project.id) };
}

test('多份参考文本合计超过 400 万字符时可预估、采样与全文统计', async t => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const sources = Array.from({ length: 4 }, (_, i) => ({ name: `虚构${i}.txt`, text: String(i) + '“虚构对白。”故事继续。'.repeat(100000) }));
  const total = sources.reduce((sum, source) => sum + source.text.length, 0); assert.ok(total > 4_000_000 && total < 8_000_000);
  const book = await f.library.addSources(f.project.project.id, sources, f.book.hash);
  const ids = book.value.sources.map(source => source.id);
  const plan = await f.library.stylePlanPreview(f.project.project.id, ids, book.hash, 20000);
  assert.equal(plan.totalCharacters, total);
  const sampled = await f.library.analyze(f.project.project.id, '合并采样', ids, book.hash, { mode: 'sample' });
  assert.ok(sampled.value.styles[0]!.metrics.characters < 24001);
  const full = await f.library.analyze(f.project.project.id, '合并全文', ids, sampled.hash, { mode: 'full', chunkCharacters: 20000 });
  assert.equal(full.value.styles[1]!.metrics.characters, total);
});

test('合计超过 800 万字符拒绝分析并保留已有语料', async t => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const sources = Array.from({ length: 5 }, (_, i) => ({ name: `虚构${i}.txt`, text: String(i) + '虚'.repeat(1_650_000) }));
  const book = await f.library.addSources(f.project.project.id, sources, f.book.hash);
  const ids = book.value.sources.map(source => source.id);
  await assert.rejects(f.library.analyze(f.project.project.id, '超限', ids, book.hash, { mode: 'full' }), /800 万/u);
  await assert.rejects(f.library.stylePlanPreview(f.project.project.id, ids, book.hash, 20000), /800 万/u);
  const after = await f.library.read(f.project.project.id); assert.equal(after.value.sources.length, 5); assert.equal(after.value.styles.length, 0);
});


test('单份大型 TXT 可超过 200 万字符，超 600 万时拒绝且旧资料保留', async t => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const text = '“对话。”叙事继续。'.repeat(300000) + '结尾'; assert.ok(text.length > 2_000_000 && text.length < 6_000_000);
  const book = await f.library.addSources(f.project.project.id, [{ name: '长篇.txt', text }], f.book.hash);
  const ids = [book.value.sources[0]!.id];
  const full = await f.library.analyze(f.project.project.id, '长篇全文', ids, book.hash, { mode: 'full' });
  assert.equal(full.value.styles[0]!.metrics.characters, text.length);
  await assert.rejects(f.library.addSources(f.project.project.id, [{ name: '超长.txt', text: '超'.repeat(6_000_001) }], full.hash), /600 万/u);
  const after = await f.library.read(f.project.project.id); assert.equal(after.value.sources.length, 1); assert.equal(after.value.styles.length, 1);
});
