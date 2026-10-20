import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { exportBookZip } from '../src/main/book-export';
import { textDocument } from '../src/main/text-import';

function manifestPreview(text: string) { return (JSON.parse(text) as { materials?: number }).materials ?? 0; }

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-export-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  await workspace.createChapter(project.id, textDocument('　　导出用正文。'));
  // 固定资料目录（世界观/人物设定）也要进导出包
  const current = await workspace.readNotes(project.id);
  await workspace.saveNotes(project.id, { ...current.value, world: '导出也要带上世界观。' }, current.hash);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, project };
}

test('导出整本书：ZIP 内含章节与资料、manifest 记录 SHA-256、目标存在时拒绝覆盖', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, '导出', '书.zip');
  const result = await exportBookZip(f.workspace, f.project.id, target, new Date('2026-10-19T02:00:00Z'));
  assert.equal(result.files >= 2, true, `应导出多个文件：${result.files}`);
  const zip = await JSZip.loadAsync(await fs.readFile(target));
  const names = Object.keys(zip.files);
  assert.ok(names.some(name => name.endsWith('.docx')), '应包含章节 DOCX');
  assert.ok(names.includes('book/小说资料/project.json'), '应包含项目资料');
  assert.ok(names.some(name => name.startsWith('materials/')), '应包含固定资料目录（世界观/人物设定）');
  const noteEntry = manifestPreview(await zip.file('manifest.json')!.async('string'));
  assert.ok(noteEntry > 0, '清单里应记录资料文件数');
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { entries: { path: string; sha256: string }[] };
  assert.equal(manifest.entries.length, result.files);
  for (const entry of manifest.entries) {
    const content = await zip.file(entry.path)!.async('nodebuffer');
    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256, `${entry.path} 的哈希应一致`);
  }
  await assert.rejects(exportBookZip(f.workspace, f.project.id, target), /EEXIST/u, '已存在的目标不能被覆盖');
  // 原书文件不受影响
  assert.ok((await fs.readdir(f.project.root)).some(name => name.endsWith('.docx')));
});
