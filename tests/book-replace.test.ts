import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { BookReplace } from '../src/main/book-replace';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-replace-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const service = new BookReplace(workspace, path.join(root, 'userdata'));
  const first = await workspace.createChapter(project.id, textDocument('月钥开启北门。'));
  const second = await workspace.createChapter(project.id, textDocument('雨声里，月钥发亮。'));
  return { root, book, workspace, project, service, first, second };
}

test('整书替换：按章节统计替换次数并真正写回', async t => {
  const f = await fixture(t);
  const outcome = await f.service.run({ projectId: f.project.id, query: '月钥', replacement: '银钥' });
  assert.equal(outcome.total, 2);
  assert.equal(outcome.replacedFiles, 2);
  assert.deepEqual(outcome.chapters.map(item => item.status).sort(), ['replaced', 'replaced']);
  const reloaded = await f.workspace.readChapter(f.project.id, f.first.path);
  assert.match(JSON.stringify(reloaded.content), /银钥开启北门/u);
});

test('整书替换：期间被外部改动的章节跳过并说明原因，不覆盖', async t => {
  const f = await fixture(t);
  const original = await f.workspace.readChapter(f.project.id, f.second.path);
  // Simulate another program touching the file: change bytes on disk after the service read it.
  const absolute = path.join(f.book, f.second.path);
  const before = await fs.readFile(absolute);
  await fs.writeFile(absolute, Buffer.concat([before, Buffer.from(' ')]));
  const outcome = await f.service.run({ projectId: f.project.id, query: '月钥', replacement: '银钥', paths: [f.second.path] });
  assert.equal(outcome.total, 0);
  assert.equal(outcome.chapters[0].status, 'skipped');
  assert.match(String(outcome.chapters[0].message), /冲突|跳过/u);
  const after = await fs.readFile(absolute);
  assert.deepEqual(after, Buffer.concat([before, Buffer.from(' ')]), '外部改动后的文件必须原样保留');
  assert.ok(original.hash);
});

test('整书替换：可撤销——恢复替换前字节；替换后又被改过的章节跳过', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.book, f.first.path));
  const outcome = await f.service.run({ projectId: f.project.id, query: '月钥', replacement: '银钥' });
  assert.ok(outcome.batchId, '执行成功应返回批次号');
  const undone = await f.service.undo(f.project.id, outcome.batchId!);
  assert.deepEqual(undone.restored.sort(), [f.first.path, f.second.path].sort());
  assert.deepEqual(await fs.readFile(path.join(f.book, f.first.path)), before, '撤销后字节必须与替换前一致');

  const again = await f.service.run({ projectId: f.project.id, query: '月钥', replacement: '银钥' });
  const edited = await f.workspace.readChapter(f.project.id, f.second.path);
  await f.workspace.saveChapter({ projectId: f.project.id, path: f.second.path, expectedHash: edited.hash, content: textDocument('替换之后又被改了一版。') });
  const partial = await f.service.undo(f.project.id, again.batchId!);
  assert.deepEqual(partial.restored, [f.first.path]);
  assert.equal(partial.skipped[0].path, f.second.path);
  assert.match(partial.skipped[0].reason, /又被修改过/u);
});

test('整书替换：预览（dryRun）不写盘、不产生批次', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.book, f.first.path));
  const preview = await f.service.run({ projectId: f.project.id, query: '月钥', replacement: '银钥', dryRun: true });
  assert.equal(preview.total, 2);
  assert.equal(preview.batchId, undefined);
  assert.deepEqual(await fs.readFile(path.join(f.book, f.first.path)), before, '预览不得修改文件');
});

test('整书替换：无命中不改文件，TXT 章节同样按段落结构替换', async t => {
  const f = await fixture(t);
  const none = await f.service.run({ projectId: f.project.id, query: '不存在的词', replacement: 'x' });
  assert.equal(none.total, 0);
  assert.ok(none.chapters.every(item => item.status === 'unchanged'));
  const txt = await f.workspace.createChapter(f.project.id, textDocument('纯文本章节'), 'txt');
  const outcome = await f.service.run({ projectId: f.project.id, query: '纯文本', replacement: '改写', paths: [txt.path] });
  assert.equal(outcome.chapters[0].status, 'replaced');
  assert.equal(outcome.total, 1);
  const reloaded = await f.workspace.readChapter(f.project.id, txt.path);
  assert.match(JSON.stringify(reloaded.content), /改写章节/u);
});
