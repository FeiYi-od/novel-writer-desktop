import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { listRawDrafts, pruneRawDrafts, readRawDraft, restoreRawDraft } from '../src/main/recovery';
import { textDocument } from '../src/main/text-import';

const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text' as const, text }] }] });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-rawdraft-'));
  const local = path.join(root, 'local');
  const workspace = new Workspace(local, path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const chapter = await workspace.createChapter(project.id, textDocument('　　原始正文。'));
  await fs.writeFile(path.join(project.root, chapter.path), Buffer.from('外部写入', 'utf8'));
  // 制造一次失败保存 → 落草稿 + 来源 sidecar
  await assert.rejects(workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　失败时的正文。') }));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, local, project, chapter };
}

test('原始草稿：能列出、带来源、可预览、可取回为新章节（不覆盖原稿）', async t => {
  const f = await fixture(t);
  const drafts = await listRawDrafts(path.join(f.local, 'recovery'), f.project.id);
  assert.equal(drafts.length, 1, `应只有一份失败草稿：${drafts.map(item => item.fileName).join(',')}`);
  assert.equal(drafts[0]!.kind, 'docx');
  assert.equal(drafts[0]!.sourcePath, f.chapter.path, '来源应为出问题的那一章');
  assert.ok(drafts[0]!.bytes > 0);
  const preview = await readRawDraft(path.join(f.local, 'recovery'), f.project.id, drafts[0]!.id);
  assert.match(preview.text, /失败时的正文/u, '预览应能读出当时的文字');
  const restored = await restoreRawDraft(path.join(f.local, 'recovery'), f.project.id, drafts[0]!.id, f.project.root, new Date('2026-10-19T01:00:00Z'));
  assert.match(restored.path, /取回/u);
  const bytes = await fs.readFile(path.join(f.project.root, restored.path));
  assert.ok(bytes.length > 0);
  // 原稿仍是外部内容，没有被覆盖
  const original = await fs.readFile(path.join(f.project.root, f.chapter.path));
  assert.equal(original.toString('utf8'), '外部写入');
});

test('原始草稿：文件名不合法时拒绝，避免路径穿越', async t => {
  const f = await fixture(t);
  await assert.rejects(readRawDraft(path.join(f.local, 'recovery'), f.project.id, '../../evil-draft.docx'), /文件名不合法/u);
  await assert.rejects(restoreRawDraft(path.join(f.local, 'recovery'), f.project.id, 'abc-draft.docx', f.project.root), /文件名不合法/u);
});

test('清理旧备份：dryRun 只报告不动文件，真清理时最新副本一定保留', async t => {
  const f = await fixture(t);
  const root = path.join(f.local, 'recovery');
  const before = await listRawDrafts(root, f.project.id);
  assert.equal(before.length, 1);
  const dry = await pruneRawDrafts(root, f.project.id, { keep: 1, olderThanDays: 0, dryRun: true });
  assert.deepEqual(dry, { total: 1, pruned: 0, kept: 1, ids: [] }, '只有一份时无论多旧都保留');
  assert.equal((await listRawDrafts(root, f.project.id)).length, 1, 'dryRun 不能删除文件');
  const real = await pruneRawDrafts(root, f.project.id, { keep: 1, olderThanDays: 0 });
  assert.equal(real.pruned, 0);
  assert.equal(real.kept, 1);
});