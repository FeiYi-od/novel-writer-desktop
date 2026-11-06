import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-style-full-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '全文文风书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  let book = await library.read(project.project.id);
  const long = Array.from({ length: 1200 }, (_, index) => index % 3 === 0 ? `“第${index}句对白。”他说。` : `第${index}段叙述，用来撑长文本并保持句式变化，包含补充说明与细节。`).join('\n');
  book = await library.addSources(project.project.id, [{ name: '长篇.txt', text: long }], book.hash);
  return { root, project, library, book, long };
}

test('文风分析：全文模式记录覆盖范围，指标覆盖整本而非开头抽样', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const style = await f.library.analyze(f.project.project.id, '全文档案', [f.book.value.sources[0]!.id], f.book.hash, { mode: 'full', chunkCharacters: 3000 });
  const saved = style.value.styles[0]!;
  assert.equal(saved.coverage?.mode, 'full');
  assert.ok((saved.coverage?.chunks ?? 0) > 1, '应切分成多块');
  assert.ok((saved.coverage?.characters ?? 0) > 10000, `覆盖字符应超过一万，实际 ${saved.coverage?.characters}`);
  assert.ok(saved.metrics.characters >= 10000);
  assert.ok((saved.coverage?.dialogueRatio.max ?? 0) > (saved.coverage?.dialogueRatio.min ?? 0), '不同区块应有可观察差异');
});

test('文风分析：默认采样模式仍可用，并标记为 sample', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const style = await f.library.analyze(f.project.project.id, '采样档案', [f.book.value.sources[0]!.id], f.book.hash);
  const saved = style.value.styles[0]!;
  assert.equal(saved.coverage?.mode, 'sample');
  assert.equal(saved.coverage?.chunks, 1);
  assert.ok(saved.metrics.characters > 0);
});


test('本地快速模式对每份长语料分散取样，全文模式统计所有非空白字符', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const second = '第二本起始。'.repeat(1500) + '末尾。';
  const added = await f.library.addSources(f.project.project.id, [{ name: '另一本.txt', text: second }], f.book.hash);
  const ids = added.value.sources.map(source => source.id);
  const sampled = await f.library.analyze(f.project.project.id, '两本采样', ids, added.hash, { mode: 'sample' });
  const first = sampled.value.styles[0]!;
  assert.equal(first.coverage?.mode, 'sample');
  assert.ok(first.metrics.characters < 12000, '两份语料各采样约 6000 字符');
  const full = await f.library.analyze(f.project.project.id, '两本全文', ids, sampled.hash, { mode: 'full', chunkCharacters: 2000 });
  assert.equal(full.value.styles[1]?.metrics.characters, (f.long + second).replace(/\s/g, '').length);
  assert.ok((full.value.styles[1]?.metrics.characters ?? 0) > first.metrics.characters);
});
