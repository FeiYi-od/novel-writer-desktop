import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { DocxCopyService } from '../src/main/docx-copy-service';
import { bodyParagraphTexts } from '../src/main/docx-fidelity';

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/docx-format-service-061-'));
  const data = path.join(root, 'profile'), book = path.join(root, '虚构书');
  await fs.mkdir(book); const workspace = new Workspace(data); await workspace.initialize();
  const project = await workspace.attach(book), service = new DocxCopyService(workspace);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t xml:space="preserve">　　第一段</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">　　第二段</w:t></w:r></w:p></w:body></w:document>');
  const bytes = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
  await fs.writeFile(path.join(book, '外部稿.docx'), bytes);
  return { root, book, workspace, project, service, bytes, hash: sha(bytes) };
}

test('排版副本：生成新文件、原稿字节不变、返回可读段数与改动数', async () => {
  const f = await fixture();
  const result = await f.service.formatParagraphs(f.project.id, '外部稿.docx', [
    { index: 0, format: { align: 'center', firstLineChars: 0 } }, { index: 1, format: { lineSpacing: 1.5 } }
  ], f.hash);
  assert.equal(result.changed, 2); assert.equal(result.paragraphs, 2);
  assert.match(result.path, /-排版副本-/u);
  assert.equal(sha(await fs.readFile(path.join(f.book, '外部稿.docx'))), f.hash, '原稿必须逐字节不变');
  const copy = new Uint8Array(await fs.readFile(path.join(f.book, result.path)));
  const xml = await (await JSZip.loadAsync(copy)).file('word/document.xml')!.async('string');
  assert.match(xml, /<w:jc w:val="center"\/>/u);
  assert.deepEqual(bodyParagraphTexts(xml), ['　　第一段', '　　第二段'], '排版不能改文字');
});

test('排版副本：越界段落、非法取值、旧哈希都拒绝且不产生新文件', async () => {
  const f = await fixture();
  await assert.rejects(f.service.formatParagraphs(f.project.id, '外部稿.docx', [{ index: 9, format: { align: 'left' } }], f.hash), /不存在/u);
  await assert.rejects(f.service.formatParagraphs(f.project.id, '外部稿.docx', [{ index: 0, format: { lineSpacing: 9 } }], f.hash));
  await assert.rejects(f.service.formatParagraphs(f.project.id, '外部稿.docx', [{ index: 0, format: { align: 'center' } }], '0'.repeat(64)));
  const names = (await fs.readdir(f.book)).filter(name => name.includes('排版副本'));
  assert.deepEqual(names, [], '失败时不能留下副本');
  assert.equal(sha(await fs.readFile(path.join(f.book, '外部稿.docx'))), f.hash);
});

test('排版副本：没有实际改动时拒绝生成空副本', async () => {
  const f = await fixture();
  await assert.rejects(f.service.formatParagraphs(f.project.id, '外部稿.docx', [{ index: 0, format: {} }], f.hash), /没有改动|1至/u);
});
