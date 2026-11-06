import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-r2-import-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const source = await workspace.createProject(parent, '来源书');
  const target = await workspace.createProject(parent, '目标书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  let book = await library.read(source.project.id);
  book = await library.addSources(source.project.id, [{ name: '来源样本.txt', text: '　　来源正文，句子适中。'.repeat(200) }], book.hash);
  book = await library.analyze(source.project.id, '来源文风', [book.value.sources[0]!.id], book.hash);
  return { root, workspace, source, target, library, sourceBook: book };
}

test('跨书导入文风：复制来源文件并建立目标书独立记录，源书不变', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const style = f.sourceBook.value.styles[0]!;
  const targetBefore = await f.library.read(f.target.project.id);
  const result = await f.library.importStyleFromBook(f.source.project.id, f.target.project.id, style.id, targetBefore.hash);
  assert.equal(result.copiedSources, 1);
  const targetAfter = result.snapshot;
  assert.equal(targetAfter.value.styles.length, 1);
  assert.equal(targetAfter.value.sources.length, 1);
  assert.equal(targetAfter.value.styles[0]!.rules, style.rules);
  assert.equal(result.styleId, targetAfter.value.styles[0]!.id);
  // 目标书能独立读到复制出的来源内容
  const read = await f.library.readStyleSources(f.target.project.id, targetAfter.value.styles[0]!.sourceIds);
  assert.match(read.texts[0]!.text, /来源正文/u);
  // 源书不变
  const sourceAfter = await f.library.read(f.source.project.id);
  assert.equal(sourceAfter.value.styles.length, 1);
  assert.equal(sourceAfter.value.sources.length, 1);
});

test('跨书导入文风：目标书有同名档案时加「（导入）」，重复导入不重复复制文件', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const style = f.sourceBook.value.styles[0]!;
  let target = await f.library.read(f.target.project.id);
  const first = await f.library.importStyleFromBook(f.source.project.id, f.target.project.id, style.id, target.hash);
  target = first.snapshot;
  assert.equal(target.value.styles[0]!.name, '来源文风');
  const second = await f.library.importStyleFromBook(f.source.project.id, f.target.project.id, style.id, target.hash);
  assert.equal(second.copiedSources, 0, '来源文件已存在时不应重复复制');
  assert.equal(second.snapshot.value.sources.length, 1);
  assert.match(second.snapshot.value.styles[1]!.name, /导入/u);
});

test('跨书导入文风：同书、旧哈希、未知档案都拒绝且不改目标书', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const style = f.sourceBook.value.styles[0]!;
  const target = await f.library.read(f.target.project.id);
  await assert.rejects(f.library.importStyleFromBook(f.source.project.id, f.source.project.id, style.id, target.hash), /另一本小说/u);
  await assert.rejects(f.library.importStyleFromBook(f.source.project.id, f.target.project.id, style.id, 'stale'), /已更新/u);
  await assert.rejects(f.library.importStyleFromBook(f.source.project.id, f.target.project.id, crypto.randomUUID(), target.hash), /不存在|已删除/u);
  assert.equal((await f.library.read(f.target.project.id)).value.styles.length, 0);
});
