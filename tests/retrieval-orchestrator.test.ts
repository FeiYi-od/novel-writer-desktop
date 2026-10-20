import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve } from '../src/core/retrieval-orchestrator';
import type { RetrievalHit } from '../src/core/knowledge';

const hit = (id: string, score = 1): RetrievalHit => ({ chunk: { id, projectId: 'p', corpus: 'canon', sourcePath: 'a.docx', sourceHash: 'a'.repeat(64), startParagraph: 0, endParagraph: 0, text: id, confirmed: true }, score });
const ready = { embedding: true, index: true, stale: false };
const signal = new AbortController().signal;

test('关键词模式只跑字面检索，不触发嵌入', async () => {
  let embedded = 0;
  const result = await retrieve({ mode: 'keyword', topK: 2 }, { embedding: false, index: false, stale: false },
    { keyword: async () => [hit('k1'), hit('k2'), hit('k3')], embedQuery: async () => { embedded++; return [1, 0]; }, semantic: async () => [], signal });
  assert.deepEqual(result.hits.map(item => item.chunk.id), ['k1', 'k2']);
  assert.equal(result.usedMode, 'keyword'); assert.equal(embedded, 0);
});

test('缺嵌入或缺索引时降级为关键词，并保留真实原因', async () => {
  const degraded = await retrieve({ mode: 'semantic', topK: 5 }, { embedding: false, index: true, stale: false },
    { keyword: async () => [hit('k1')], embedQuery: async () => { throw new Error('不应调用'); }, semantic: async () => { throw new Error('不应调用'); }, signal });
  assert.equal(degraded.usedMode, 'keyword'); assert.match(degraded.warnings[0], /嵌入连接/u);
  const stale = await retrieve({ mode: 'hybrid', topK: 5 }, { embedding: true, index: true, stale: true },
    { keyword: async () => [hit('k1')], embedQuery: async () => { throw new Error('不应调用'); }, semantic: async () => { throw new Error('不应调用'); }, signal });
  assert.equal(stale.usedMode, 'keyword'); assert.match(stale.warnings[0], /重建索引/u);
});

test('语义模式只跑向量检索，混合模式做 RRF 融合并带指纹', async () => {
  const semanticOnly = await retrieve({ mode: 'semantic', topK: 1 }, ready,
    { keyword: async () => { throw new Error('语义模式不应跑关键词'); }, embedQuery: async () => [1, 0], semantic: async () => [hit('s1'), hit('s2')], signal });
  assert.equal(semanticOnly.usedMode, 'semantic'); assert.deepEqual(semanticOnly.hits.map(item => item.chunk.id), ['s1']);
  const hybrid = await retrieve({ mode: 'hybrid', topK: 3 }, ready,
    { keyword: async () => [hit('k1'), hit('both')], embedQuery: async () => [1, 0], semantic: async () => [hit('s1'), hit('both')], signal, embeddingFingerprint: 'f'.repeat(64) });
  assert.equal(hybrid.usedMode, 'hybrid');
  assert.deepEqual(hybrid.hits.map(item => item.chunk.id), ['both', 'k1', 's1']);
  assert.equal(hybrid.hits[0].embeddingFingerprint, 'f'.repeat(64));
  assert.deepEqual(hybrid.warnings, []);
});

test('取消信号在嵌入前后都能中断，不会静默返回半截结果', async () => {
  const controller = new AbortController();
  await assert.rejects(retrieve({ mode: 'hybrid', topK: 3 }, ready,
    { keyword: async () => { controller.abort(); return []; }, embedQuery: async () => [1, 0], semantic: async () => [], signal: controller.signal }));
  assert.equal(controller.signal.aborted, true);
});
