import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';
import { validateDocxForTextExtraction } from '../src/main/docx-copy-service';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-style-docx-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '虚构 DOCX 书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  return { root, project, library, book: await library.read(project.project.id) };
}

function corruptExpandedSize(original: Buffer, declared = 1) {
  const bytes = Buffer.from(original); const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0); let cursor = bytes.readUInt32LE(eocd + 16); const count = bytes.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const len = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    if (bytes.subarray(cursor + 46, cursor + 46 + len).toString('utf8') === 'word/document.xml') { bytes.writeUInt32LE(declared, cursor + 24); return bytes; }
    cursor += 46 + len + extra + comment;
  }
  throw new Error('fixture DOCX entry missing');
}

test('超过 200 万字符的 DOCX 可安全提取，原始字节保持', async t => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const text = '虚构对白与叙事。'.repeat(280000); assert.ok(text.length > 2_000_000);
  const original = await encodeDocx(textDocument(text)); await validateDocxForTextExtraction(original);
  const extracted = (await mammoth.extractRawText({ buffer: original })).value;
  const book = await f.library.addSources(f.project.project.id, [{ name: '长篇.docx', text: extracted, original }], f.book.hash);
  const id = book.value.sources[0]!.id;
  const full = await f.library.analyze(f.project.project.id, 'DOCX全文', [id], book.hash, { mode: 'full' });
  assert.equal(full.value.styles[0]!.metrics.characters, extracted.replace(/\s/g, '').length);
  assert.deepEqual(await fs.readFile(path.join(f.project.root, '小说资料', 'style-sources', id + '.docx')), original);
});

test('DOCX 宣称的解压大小与实际不符时拒绝提取，保存的原字节不修改', async t => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const good = await encodeDocx(textDocument('合成正文。'.repeat(100)));
  const crcDamaged = Buffer.from(good), end = crcDamaged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let cursor = crcDamaged.readUInt32LE(end + 16); const count = crcDamaged.readUInt16LE(end + 10); let changed = false;
  for (let i = 0; i < count; i++) {
    const len = crcDamaged.readUInt16LE(cursor + 28), extra = crcDamaged.readUInt16LE(cursor + 30), comment = crcDamaged.readUInt16LE(cursor + 32);
    if (crcDamaged.subarray(cursor + 46, cursor + 46 + len).toString('utf8') === 'word/document.xml') { crcDamaged.writeUInt32LE((crcDamaged.readUInt32LE(cursor + 16) ^ 1) >>> 0, cursor + 16); changed = true; break; }
    cursor += 46 + len + extra + comment;
  }
  assert.ok(changed); await assert.rejects(validateDocxForTextExtraction(crcDamaged), /内容校验失败/u);
  const oversized = corruptExpandedSize(good, 64 * 1024 * 1024 + 1);
  await assert.rejects(validateDocxForTextExtraction(oversized), /64 MiB/u);
  const original = corruptExpandedSize(good);
  await assert.rejects(validateDocxForTextExtraction(original), /解压失败|实际内容|大小/u);
  const book = await f.library.addSources(f.project.project.id, [{ name: '损坏.docx', text: '合成正文。'.repeat(100), original }], f.book.hash);
  const id = book.value.sources[0]!.id;
  await assert.rejects(f.library.analyze(f.project.project.id, '不应生成', [id], book.hash, { mode: 'full' }), /解压失败|实际内容|大小/u);
  await assert.rejects(f.library.stylePlanPreview(f.project.project.id, [id], book.hash, 20000), /解压失败|实际内容|大小/u);
  assert.deepEqual(await fs.readFile(path.join(f.project.root, '小说资料', 'style-sources', id + '.docx')), original);
  assert.equal((await f.library.read(f.project.project.id)).value.styles.length, 0);
});
