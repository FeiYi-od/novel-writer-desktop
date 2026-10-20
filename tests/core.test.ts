import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleContext, canApplyGeneration, type ContextPiece } from '../src/core/ai';
import { validMemories, type MemoryEntry } from '../src/core/memory';
import { copyableText, normalizeParagraphs, PARAGRAPH_PREFIX } from '../src/core/typography';
import { currentKnowledgeHits, validateEmbeddingBatch, type EmbeddingRequest, type RetrievalHit, type RetrievalRequest } from '../src/core/knowledge';

const part = (id: string, tokens: number, required = false): ContextPiece => ({ id, projectId: 'a', text: id, tokens, required, purpose: 'canon' });
test('先保留必要上下文，按预算舍弃可选内容', () => {
  const result = assembleContext('a', [part('optional', 50), part('must', 80, true), part('small', 10)], 100);
  assert.equal(result.used, 90);
  assert.deepEqual(result.omitted, ['optional']);
});
test('跨书上下文和必需内容超限均拒绝', () => {
  assert.throws(() => assembleContext('b', [part('a', 10)], 100), /其他小说/);
  assert.throws(() => assembleContext('a', [part('a', 110, true)], 100), /超过预算/);
});
test('迟到生成不能覆盖其他书或新版本', () => {
  const request = { projectId: 'a', chapterPath: '1.docx', sourceHash: 'old', prompt: '' };
  assert.equal(canApplyGeneration(request, { projectId: 'b', path: '1.docx', hash: 'old' }), false);
  assert.equal(canApplyGeneration(request, { projectId: 'a', path: '1.docx', hash: 'new' }), false);
  assert.equal(canApplyGeneration(request, { projectId: 'a', path: '1.docx', hash: 'old' }), true);
});
test('记忆只使用本书已确认且原文未变化的内容', () => {
  const entry: MemoryEntry = { id: '1', projectId: 'a', kind: 'fact', sourcePath: '1.docx', sourceHash: 'hash', content: '人物状态', status: 'confirmed' };
  assert.equal(validMemories('a', [entry], { '1.docx': 'hash' }).length, 1);
  assert.equal(validMemories('b', [entry], { '1.docx': 'hash' }).length, 0);
  assert.equal(validMemories('a', [entry], { '1.docx': 'changed' }).length, 0);
});
test('段首是真实全角空格，重复处理不增加空格，标题不缩进', () => {
  const content = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: ' 　' }, { type: 'text', text: '你好', marks: [{ type: 'bold' }] }] },
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '标题' }] }
  ] };
  const normalized = normalizeParagraphs(content);
  assert.equal(normalized.content![0].content![0].text, `${PARAGRAPH_PREFIX}你好`);
  assert.equal(normalized.content![1].content![0].text, '标题');
  assert.deepEqual(normalizeParagraphs(normalized), normalized);
  assert.equal(copyableText(normalized), `${PARAGRAPH_PREFIX}你好\n\n标题`);
});

test('嵌入预留接口拒绝串书、混模型维度、漏项和重复向量', () => {
  const request: EmbeddingRequest = { scope: { projectId: 'a', corpus: 'canon', embeddingFingerprint: 'model-v1:2' }, dimensions: 2, purpose: 'document', inputs: [{ id: '1', projectId: 'a', text: '角色设定' }, { id: '2', projectId: 'a', text: '世界规则' }] };
  const batch = { scope: request.scope, dimensions: 2, vectors: [{ id: '2', values: [1, 0] }, { id: '1', values: [0, 1] }] };
  validateEmbeddingBatch(request, batch);
  assert.throws(() => validateEmbeddingBatch(request, { ...batch, scope: { ...batch.scope, projectId: 'b' } }), /不匹配/);
  assert.throws(() => validateEmbeddingBatch(request, { ...batch, scope: { ...batch.scope, embeddingFingerprint: 'model-v2:2' } }), /不匹配/);
  assert.throws(() => validateEmbeddingBatch(request, { ...batch, dimensions: 3 }), /维度/);
  assert.throws(() => validateEmbeddingBatch(request, { ...batch, vectors: [batch.vectors[0], batch.vectors[0]] }), /重复/);
  assert.throws(() => validateEmbeddingBatch(request, { ...batch, vectors: [{ id: '1', values: [NaN, 0] }, batch.vectors[0]] }), /无效/);
});

test('知识检索拒绝混入文风语料，原文更新、废稿和旧模型索引失效，关键词路径不依赖向量', () => {
  const request: RetrievalRequest = { scope: { projectId: 'a', corpus: 'canon', embeddingFingerprint: 'model-v1' }, query: '人物', topK: 5, mode: 'semantic', currentHashes: { '1.docx': 'latest' } };
  const hit: RetrievalHit = { chunk: { id: '1', projectId: 'a', corpus: 'canon', sourcePath: '1.docx', sourceHash: 'latest', startParagraph: 0, endParagraph: 1, text: '事实', confirmed: true }, score: 0.8, embeddingFingerprint: 'model-v1' };
  assert.equal(currentKnowledgeHits(request, [hit]).length, 1);
  assert.equal(currentKnowledgeHits(request, [{ ...hit, embeddingFingerprint: 'old-model' }]).length, 0);
  assert.equal(currentKnowledgeHits(request, [{ ...hit, chunk: { ...hit.chunk, sourceHash: 'old' } }]).length, 0);
  assert.equal(currentKnowledgeHits(request, [{ ...hit, chunk: { ...hit.chunk, confirmed: false } }]).length, 0);
  assert.throws(() => currentKnowledgeHits(request, [{ ...hit, chunk: { ...hit.chunk, corpus: 'style-reference' } }]), /其他用途/);
  assert.throws(() => currentKnowledgeHits(request, [{ ...hit, chunk: { ...hit.chunk, projectId: 'b' } }]), /其他小说/);
  assert.equal(currentKnowledgeHits({ ...request, mode: 'keyword' }, [{ ...hit, embeddingFingerprint: undefined }]).length, 1);
});
