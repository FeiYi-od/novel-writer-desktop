import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { textDocument } from '../src/main/text-import';

for (const format of ['txt', 'docx'] as const) test(`${format} 草稿暂存期间外部改写不得丢失`, async t => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/save-race-audit-059-'));
  const book = path.join(root, '虚构书'), data = path.join(root, 'data'); await fs.mkdir(book);
  const workspace = new Workspace(data, path.join(data, '创作资料')); await workspace.initialize();
  const project = await workspace.attach(book), chapter = await workspace.createChapter(project.id, textDocument('　　虚构原稿'), format);
  const file = path.join(book, chapter.path), external = Buffer.from('虚构外部最新修改');
  const original = fs.writeFile.bind(fs); let injected = false;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    const [target] = args; await original(...args);
    if (typeof target === 'string' && target.startsWith(`${file}.`) && target.endsWith('.tmp')) {
      await original(file, external); injected = true;
    }
  });
  let rejected = false;
  try { await workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('　　作者本机草稿') }); }
  catch { rejected = true; }
  assert.equal(injected, true, '需准确进入正文的临时文件写入间隙');
  assert.equal(rejected, true, '检测到外部写入必须拒绝保存');
  assert.deepEqual(await fs.readFile(file), external, '外部最新原稿必须保留');
});

for (const format of ['txt', 'docx'] as const) test(`${format} 草稿暂存期间原文件被同字节替换时拒绝覆盖`, async t => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/save-identity-059-'));
  const book = path.join(root, '虚构书'), data = path.join(root, 'data'); await fs.mkdir(book);
  const workspace = new Workspace(data, path.join(data, '创作资料')); await workspace.initialize();
  const project = await workspace.attach(book), chapter = await workspace.createChapter(project.id, textDocument('　　虚构原稿'), format);
  const file = path.join(book, chapter.path), bytes = await fs.readFile(file), prior = file + '.外部保留';
  const original = fs.writeFile.bind(fs); let injected = false;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    const [target] = args; await original(...args);
    if (typeof target === 'string' && target.startsWith(`${file}.`) && target.endsWith('.tmp')) {
      await fs.rename(file, prior); await original(file, bytes); injected = true;
    }
  });
  await assert.rejects(workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('　　本机草稿') }), /身份|变化/u);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(prior), bytes);
});
