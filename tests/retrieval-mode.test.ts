import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetrieval } from '../src/core/retrieval-mode';

test('关键词检索永远可用，不产生告警', () => {
  const plan = planRetrieval('keyword', { embedding: false, index: false, stale: false });
  assert.deepEqual(plan, { requested: 'keyword', effective: 'keyword', warnings: [] });
});

test('缺嵌入连接或缺索引时降级为关键词并说明原因', () => {
  const noEmbedding = planRetrieval('semantic', { embedding: false, index: true, stale: false });
  assert.equal(noEmbedding.effective, 'keyword'); assert.match(noEmbedding.warnings[0], /嵌入连接/u);
  const noIndex = planRetrieval('hybrid', { embedding: true, index: false, stale: false });
  assert.equal(noIndex.effective, 'keyword'); assert.match(noIndex.warnings[0], /向量索引/u);
});

test('索引来源变化时同样降级，不静默使用旧向量', () => {
  const stale = planRetrieval('hybrid', { embedding: true, index: true, stale: true });
  assert.equal(stale.effective, 'keyword'); assert.match(stale.warnings[0], /重建索引/u);
});

test('嵌入与索引都可用时按请求模式执行，语义与混合都不改写用户选择', () => {
  assert.equal(planRetrieval('semantic', { embedding: true, index: true, stale: false }).effective, 'semantic');
  const hybrid = planRetrieval('hybrid', { embedding: true, index: true, stale: false });
  assert.equal(hybrid.effective, 'hybrid'); assert.deepEqual(hybrid.warnings, []);
});
