import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listRawDrafts, listPreviousVersions, readRawDraft, readPreviousVersion, restoreRawDraft, restorePreviousVersion, pruneRawDrafts, prunePreviousVersions } from '../src/main/recovery';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-recovery-safe-'));
  const recovery = path.join(root, 'recovery'), book = path.join(root, 'book'), projectId = randomUUID();
  await fs.mkdir(path.join(recovery, projectId), { recursive: true }); await fs.mkdir(book);
  const id = `1792000000000-${randomUUID()}-draft.txt`, previous = id.replace('-draft.txt', '-previous.txt');
  for (const name of [id, previous]) await fs.writeFile(path.join(recovery, projectId, name), '虚构的本书备份。');
  // The verified fixture root is the sole recursively removed directory.
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, recovery, book, projectId, id, previous };
}

test('原始/历史恢复：所有入口拒绝非UUID小说路径，不读取其他目录', async t => {
  const f = await fixture(t), invalid = '../outside';
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, f.id), '其他目录的虚构文件');
  for (const [label, action] of Object.entries({
    rawList: () => listRawDrafts(f.recovery, invalid), previousList: () => listPreviousVersions(f.recovery, invalid),
    rawRead: () => readRawDraft(f.recovery, invalid, f.id), previousRead: () => readPreviousVersion(f.recovery, invalid, f.previous),
    rawRestore: () => restoreRawDraft(f.recovery, invalid, f.id, f.book), previousRestore: () => restorePreviousVersion(f.recovery, invalid, f.previous, f.book),
    rawPrune: () => pruneRawDrafts(f.recovery, invalid), previousPrune: () => prunePreviousVersions(f.recovery, invalid)
  })) await t.test(label, async () => { await assert.rejects(action); });
  assert.equal(await fs.readFile(path.join(outside, f.id), 'utf8'), '其他目录的虚构文件');
});

test('原始/历史恢复：目录链接不能把读、取回或清理指向其他小说', async t => {
  const f = await fixture(t), linkedId = randomUUID();
  await fs.symlink(path.join(f.recovery, f.projectId), path.join(f.recovery, linkedId), process.platform === 'win32' ? 'junction' : 'dir');
  for (const action of [
    () => listRawDrafts(f.recovery, linkedId), () => readRawDraft(f.recovery, linkedId, f.id),
    () => restoreRawDraft(f.recovery, linkedId, f.id, f.book), () => pruneRawDrafts(f.recovery, linkedId),
    () => listPreviousVersions(f.recovery, linkedId), () => readPreviousVersion(f.recovery, linkedId, f.previous),
    () => restorePreviousVersion(f.recovery, linkedId, f.previous, f.book), () => prunePreviousVersions(f.recovery, linkedId)
  ]) await assert.rejects(action, /链接|目录|越界/u);
  assert.equal((await fs.readdir(f.book)).length, 0);
  assert.equal(await fs.readFile(path.join(f.recovery, f.projectId, f.id), 'utf8'), '虚构的本书备份。');
});

test('原始恢复：未知sidecar版本/损坏/目录类型保留拒绝，不能按缺少来源吞掉', async t => {
  const f = await fixture(t), meta = path.join(f.recovery, f.projectId, f.id.replace('-draft.txt', '-draft.meta.json'));
  for (const value of ['{broken', JSON.stringify({ schemaVersion: 999, sourcePath: '一章.txt' }), JSON.stringify({ sourcePath: 42 })]) {
    await fs.writeFile(meta, value);
    await assert.rejects(listRawDrafts(f.recovery, f.projectId), /来源|备份|格式|版本/u);
    await assert.rejects(restoreRawDraft(f.recovery, f.projectId, f.id, f.book), /来源|备份|格式|版本/u);
    assert.equal(await fs.readFile(meta, 'utf8'), value);
  }
  await fs.unlink(meta); await fs.mkdir(meta);
  await assert.rejects(restoreRawDraft(f.recovery, f.projectId, f.id, f.book), /来源|备份|类型/u);
  assert.deepEqual(await fs.readdir(f.book), []);
});

test('恢复预览有文件大小边界，非法清理选项不得写盘', async t => {
  const f = await fixture(t), file = path.join(f.recovery, f.projectId, f.id);
  await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  await assert.rejects(readRawDraft(f.recovery, f.projectId, f.id), /过大|大小|8/u);
  for (const options of [{ keep: NaN }, { keep: -1 }, { keep: 1.2 }, { olderThanDays: -1 }, { olderThanDays: Infinity }, { dryRun: 'false' }])
    await assert.rejects(pruneRawDrafts(f.recovery, f.projectId, options as never));
  assert.equal((await fs.stat(file)).size, 8 * 1024 * 1024 + 1);
});

test('旧无sidecar备份仍可预览/取回，新文件字节不变且原件保留', async t => {
  const f = await fixture(t);
  const preview = await readRawDraft(f.recovery, f.projectId, f.id);
  assert.match(preview.text, /虚构的本书备份/u);
  const restored = await restoreRawDraft(f.recovery, f.projectId, f.id, f.book);
  assert.equal(path.dirname(restored.path), '.');
  assert.equal(await fs.readFile(path.join(f.book, restored.path), 'utf8'), '虚构的本书备份。');
  assert.equal(await fs.readFile(path.join(f.recovery, f.projectId, f.id), 'utf8'), '虚构的本书备份。');
  assert.deepEqual(await listRawDrafts(path.join(f.root, 'missing'), f.projectId), []);
});
