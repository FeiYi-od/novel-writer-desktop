import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-split-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '整本拆章书');
  return { root, workspace, project };
}

const book = [
  '　　前言：这是一段没有标题的开场白。',
  '',
  '第一章 起风',
  '　　风从北面来。',
  '',
  '第二章 落雨',
  '　　雨落在屋檐上。',
  '',
  '番外 后来',
  '　　后来一切都好。',
  ''
].join('\n');

test('整本 TXT 拆章：按标题行分段、序前单独成章、正文逐字节保留', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const plan = await f.workspace.planTextSplit(f.project.project.id, { name: '旧稿合集.txt', data: Buffer.from(book, 'utf8') });
  assert.equal(plan.rule, '按章节标题行拆分');
  assert.deepEqual(plan.items.map(item => item.targetName), ['序前.txt', '第一章 起风.txt', '第二章 落雨.txt', '番外 后来.txt']);
  assert.equal(await fs.stat(path.join(f.project.root, '第一章 起风.txt')).then(() => true).catch(() => false), false, '预览阶段不能写盘');
  const commit = await f.workspace.commitChapterImport(f.project.project.id, plan.token, plan.items.map(item => ({ id: item.id, include: true })));
  assert.equal(commit.imported.length, 4, JSON.stringify(commit));
  const first = await fs.readFile(path.join(f.project.root, '第一章 起风.txt'), 'utf8');
  assert.equal(first, '第一章 起风\n　　风从北面来。\n');
  assert.equal(await fs.readFile(path.join(f.project.root, '序前.txt'), 'utf8'), '　　前言：这是一段没有标题的开场白。\n');
  const second = await f.workspace.planTextSplit(f.project.project.id, { name: '再导一次.txt', data: Buffer.from(book, 'utf8') });
  assert.deepEqual(second.items.map(item => item.targetName), ['序前-导入-1.txt', '第一章 起风-导入-1.txt', '第二章 落雨-导入-1.txt', '番外 后来-导入-1.txt']);
  assert.equal(second.items.every(item => item.duplicate), true);
});

test('整本 TXT 拆章：没有标题行时整本作为一章；CRLF 被规范化', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const plan = await f.workspace.planTextSplit(f.project.project.id, { name: '流水账.txt', data: Buffer.from('第一行\r\n第二行\r\n', 'utf8') });
  assert.equal(plan.rule, '未发现章节标题，整本作为一章');
  assert.deepEqual(plan.items.map(item => item.targetName), ['流水账.txt']);
  const commit = await f.workspace.commitChapterImport(f.project.project.id, plan.token, [{ id: plan.items[0]!.id, include: true }]);
  assert.equal(commit.imported.length, 1);
  assert.equal(await fs.readFile(path.join(f.project.root, '流水账.txt'), 'utf8'), '第一行\n第二行\n');
});

test('整本 TXT 拆章：非 UTF-8、非 TXT、空文件都拒绝', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await assert.rejects(f.workspace.planTextSplit(f.project.project.id, { name: 'a.txt', data: new Uint8Array([0xff, 0xfe, 0x41]) }), /UTF-8/u);
  await assert.rejects(f.workspace.planTextSplit(f.project.project.id, { name: 'a.docx', data: Buffer.from('x') }), /只支持 TXT/u);
  await assert.rejects(f.workspace.planTextSplit(f.project.project.id, { name: 'a.txt', data: new Uint8Array() }), /文件为空/u);
});
