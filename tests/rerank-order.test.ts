import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRerank } from '../src/core/rerank-order';
import type { RetrievalHit } from '../src/core/knowledge';

const hit = (id: string): RetrievalHit => ({ chunk: { id, projectId: 'p', corpus: 'canon', sourcePath: 'a.docx', sourceHash: 'a'.repeat(64), startParagraph: 0, endParagraph: 0, text: id, confirmed: true }, score: 1 });
const ids = (hits: RetrievalHit[]) => hits.map(item => item.chunk.id);

test('重排：按分数降序，同分保持原顺序', () => {
  const hits = [hit('a'), hit('b'), hit('c')];
  assert.deepEqual(ids(applyRerank(hits, [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.9 }], 3)), ['b', 'c', 'a']);
});

test('重排：未打分的命中保留在原相对顺序并排在后面，不丢证据', () => {
  const hits = [hit('a'), hit('b'), hit('c'), hit('d')];
  assert.deepEqual(ids(applyRerank(hits, [{ index: 3, score: 1 }], 4)), ['d', 'a', 'b', 'c']);
  assert.equal(applyRerank(hits, [], 3).length, 3, '空排序时按原顺序截断');
});

test('重排：非法/重复/非有限分数被忽略，topK 生效', () => {
  const hits = [hit('a'), hit('b')];
  const ranked = applyRerank(hits, [{ index: -1, score: 9 }, { index: 5, score: 9 }, { index: 0, score: 1 }, { index: 0, score: 5 }, { index: 1, score: Number.NaN }], 1);
  assert.deepEqual(ids(ranked), ['a']);
});
