import test from 'node:test';
import assert from 'node:assert/strict';
import { cosine, diffIndex, hybridMerge, indexFingerprint, validateVectors } from '../src/core/vector-index';
import type { KnowledgeChunk, RetrievalHit } from '../src/core/knowledge';

const chunk = (id: string, sourcePath = 'a.docx', sourceHash = 'a'.repeat(64)): KnowledgeChunk =>
  ({ id, projectId: 'p', corpus: 'canon', sourcePath, sourceHash, startParagraph: 0, endParagraph: 0, text: `文本${id}`, confirmed: true });
const hit = (id: string, score = 1): RetrievalHit => ({ chunk: chunk(id), score });

test('索引指纹随模型、维度或分片策略变化', () => {
  const space = { protocol: 'openai-embeddings', model: 'bge-m3', modelRevision: 'r1', dimensions: 1024 };
  const chunking = { maxCharacters: 2000, overlapCharacters: 99, version: 1 };
  const base = indexFingerprint(space, chunking);
  assert.equal(indexFingerprint(space, chunking), base);
  assert.notEqual(indexFingerprint({ ...space, dimensions: 768 }, chunking), base);
  assert.notEqual(indexFingerprint({ ...space, modelRevision: 'r2' }, chunking), base);
  assert.notEqual(indexFingerprint(space, { ...chunking, overlapCharacters: 100 }), base);
  assert.equal(indexFingerprint({ ...space, model: ' text-embedding-3 ' }, chunking), indexFingerprint({ ...space, model: 'text-embedding-3' }, chunking)); // whitespace is normalized
});

test('增量规划只重嵌变化的来源，删除来源的向量一并移除', () => {
  const previous = [
    { id: 'a-1', sourcePath: 'a.docx', sourceHash: 'a'.repeat(64) },
    { id: 'b-1', sourcePath: 'b.docx', sourceHash: 'b'.repeat(64) },
    { id: 'c-1', sourcePath: 'c.docx', sourceHash: 'c'.repeat(64) }
  ];
  const diff = diffIndex(previous, [chunk('a-1'), chunk('b-2', 'b.docx', 'd'.repeat(64)), chunk('e-1', 'e.docx', 'e'.repeat(64))]);
  assert.deepEqual(diff.keepIds, ['a-1']);
  assert.deepEqual(diff.addIds.sort(), ['b-2', 'e-1']);
  assert.deepEqual(diff.removeIds.sort(), ['b-1', 'c-1']);
  assert.deepEqual(diff.changedSources, ['b.docx']);
  assert.deepEqual(diff.removedSources.sort(), ['c.docx']);
  const unchanged = diffIndex(previous, previous.map(item => chunk(item.id, item.sourcePath, item.sourceHash)));
  assert.deepEqual({ ...unchanged, keepIds: unchanged.keepIds.sort() }, { keepIds: ['a-1', 'b-1', 'c-1'], addIds: [], removeIds: [], changedSources: [], removedSources: [] });
});

test('余弦相似度拒绝维度不一致、非法值与零向量', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-12);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-12);
  assert.throws(() => cosine([1, 0], [1]), /维度不一致/u);
  assert.throws(() => cosine([], []), /为空/u);
  assert.throws(() => cosine([0, 0], [1, 1]), /范数为零/u);
  assert.throws(() => cosine([Number.NaN, 1], [1, 1]), /非法数值/u);
});

test('写入前校验向量数量、维度与数值，重复 ID 拒绝', () => {
  validateVectors([{ id: 'a', values: [1, 2] }, { id: 'b', values: [0.5, -1] }], 2);
  assert.throws(() => validateVectors([{ id: 'a', values: [1, 2] }], 3), /维度不匹配/u);
  assert.throws(() => validateVectors([{ id: 'a', values: [1, 2] }, { id: 'a', values: [1, 2] }], 2), /重复/u);
  assert.throws(() => validateVectors([{ id: 'a', values: [1, Number.POSITIVE_INFINITY] }], 2), /非法数值/u);
  assert.throws(() => validateVectors([], 0), /维度无效/u);
});

test('混合检索并列关键词与语义结果，双命中优先且顺序稳定', () => {
  const merged = hybridMerge([hit('k1'), hit('both')], [hit('s1'), hit('both')], 10, 'f'.repeat(64));
  assert.deepEqual(merged.hits.map(item => item.chunk.id), ['both', 'k1', 's1']);
  assert.ok(merged.hits[0].score > merged.hits[1].score);
  assert.equal(merged.hits[0].embeddingFingerprint, 'f'.repeat(64));
  assert.equal(merged.hits[1].embeddingFingerprint, undefined); // keyword-only hits do not claim a vector
  assert.deepEqual(hybridMerge([hit('k1')], [hit('k1')], 1).hits.map(item => item.chunk.id), ['k1']);
  assert.equal(hybridMerge([hit('b'), hit('a')], [hit('a'), hit('b')], 2).hits.length, 2);
  assert.equal(hybridMerge([], [], 5).warnings.length, 1);
  assert.throws(() => hybridMerge([], [], 0), /条数无效/u);
});
