import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { BookReplace } from '../src/main/book-replace';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-workspace-safe-'));
  const local = path.join(root, 'local'), workspace = new Workspace(local, path.join(root, 'materials')); await workspace.initialize();
  const book = path.join(root, 'book'); await fs.mkdir(book);
  const project = await workspace.attach(book), chapter = await workspace.createChapter(project.id, textDocument('月钥开启北门。'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, local, book, workspace, project, chapter };
}

test('保存在创建恢复草稿前验证本书ID和来源路径', async t => {
  const f = await fixture(t), recovery = path.join(f.local, 'recovery');
  for (const request of [
    { projectId: '../outside', path: f.chapter.path }, { projectId: randomUUID(), path: f.chapter.path },
    { projectId: f.project.id, path: '../other.docx' }, { projectId: f.project.id, path: '小说资料/非法.docx' }
  ]) await assert.rejects(f.workspace.saveChapter({ ...request, expectedHash: f.chapter.hash, content: textDocument('不应被写入的虚构草稿') }));
  assert.equal(await fs.stat(recovery).then(() => true, () => false), false, '非法请求不能先在恢复区制造文件');
  assert.equal(await fs.stat(path.join(f.local, 'outside')).then(() => true, () => false), false);
});

test('保存不能通过恢复区目录链接写进另一小说', async t => {
  const f = await fixture(t), recovery = path.join(f.local, 'recovery'), outside = path.join(f.root, 'other-book');
  await fs.mkdir(recovery); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(recovery, f.project.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.workspace.saveChapter({ projectId: f.project.id, path: f.chapter.path, expectedHash: f.chapter.hash, content: textDocument('不能串书') }), /链接|目录|恢复/u);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await f.workspace.readChapter(f.project.id, f.chapter.path)).hash, f.chapter.hash);
});

test('整书替换撤销：初次读取后出现外部改动也必须拒绝，不覆盖最新字节', async t => {
  const f = await fixture(t), replace = new BookReplace(f.workspace, path.join(f.root, 'journal'));
  const result = await replace.run({ projectId: f.project.id, query: '月钥', replacement: '银钥' });
  const source = path.join(f.book, f.chapter.path), external = Buffer.concat([await fs.readFile(source), Buffer.from('EXTERNAL_CHANGE')]);
  const read = f.workspace.readChapter.bind(f.workspace); let changed = false;
  f.workspace.readChapter = async (...args) => {
    const value = await read(...args);
    if (!changed && args[1] === f.chapter.path) { changed = true; await fs.writeFile(source, external); }
    return value;
  };
  const undone = await replace.undo(f.project.id, result.batchId!);
  assert.equal(undone.restored.length, 0);
  assert.equal(undone.skipped.length, 1);
  assert.deepEqual(await fs.readFile(source), external);
});
