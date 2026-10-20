import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { RecoveryStore } from '../src/main/recovery';
import { textDocument } from '../src/main/text-import';

const rawDrafts = async (local: string, projectId: string) => {
  const dir = path.join(local, 'recovery', projectId);
  return (await fs.readdir(dir).catch(() => [] as string[])).filter(name => /-draft\.(docx|txt)$/u.test(name)).map(name => path.join(dir, name)).sort();
};
const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text' as const, text }] }] });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-offline-'));
  const local = path.join(root, 'local');
  const workspace = new Workspace(local, path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '书'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const recovery = new RecoveryStore(path.join(local, 'recovery'), workspace);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, local, workspace, project, recovery, book };
}

test('断网演练（本机模拟）：外部改动时拒写、草稿留在恢复区、可取回', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.project.id, textDocument('　　原始正文。'));
  const file = path.join(f.project.root, chapter.path);
  // 模拟"同步客户端把文件改回旧版本"：内容变化，hash 与编辑器手里的不一致
  await fs.writeFile(file, Buffer.from('外部程序写进来的内容', 'utf8'));
  const before = await fs.readFile(file);
  await assert.rejects(
    f.workspace.saveChapter({ projectId: f.project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　作者正在写的新句子。') }),
    /已被其他程序修改|保存期间文件发生变化/u
  );
  assert.deepEqual(await fs.readFile(file), before, '远端文件不能被本地内容覆盖');
  // 草稿必须已经在恢复区（保存前落盘），内容为作者当时写的文字
  const drafts = await rawDrafts(f.local, f.project.id);
  assert.ok(drafts.length >= 1, `应留下本机草稿：${drafts.join(', ')}`);
  assert.ok((await fs.stat(drafts[drafts.length - 1]!)).size > 0, '草稿不能是空文件');
});

test('断网演练（本机模拟）：网络目录消失时给出可读原因，草稿仍在本机', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.project.id, textDocument('　　原始正文。'));
  // 模拟映射盘掉线：整个书目录被移走
  const moved = `${f.book}-offline`;
  await fs.rename(f.book, moved);
  await assert.rejects(
    f.workspace.saveChapter({ projectId: f.project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　断网期间的文字。') }),
    (error: Error) => {
      assert.match(error.message, /恢复区/u, `提示要说明草稿在哪：${error.message}`);
      assert.match(error.message, /网络目录不可用|无法写入/u);
      return true;
    }
  );
  const drafts = await rawDrafts(f.local, f.project.id);
  assert.ok(drafts.length >= 1, '断网时也必须先落草稿');
  await fs.rename(moved, f.book);
  // 恢复目录后可以正常保存（重连）
  const saved = await f.workspace.saveChapter({ projectId: f.project.id, path: chapter.path, expectedHash: chapter.hash, content: doc('　　重连后保存的正文。') });
  assert.match(JSON.stringify(saved.content), /重连后保存的正文/u);
});
