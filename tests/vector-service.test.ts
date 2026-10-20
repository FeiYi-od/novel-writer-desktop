import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/main/workspace';
import { VectorIndexStore } from '../src/main/vector-index-store';
import { VectorService } from '../src/main/vector-service';
import type { IndexScope, KnowledgeChunk } from '../src/core/knowledge';

const fingerprint = 'f'.repeat(64);
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-vservice-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await fs.mkdir(path.join(root, '甲'));
  const a = await workspace.attach(path.join(root, '甲'));
  const store = new VectorIndexStore(local, workspace);
  const service = new VectorService(store);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const scope: IndexScope = { projectId: a.id, corpus: 'canon', embeddingFingerprint: fingerprint };
  const chunk = (id: string, text: string, sourcePath = 'a.docx', sourceHash = 'a'.repeat(64)): KnowledgeChunk =>
    ({ id, projectId: a.id, corpus: 'canon', sourcePath, sourceHash, startParagraph: 0, endParagraph: 1, text, confirmed: true });
  return { local, store, service, scope, chunk };
}
const embedder = (calls: string[][]) => async (_purpose: 'document' | 'query', inputs: { id: string; text: string }[]) => {
  calls.push(inputs.map(input => input.id));
  return inputs.map((input, index) => ({ id: input.id, values: [input.text.includes('月') ? 1 : 0, input.text.includes('雨') ? 1 : 0.001, index + 1] }));
};

test('索引重建只嵌入新分片，复用时保留旧向量', async t => {
  const { service, scope, chunk } = await fixture(t);
  const calls: string[][] = []; const signal = new AbortController().signal;
  const first = await service.rebuild(scope, [chunk('a1', '月钥'), chunk('a2', '下雨')], 3, embedder(calls), signal);
  assert.equal(first.embedded, 2); assert.equal(first.reused, 0); assert.deepEqual(calls, [['a1', 'a2']]);
  const second = await service.rebuild(scope, [chunk('a1', '月钥'), chunk('a2', '下雨')], 3, embedder(calls), signal);
  assert.equal(second.embedded, 0); assert.equal(second.reused, 2); assert.equal(calls.length, 1);
  const third = await service.rebuild(scope, [chunk('a1', '月钥'), chunk('a2', '下雨'), chunk('a3', '月升')], 3, embedder(calls), signal);
  assert.equal(third.embedded, 1); assert.equal(third.reused, 2); assert.deepEqual(calls[1], ['a3']);
});

test('语义检索按余弦排序，未建索引时明确告警而不是谎报空结果', async t => {
  const { service, scope, chunk } = await fixture(t);
  const signal = new AbortController().signal;
  const empty = await service.search(scope, [1, 0, 0], 5, signal);
  assert.deepEqual(empty.hits, []); assert.match(empty.warnings[0], /尚未建立向量索引/u);
  await service.rebuild(scope, [chunk('a1', '月钥'), chunk('a2', '下雨')], 3, embedder([]), signal);
  const result = await service.search(scope, [1, 0, 0], 5, signal);
  assert.equal(result.hits[0].chunk.id, 'a1'); assert.equal(result.hits[0].embeddingFingerprint, fingerprint);
  assert.equal(result.hits.length, 2);
  const wrong = await service.search(scope, [1, 0], 5, signal);
  assert.deepEqual(wrong.hits, []); assert.match(wrong.warnings[0], /维度/u);
});

test('重建拒绝跨书分片、漏回向量与维度不符，且失败不覆盖已有索引', async t => {
  const { service, scope, chunk } = await fixture(t);
  const signal = new AbortController().signal;
  await service.rebuild(scope, [chunk('a1', '月钥')], 3, embedder([]), signal);
  await assert.rejects(service.rebuild({ ...scope, projectId: '11111111-1111-4111-8111-111111111111' }, [chunk('a1', '月钥')], 3, embedder([]), signal), /本书|不存在|小说/u);
  const missing = async () => [{ id: 'other', values: [1, 1, 1] }];
  await assert.rejects(service.rebuild(scope, [chunk('a1', '月钥'), chunk('a2', '下雨')], 3, missing, signal), /漏掉/u);
  const wrongDimensions = async (_p: 'document' | 'query', inputs: { id: string; text: string }[]) => inputs.map(input => ({ id: input.id, values: [1, 2] }));
  await assert.rejects(service.rebuild(scope, [chunk('a2', '下雨')], 3, wrongDimensions, signal), /维度/u);
  const still = await service.search(scope, [1, 0, 0], 5, signal);
  assert.equal(still.hits.length, 1); // the previous index survived the failed rebuild
  await assert.rejects(service.search(scope, [1, 0, 0], 0, signal), /条数无效/u);
  assert.equal((await service.rebuild(scope, [], 3, embedder([]), signal)).embedded, 0);
});
