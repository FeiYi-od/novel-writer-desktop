import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { encodeDocx } from '../src/main/docx';
import type { RichNode } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-writer-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.match(relative, /^novel-writer-test-[^\\/]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const local = path.join(root, 'local');
  const a = path.join(root, '小说甲'); const b = path.join(root, '小说乙');
  await Promise.all([fs.mkdir(a), fs.mkdir(b)]);
  const workspace = new Workspace(local); await workspace.initialize();
  return { root, local, a, b, workspace };
}
const prose: RichNode = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '第一章' }] },
  { type: 'paragraph', content: [{ type: 'text', text: '林夏走进教室。', marks: [{ type: 'bold' }] }] },
  { type: 'paragraph', content: [{ type: 'text', text: '窗外正在下雨。' }] }
] };

test('默认创建真实 DOCX，保存并重新打开保留内容和两个全角空格', async t => {
  const { workspace, a } = await fixture(t);
  const book = await workspace.attach(a); const document = await workspace.createChapter(book.id);
  assert.ok(document.path.endsWith('.docx'));
  const saved = await workspace.saveChapter({ projectId: book.id, path: document.path, expectedHash: document.hash, content: prose });
  const buffer = await fs.readFile(path.join(a, document.path));
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const zip = await JSZip.loadAsync(buffer);
  const styles = await zip.file('word/styles.xml')!.async('string');
  assert.match(styles, /w:eastAsia="宋体"/);
  assert.match(styles, /w:sz w:val="21"/);
  const extracted = await mammoth.extractRawText({ buffer });
  assert.match(extracted.value, /\u3000\u3000林夏走进教室/);
  assert.match(extracted.value, /\u3000\u3000窗外正在下雨/);
  assert.deepEqual((await workspace.readChapter(book.id, document.path)).content, saved.content);
});
test('检测外部覆盖并保存本机恢复草稿', async t => {
  const { workspace, a, local } = await fixture(t);
  const book = await workspace.attach(a); const document = await workspace.createChapter(book.id);
  const external = await encodeDocx(prose);
  await fs.writeFile(path.join(a, document.path), external);
  await assert.rejects(workspace.saveChapter({ projectId: book.id, path: document.path, expectedHash: document.hash, content: prose }), /其他程序修改/);
  assert.deepEqual(await fs.readFile(path.join(a, document.path)), external);
  assert.ok((await fs.readdir(path.join(local, 'recovery', book.id))).some(name => name.endsWith('-draft.docx')));
});
test('每书资料独立，拒绝跨书资料写入和路径越界', async t => {
  const { workspace, a, b } = await fixture(t);
  const bookA = await workspace.attach(a); const bookB = await workspace.attach(b);
  const notesA = await workspace.readNotes(bookA.id);
  await workspace.saveNotes(bookA.id, { ...notesA.value, characters: '林夏：胆小' }, notesA.hash);
  assert.equal((await workspace.readNotes(bookB.id)).value.characters, '');
  await assert.rejects(workspace.saveNotes(bookB.id, notesA.value, ''), /另一部小说/);
  await workspace.createChapter(bookB.id);
  await assert.rejects(workspace.readChapter(bookA.id, '../小说乙/1.docx'), /越界/);
  await assert.rejects(workspace.attach(path.join(a, '小说资料')), /嵌套/);
});
test('外部 DOCX 保留原件并只能另存，资料版本冲突被拒绝', async t => {
  const { workspace, a } = await fixture(t);
  const book = await workspace.attach(a);
  await fs.writeFile(path.join(a, '外部.docx'), await encodeDocx(prose));
  const opened = await workspace.readChapter(book.id, '外部.docx');
  assert.equal(opened.managed, false);
  await assert.rejects(workspace.saveChapter({ projectId: book.id, path: opened.path, expectedHash: opened.hash, content: prose }), /外部 DOCX/);
  const notes = await workspace.readNotes(book.id);
  await workspace.saveNotes(book.id, { ...notes.value, world: '甲' }, notes.hash);
  await assert.rejects(workspace.saveNotes(book.id, { ...notes.value, world: '乙' }, notes.hash), /外部修改/);
});
