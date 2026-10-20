import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { DocxCopyService } from '../src/main/docx-copy-service';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-docx-copy-safe-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const book = path.join(root, 'book'); await fs.mkdir(book); const project = await workspace.attach(book);
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>第一段。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格。</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  zip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>页眉。</w:t></w:r></w:p></w:hdr>');
  const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await fs.writeFile(path.join(book, '原稿.docx'), original);
  const source = await workspace.readOriginalChapter(project.id, '原稿.docx');
  const service = new DocxCopyService(workspace);
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, book, workspace, project, original, source, service };
}

test('Word副本：所有入口拒绝越界/未知小说，写操作必须提供原件版本', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'outside.docx'), f.original);
  for (const action of [
    () => f.service.insight(f.project.id, '../outside.docx'), () => f.service.images(randomUUID(), '原稿.docx'),
    () => f.service.rewrite(f.project.id, '../outside.docx', ['新段'], f.source.hash),
    () => f.service.rewrite(f.project.id, '原稿.docx', ['新段'], undefined as never),
    () => f.service.edit(f.project.id, '原稿.docx', { kind: 'anything' }, f.source.hash),
    () => f.service.edit(f.project.id, '原稿.docx', { kind: 'header', part: '../../secret', paragraphs: [] }, f.source.hash)
  ]) await assert.rejects(action);
  assert.equal((await fs.readdir(f.book)).filter(name => name.endsWith('.docx')).length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'outside.docx')), f.original);
});

test('Word副本：安全读取、改文字/结构只另存，原稿/表格/页眉保留', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.insight(f.project.id, '原稿.docx')).tables[0].rows, 1);
  assert.deepEqual(await f.service.body(f.project.id, '原稿.docx', f.source.hash), { projectId: f.project.id, path: '原稿.docx', hash: f.source.hash, paragraphs: ['第一段。'] });
  await assert.rejects(f.service.body(f.project.id, '原稿.docx', '0'.repeat(64)), /变化|版本/u);
  const rewrite = await f.service.rewrite(f.project.id, '原稿.docx', ['修改后的段落。'], f.source.hash);
  const edited = await f.service.edit(f.project.id, '原稿.docx', { kind: 'appendRow', tableIndex: 0 }, f.source.hash);
  assert.notEqual(rewrite.path, edited.path);
  const result = await JSZip.loadAsync(await fs.readFile(path.join(f.book, rewrite.path)));
  assert.match(await result.file('word/document.xml')!.async('string'), /修改后的段落/u);
  assert.match(await result.file('word/header1.xml')!.async('string'), /页眉/u);
  assert.deepEqual(await fs.readFile(path.join(f.book, '原稿.docx')), f.original);
});

test('Word副本：变换后发布前来源变化拒绝，不生成混合版本副本', async t => {
  const f = await fixture(t), publish = f.workspace.publishOriginalCopy.bind(f.workspace);
  const changed = Buffer.concat([f.original, Buffer.from('external edit')]);
  f.workspace.publishOriginalCopy = async (...args) => {
    await fs.writeFile(path.join(f.book, '原稿.docx'), changed);
    return publish(...args);
  };
  await assert.rejects(f.service.rewrite(f.project.id, '原稿.docx', ['不能落盘的旧稿'], f.source.hash), /版本|变化/u);
  assert.equal((await fs.readdir(f.book)).filter(name => name.endsWith('.docx')).length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.book, '原稿.docx')), changed);
});

test('Word副本：拒绝损坏/伪造ZIP展开大小，原件不变', async t => {
  const f = await fixture(t);
  const damaged = Buffer.from(f.original), central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0); damaged.writeUInt32LE(1, central + 24);
  await fs.writeFile(path.join(f.book, '伪造.docx'), damaged);
  await assert.rejects(f.service.insight(f.project.id, '伪造.docx'), /DOCX|解压|大小/u);
  assert.deepEqual(await fs.readFile(path.join(f.book, '伪造.docx')), damaged);
});
