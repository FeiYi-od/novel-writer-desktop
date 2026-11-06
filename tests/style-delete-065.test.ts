import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-style-del-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '文风删除书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  return { root, workspace, library, project };
}

test('参考文本删除：未被引用时从书籍资料与磁盘移除', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let book = await f.library.read(f.project.project.id);
  book = await f.library.addSources(f.project.project.id, [{ name: '甲.txt', text: '　　甲文正文。'.repeat(20) }], book.hash);
  assert.equal(book.value.sources.length, 1);
  const sourceId = book.value.sources[0]!.id;
  const result = await f.library.removeSources(f.project.project.id, [sourceId], book.hash);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.names, ['甲.txt']);
  assert.deepEqual(result.snapshot.value.sources, []);
  const files = await fs.readdir(path.join(f.project.root, '小说资料', 'style-sources')).catch(() => [] as string[]);
  assert.equal(files.some(name => name.startsWith(sourceId)), false, '磁盘文件应被删除');
});

test('参考文本删除：仍被文风档案引用时拒绝，并列出档案名', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let book = await f.library.read(f.project.project.id);
  book = await f.library.addSources(f.project.project.id, [{ name: '乙.txt', text: '　　乙文正文。'.repeat(20) }], book.hash);
  const sourceId = book.value.sources[0]!.id;
  const styleId = crypto.randomUUID();
  book = await f.library.save(f.project.project.id, {
    ...book.value,
    styles: [{ id: styleId, name: '乙作者文风', rules: '规则', sourceIds: [sourceId], createdAt: new Date().toISOString(), method: 'local-statistics-v1', metrics: { characters: 100, paragraphs: 2, meanSentenceLength: 10, meanParagraphLength: 50, dialogueRatio: 0, firstPersonPerThousand: 0 } }]
  }, book.hash);
  await assert.rejects(f.library.removeSources(f.project.project.id, [sourceId], book.hash), /仍被文风档案引用：乙作者文风/u);
  assert.equal((await f.library.read(f.project.project.id)).value.sources.length, 1, '拒绝时参考文本必须保留');
});

test('文风档案删除：删除当前启用档案后清空 activeStyleId，参考文本保留', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let book = await f.library.read(f.project.project.id);
  book = await f.library.addSources(f.project.project.id, [{ name: '丙.txt', text: '　　丙文正文。'.repeat(20) }], book.hash);
  const sourceId = book.value.sources[0]!.id;
  const styleId = crypto.randomUUID();
  book = await f.library.save(f.project.project.id, {
    ...book.value,
    styles: [{ id: styleId, name: '丙作者文风', rules: '规则', sourceIds: [sourceId], createdAt: new Date().toISOString(), method: 'local-statistics-v1', metrics: { characters: 100, paragraphs: 2, meanSentenceLength: 10, meanParagraphLength: 50, dialogueRatio: 0, firstPersonPerThousand: 0 } }],
    activeStyleId: styleId
  }, book.hash);
  const result = await f.library.removeStyle(f.project.project.id, styleId, book.hash);
  assert.equal(result.name, '丙作者文风');
  assert.deepEqual(result.snapshot.value.styles, []);
  assert.equal(result.snapshot.value.activeStyleId, '');
  assert.equal(result.snapshot.value.sources.length, 1, '参考文本不能被连带删除');
  await assert.rejects(f.library.removeStyle(f.project.project.id, styleId, result.snapshot.hash), /不存在|已删除/u);
});
