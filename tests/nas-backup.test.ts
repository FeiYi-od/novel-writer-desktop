import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { backupBook, restoreBackup, verifyBackup } from '../src/main/nas-backup';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-nasbak-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const target = path.join(root, 'nas', '备份');
  await workspace.createChapter(project.id, textDocument('虚构正文一。'));
  await workspace.createChapter(project.id, textDocument('虚构正文二。'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, workspace, target };
}

test('备份到目标目录：清单带 SHA-256，校验通过，二次备份不覆盖第一次', async t => {
  const f = await fixture(t);
  const first = await backupBook(f.workspace, f.project.id, f.target, new Date('2026-10-18T00:00:00Z'));
  assert.ok(first.files >= 2, `应复制到多个文件，实际 ${first.files}`);
  assert.ok(first.bytes > 0);
  const manifest = JSON.parse(await fs.readFile(path.join(first.folder, 'manifest.json'), 'utf8')) as { entries: { path: string; sha256: string }[] };
  assert.equal(manifest.entries.length, first.files);
  assert.ok(manifest.entries.every(entry => /^[a-f0-9]{64}$/u.test(entry.sha256)));
  assert.deepEqual(await verifyBackup(first.folder), { ok: true, checked: first.files, mismatch: [], missing: [], invalid: [] });
  // 同一时间戳再备份一次：必须换目录，不能覆盖
  const second = await backupBook(f.workspace, f.project.id, f.target, new Date('2026-10-18T00:00:00Z'));
  assert.notEqual(second.folder, first.folder);
  assert.match(second.folder, /-2$/u);
  assert.ok((await fs.stat(first.folder)).isDirectory(), '第一次备份仍在');
});

test('备份校验：文件被改动或删除时明确报告', async t => {
  const f = await fixture(t);
  const backup = await backupBook(f.workspace, f.project.id, f.target, new Date('2026-10-18T01:00:00Z'));
  const victim = path.join(backup.folder, backup.entries[0].path);
  await fs.writeFile(victim, '被篡改', 'utf8');
  const tampered = await verifyBackup(backup.folder);
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.mismatch, [backup.entries[0].path]);
  await fs.rm(victim);
  const missing = await verifyBackup(backup.folder);
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.includes(backup.entries[0].path));
});

test('备份：目标目录不存在时自动创建，书里的隐藏临时文件不会混进清单', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.project.root, 'Thumbs.db'), 'x');
  const backup = await backupBook(f.workspace, f.project.id, path.join(f.target, '深层', '目录'), new Date('2026-10-18T02:00:00Z'));
  assert.ok(backup.entries.every(entry => !entry.path.includes('Thumbs.db')));
  assert.ok((await fs.stat(backup.folder)).isDirectory());
});

test('从备份恢复：恢复到新目录且逐个文件校验，拒绝恢复被篡改的备份', async t => {
  const f = await fixture(t);
  const backup = await backupBook(f.workspace, f.project.id, f.target, new Date('2026-10-18T03:00:00Z'));
  const restoreTarget = path.join(f.root, '恢复到这里');
  const restored = await restoreBackup(backup.folder, restoreTarget, new Date('2026-10-18T04:00:00Z'));
  assert.equal(restored.files, backup.files);
  assert.match(restored.folder, /恢复/u);
  const listing = await fs.readdir(restored.folder, { recursive: true });
  assert.ok(listing.some(name => String(name).endsWith('.docx')), '应恢复出章节文件');
  assert.equal((await verifyBackup(restored.folder)).ok, false, '恢复目录本身不带控制清单，不能当作备份');
  // 篡改备份后拒绝恢复
  const victim = path.join(backup.folder, backup.entries[0]!.path);
  await fs.writeFile(victim, 'tampered', 'utf8');
  await assert.rejects(restoreBackup(backup.folder, restoreTarget), /备份校验失败/u);
});
