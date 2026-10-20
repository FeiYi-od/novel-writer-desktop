import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { RecoveryStore } from '../src/main/recovery';
import { textDocument } from '../src/main/text-import';
import type { DraftRequest } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-checkpoint-directory-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = new Workspace(path.join(root, 'local'));
  await workspace.initialize();
  const aRoot = path.join(root, '甲书'), bRoot = path.join(root, '乙书');
  await fs.mkdir(aRoot); await fs.mkdir(bRoot);
  const a = await workspace.attach(aRoot), b = await workspace.attach(bRoot);
  const aChapter = await workspace.createChapter(a.id, textDocument('甲书的虚构正文。'));
  const bChapter = await workspace.createChapter(b.id, textDocument('乙书的虚构正文。'));
  const recovery = path.join(root, 'recovery'), store = new RecoveryStore(recovery, workspace);
  const request = (): DraftRequest => ({ projectId: a.id, id: randomUUID(), path: aChapter.path, expectedHash: aChapter.hash, revision: 1, content: textDocument('只属于甲书的未保存虚构稿。') });
  return { root, workspace, a, b, aChapter, bChapter, recovery, store, request };
}

test('普通草稿 checkpoint 拒绝将甲书恢复目录链接到乙书，乙书不被写入', async t => {
  const f = await fixture(t), bDirectory = path.join(f.recovery, f.b.id);
  await fs.mkdir(bDirectory, { recursive: true });
  const sentinel = '乙书已有恢复资料，必须原样保留';
  await fs.writeFile(path.join(bDirectory, '保留.txt'), sentinel);
  await fs.symlink(bDirectory, path.join(f.recovery, f.a.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.checkpoint(f.request()), /链接|目录|越界/u);
  assert.deepEqual(await fs.readdir(bDirectory), ['保留.txt']);
  assert.equal(await fs.readFile(path.join(bDirectory, '保留.txt'), 'utf8'), sentinel);
});

test('普通草稿 read/list 拒绝甲书恢复目录链接，乙书草稿仍可正常读取', async t => {
  const f = await fixture(t), id = randomUUID();
  await f.store.checkpoint({ projectId: f.b.id, id, path: f.bChapter.path, expectedHash: f.bChapter.hash, revision: 1, content: textDocument('乙书自己的未保存稿。') });
  const bDirectory = path.join(f.recovery, f.b.id), original = await fs.readFile(path.join(bDirectory, `${id}.json`));
  await fs.symlink(bDirectory, path.join(f.recovery, f.a.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.read(f.a.id, id), /链接|目录|越界/u);
  await assert.rejects(f.store.list(f.a.id), /链接|目录|越界/u);
  assert.equal((await f.store.read(f.b.id, id)).projectId, f.b.id);
  assert.deepEqual(await fs.readFile(path.join(bDirectory, `${id}.json`)), original);
});

test('checkpoint 在进入异步队列前冻结小说、来源、ID、版本和正文', async t => {
  const f = await fixture(t), input = f.request();
  const frozen = structuredClone(input);
  const pending = f.store.checkpoint(input);
  input.projectId = f.b.id;
  input.id = randomUUID();
  input.path = f.bChapter.path;
  input.expectedHash = 'f'.repeat(64);
  input.revision = 99;
  input.content.content![0]!.content![0]!.text = '调用后才产生的乙书内容，不能偷换已入队的甲书稿。';
  await pending;
  const saved = await f.store.read(f.a.id, frozen.id);
  assert.equal(saved.projectId, f.a.id);
  assert.equal(saved.sourcePath, frozen.path);
  assert.equal(saved.sourceHash, frozen.expectedHash);
  assert.equal(saved.revision, 1);
  assert.match(JSON.stringify(saved.content), /只属于甲书的未保存虚构稿/u);
  assert.doesNotMatch(JSON.stringify(saved.content), /调用后才产生/u);
  assert.equal(await fs.stat(path.join(f.recovery, f.b.id)).then(() => true).catch(() => false), false, '乙书不应创建恢复目录');
});
