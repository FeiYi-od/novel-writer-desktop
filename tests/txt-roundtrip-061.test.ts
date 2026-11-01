import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { txtDocument, txtText, textDocument } from '../src/main/text-import';
import type { RichNode } from '../src/shared/contracts';

test('外部 TXT 的连续空段和末尾换行经重复保存不被删除或膨胀', async () => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/txt-roundtrip-061-'));
  const folder = path.join(root, '虚构小说'); await fs.mkdir(folder);
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  const book = await workspace.attach(folder), original = '第一段\r\n\r\n\r\n第二段\r\n';
  await fs.writeFile(path.join(folder, '空段.txt'), original);
  let chapter = await workspace.readChapter(book.id, '空段.txt');
  assert.equal((chapter.content as RichNode).content!.length, 5);
  const expected = '　　第一段\n　　\n　　\n　　第二段\n　　';
  for (let index = 0; index < 3; index++) {
    chapter = await workspace.saveChapter({ projectId: book.id, path: chapter.path, expectedHash: chapter.hash, content: chapter.content as RichNode });
    assert.equal(await fs.readFile(path.join(folder, '空段.txt'), 'utf8'), expected);
    chapter = await workspace.readChapter(book.id, chapter.path);
    assert.equal((chapter.content as RichNode).content!.length, 5);
  }
  const previous = (await fs.readdir(path.join(root, 'local', 'recovery', book.id))).filter(name => name.endsWith('-previous.txt'));
  assert.ok((await Promise.all(previous.map(name => fs.readFile(path.join(root, 'local', 'recovery', book.id, name), 'utf8')))).includes(original));
});

test('本应用保存的 TXT 可从同书版本缓存恢复软换行；外部 TXT 不猜测软换行', async () => {
  const root = await fs.mkdtemp(path.resolve('.artifacts/txt-softbreak-061-'));
  const folder = path.join(root, '虚构小说'); await fs.mkdir(folder);
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize();
  const book = await workspace.attach(folder);
  const content: RichNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一行' }, { type: 'hardBreak' }, { type: 'text', text: '软换行' }] }, { type: 'paragraph', content: [] }, { type: 'paragraph', content: [{ type: 'text', text: '末段' }] }] };
  const doc = await workspace.createChapter(book.id, content, 'txt');
  assert.equal(await fs.readFile(path.join(folder, doc.path), 'utf8'), '　　第一行\n软换行\n　　\n　　末段');
  let read = await workspace.readChapter(book.id, doc.path);
  assert.deepEqual((read.content as RichNode).content![0].content?.map(run => run.type), ['text', 'hardBreak', 'text']);
  read = await workspace.saveChapter({ projectId: book.id, path: doc.path, expectedHash: doc.hash, content: read.content as RichNode });
  assert.deepEqual(((await workspace.readChapter(book.id, doc.path)).content as RichNode).content![0].content?.map(run => run.type), ['text', 'hardBreak', 'text']);
  assert.equal(txtText(txtDocument('甲\n\n乙')), '　　甲\n　　\n　　乙');
  assert.equal(textDocument('甲\n\n乙').content!.length, 2, 'AI 审稿原有解析语义不能被 TXT 调整改变');
});
