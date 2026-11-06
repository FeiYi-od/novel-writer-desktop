import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { ChapterDisplayNames } from '../src/main/chapter-display-names';

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.artifacts/chapter-display-'));
  const folder = path.join(root, '虚构甲'), folderB = path.join(root, '虚构乙'); await fs.mkdir(folder); await fs.mkdir(folderB);
  const original = '这是仅用于测试的虚构章节。';
  await fs.writeFile(path.join(folder, '第一章.txt'), original); await fs.writeFile(path.join(folderB, '第一章.txt'), '另一小说正文');
  const workspace = new Workspace(path.join(root, 'profile'), path.join(root, 'materials')); await workspace.initialize();
  const a = await workspace.attach(folder), b = await workspace.attach(folderB), store = new ChapterDisplayNames(path.join(root, 'profile'), workspace);
  return { root, folder, folderB, workspace, a, b, store, original };
}

test('显示名仅保存本机元数据、按小说隔离，跟随应用内文件改名并可恢复文件名', async () => {
  const f = await fixture(), id = f.a.id, manuscript = await f.workspace.readChapter(id, '第一章.txt');
  const start = await f.store.read(id); assert.equal(start.hash, '');
  const renamed = await f.store.set({ projectId: id, path: manuscript.path, expectedChapterHash: manuscript.hash, expectedNamesHash: start.hash, name: '序章：星光' });
  assert.deepEqual(renamed.entries, [{ path: '第一章.txt', name: '序章：星光' }]);
  assert.equal(await fs.readFile(path.join(f.folder, '第一章.txt'), 'utf8'), f.original);
  assert.deepEqual((await f.store.read(f.b.id)).entries, []);
  await assert.rejects(f.store.set({ projectId: id, path: manuscript.path, expectedChapterHash: manuscript.hash, expectedNamesHash: start.hash, name: '旧窗口' }), /显示名已变化/u);
  const moved = await f.workspace.renameChapter({ projectId: id, path: manuscript.path, expectedHash: manuscript.hash, name: '新文件名' });
  const afterMove = await f.store.read(id); assert.deepEqual(afterMove.entries, [{ path: moved.path, name: '序章：星光' }]);
  const cleared = await f.store.set({ projectId: id, path: moved.path, expectedChapterHash: moved.hash, expectedNamesHash: afterMove.hash, name: '' });
  assert.deepEqual(cleared.entries, []); assert.equal(await fs.readFile(path.join(f.folder, '新文件名.txt'), 'utf8'), f.original);
  assert.ok((await fs.readdir(path.join(f.root, 'profile', 'chapter-display-names', `${id}-history`))).length >= 1);
});

test('外部正文变化、越界和损坏或未知版本均不覆盖既有内容', async () => {
  const f = await fixture(), id = f.a.id, manuscript = await f.workspace.readChapter(id, '第一章.txt');
  await fs.writeFile(path.join(f.folder, '第一章.txt'), '作者的外部修改');
  await assert.rejects(f.store.set({ projectId: id, path: manuscript.path, expectedChapterHash: manuscript.hash, expectedNamesHash: '', name: '新显示名' }), /内容已变化/u);
  assert.equal(await fs.readFile(path.join(f.folder, '第一章.txt'), 'utf8'), '作者的外部修改');
  await assert.rejects(f.store.set({ projectId: id, path: '../虚构乙/第一章.txt', expectedChapterHash: manuscript.hash, expectedNamesHash: '', name: '越界' }));
  const dir = path.join(f.root, 'profile', 'chapter-display-names'); await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`), raw = JSON.stringify({ schemaVersion: 99, projectId: id, other: '保留' }); await fs.writeFile(file, raw);
  await assert.rejects(f.store.read(id), /损坏或版本不支持/u);
  await assert.rejects(f.store.set({ projectId: id, path: manuscript.path, expectedChapterHash: manuscript.hash, expectedNamesHash: '', name: '新显示名' }), /损坏或版本不支持/u);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});
