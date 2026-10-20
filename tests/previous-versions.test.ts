import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { listPreviousVersions, prunePreviousVersions, readPreviousVersion, restorePreviousVersion } from '../src/main/recovery';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-previous-'));
  const local = path.join(root, 'local');
  const workspace = new Workspace(local, path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const chapter = await workspace.createChapter(project.id, textDocument('　　第一版正文。'));
  const manuscript = await workspace.readChapter(project.id, chapter.path);
  // 正常保存一次 → 会留下上一版（第一版）
  await workspace.saveChapter({ projectId: project.id, path: manuscript.path, expectedHash: manuscript.hash,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　第二版正文。' }] }] } });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { local, workspace, project, chapter };
}

test('历史版本：保存后能列出上一版、预览其正文、取回为新章节且不覆盖当前原稿', async t => {
  const f = await fixture(t);
  const root = path.join(f.local, 'recovery');
  const versions = await listPreviousVersions(root, f.project.id);
  assert.equal(versions.length, 1, `应有一份历史版本：${versions.map(item => item.fileName).join(',')}`);
  assert.equal(versions[0]!.sourcePath, f.chapter.path, '历史版本应记录来源章节');
  assert.equal(versions[0]!.kind, 'docx');
  const preview = await readPreviousVersion(root, f.project.id, versions[0]!.id);
  assert.match(preview.text, /第一版正文/u, '预览应看到上一版内容');
  const restored = await restorePreviousVersion(root, f.project.id, versions[0]!.id, f.project.root, new Date('2026-10-19T03:00:00Z'));
  assert.match(restored.path, /历史版/u);
  const restoredBytes = await fs.readFile(path.join(f.project.root, restored.path));
  assert.ok(restoredBytes.length > 0);
  // 当前章节仍是第二版，未被历史版本覆盖
  const current = await f.workspace.readChapter(f.project.id, f.chapter.path);
  assert.match(JSON.stringify(current.content), /第二版正文/u);
});

test('历史版本：非法文件名被拒绝，避免路径穿越', async t => {
  const f = await fixture(t);
  const root = path.join(f.local, 'recovery');
  await assert.rejects(readPreviousVersion(root, f.project.id, '../../evil-previous.docx'), /文件名不合法/u);
  await assert.rejects(restorePreviousVersion(root, f.project.id, 'x-previous.docx', f.project.root), /文件名不合法/u);
});

test('历史版本清理：dryRun 不动文件，只有一份时永远保留', async t => {
  const f = await fixture(t);
  const root = path.join(f.local, 'recovery');
  const before = await listPreviousVersions(root, f.project.id);
  const dry = await prunePreviousVersions(root, f.project.id, { keep: 1, olderThanDays: 0, dryRun: true });
  assert.deepEqual(dry, { total: before.length, pruned: 0, kept: before.length, ids: [] });
  assert.equal((await listPreviousVersions(root, f.project.id)).length, before.length, 'dryRun 不能删除文件');
  const real = await prunePreviousVersions(root, f.project.id, { keep: 1, olderThanDays: 0 });
  assert.equal(real.pruned, 0, '最新 1 份必须保留');
  assert.equal(real.kept, before.length);
});