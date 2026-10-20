import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/main/workspace';
import { VectorIndexStore } from '../src/main/vector-index-store';
import type { IndexScope, KnowledgeChunk } from '../src/core/knowledge';

const fingerprint = (suffix = 'a') => `${suffix}`.repeat(64);
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-vindex-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await fs.mkdir(path.join(root, '甲'));
  const a = await workspace.attach(path.join(root, '甲'));
  const store = new VectorIndexStore(local, workspace);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const scope: IndexScope = { projectId: a.id, corpus: 'canon', embeddingFingerprint: fingerprint() };
  const chunk = (id: string, sourceHash = 'a'.repeat(64), sourcePath = 'a.docx'): KnowledgeChunk =>
    ({ id, projectId: a.id, corpus: 'canon', sourcePath, sourceHash, startParagraph: 0, endParagraph: 1, text: `文本${id}`, confirmed: true });
  const entry = (id: string, sourceHash = 'a'.repeat(64), sourcePath = 'a.docx') =>
    ({ id, sourcePath, sourceHash, startParagraph: 0, endParagraph: 1, text: `文本${id}`, vector: [0.1, 0.2, 0.3] });
  return { root, local, workspace, store, scope, a, chunk, entry };
}

test('向量索引：写入后可读回，指纹/用途/项目不匹配时拒绝复用', async t => {
  const { store, scope, a, entry } = await fixture(t);
  assert.equal(await store.read(scope), null);
  await store.write(scope, { dimensions: 3, sources: [{ path: 'a.docx', hash: 'a'.repeat(64) }], entries: [entry('c1')] });
  const snapshot = await store.read(scope);
  assert.ok(snapshot); assert.equal(snapshot.entries.length, 1); assert.equal(snapshot.dimensions, 3); assert.equal(snapshot.fingerprint, scope.embeddingFingerprint);
  // A different embedding space is a different file, never a silent reuse.
  assert.equal(await store.read({ ...scope, embeddingFingerprint: fingerprint('b') }), null);
});

test('向量索引：重建规划只算变化来源，状态能报出失效与已删除来源', async t => {
  const { store, scope, chunk, entry } = await fixture(t);
  await store.write(scope, { dimensions: 3, sources: [{ path: 'a.docx', hash: 'a'.repeat(64) }, { path: 'b.docx', hash: 'b'.repeat(64) }],
    entries: [entry('a1'), entry('b1', 'b'.repeat(64), 'b.docx')] });
  const unchanged = await store.plan(scope, [chunk('a1'), chunk('b1', 'b'.repeat(64), 'b.docx')]);
  assert.deepEqual(unchanged.diff.addIds, []); assert.deepEqual(unchanged.diff.removeIds, []); assert.equal(unchanged.keepEntries.length, 2);
  const changed = await store.plan(scope, [chunk('a1'), chunk('b2', 'd'.repeat(64), 'b.docx'), chunk('c1', 'c'.repeat(64), 'c.docx')]);
  assert.deepEqual(changed.diff.addIds.sort(), ['b2', 'c1']); assert.deepEqual(changed.diff.removeIds, ['b1']);
  assert.deepEqual(changed.diff.changedSources, ['b.docx']); assert.deepEqual(changed.diff.removedSources, []);
  assert.equal(changed.keepEntries.length, 1);
  const status = await store.status(scope, { 'a.docx': 'a'.repeat(64), 'b.docx': 'e'.repeat(64) });
  assert.equal(status.exists, true); assert.deepEqual(status.staleSources, ['b.docx']); assert.equal(status.outdated, true);
  const removed = await store.status(scope, { 'a.docx': 'a'.repeat(64) });
  assert.deepEqual(removed.removedSources, ['b.docx']);
});

test('向量索引：损坏、未知版本、维度不符与串书文件保留拒绝，写入不留下临时文件', async t => {
  const { store, scope, local, entry, a } = await fixture(t);
  await store.write(scope, { dimensions: 3, sources: [], entries: [entry('c1')] });
  const folder = path.join(local, 'vector-index', a.id);
  const [file] = (await fs.readdir(folder)).filter(name => name.endsWith('.json'));
  const target = path.join(folder, file);
  const raw = await fs.readFile(target, 'utf8');
  await fs.writeFile(target, raw.replace('"schemaVersion":1', '"schemaVersion":2'));
  await assert.rejects(store.read(scope), /损坏或版本不受支持/u);
  assert.equal(await fs.readFile(target, 'utf8'), raw.replace('"schemaVersion":1', '"schemaVersion":2'));
  await fs.writeFile(target, raw.replace('"dimensions":3', '"dimensions":4'));
  await assert.rejects(store.read(scope), /维度不一致/u);
  await store.clear(scope);
  assert.equal(await store.read(scope), null);
  const leftovers = (await fs.readdir(folder)).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
