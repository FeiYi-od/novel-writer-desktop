import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { textDocument } from '../src/main/text-import';

test('恢复区根目录不能重定向到另一本书并写入当前书草稿', async () => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/audit-recovery-root-059-'));
  const book = path.join(root, '虚构甲书'), other = path.join(root, '虚构乙书'), data = path.join(root, 'data');
  await fs.mkdir(book); await fs.mkdir(other); const workspace = new Workspace(data); await workspace.initialize();
  const project = await workspace.attach(book), chapter = await workspace.createChapter(project.id, textDocument('　　甲书原稿'));
  await fs.symlink(other, path.join(data, 'recovery'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('　　不能跨书') }), /链接|目录|恢复/u);
  assert.deepEqual(await fs.readdir(other), []);
});

test('保存草稿前恢复根被替换时不得把本书文字写到另一目录', async t => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/audit-recovery-switch-059-'));
  const book = path.join(root, '虚构甲书'), other = path.join(root, '虚构乙书'), data = path.join(root, 'data');
  await fs.mkdir(book); await fs.mkdir(other); const workspace = new Workspace(data); await workspace.initialize();
  const project = await workspace.attach(book), chapter = await workspace.createChapter(project.id, textDocument('　　甲书原稿'));
  await fs.mkdir(path.join(other, project.id));
  const recovery = path.join(data, 'recovery'), realOpen = fs.open.bind(fs), realWrite = fs.writeFile.bind(fs); let injected = false;
  const swap = async (target: unknown) => {
    if (!injected && typeof target === 'string' && target.includes('-draft.docx')) {
      injected = true; await fs.rename(recovery, recovery + '-原位置'); await fs.symlink(other, recovery, process.platform === 'win32' ? 'junction' : 'dir');
    }
  };
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => { await swap(args[0]); return realOpen(...args); });
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => { await swap(args[0]); return realWrite(...args); });
  await assert.rejects(workspace.saveChapter({ projectId: project.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('　　不应泄露到乙书') }), /链接|目录|恢复/u);
  assert.equal(injected, true);
  for (const name of await fs.readdir(path.join(other, project.id))) assert.equal((await fs.stat(path.join(other, project.id, name))).size, 0, '目标目录不应含有本书稿件或元数据');
});
