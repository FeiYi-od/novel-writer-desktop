import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/main/workspace';
import { VectorIndexStore } from '../src/main/vector-index-store';
import { VectorService } from '../src/main/vector-service';
import { KnowledgeIndexService } from '../src/main/knowledge-index';
import type { KnowledgeChunk } from '../src/core/knowledge';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-kindex-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await fs.mkdir(path.join(root, '甲'));
  const a = await workspace.attach(path.join(root, '甲'));
  const store = new VectorIndexStore(local, workspace);
  const service = new KnowledgeIndexService({ collectChunks: async () => ({ chunks: [], warnings: [] }) }, store, new VectorService(store), workspace);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const fingerprint = 'f'.repeat(64);
  const chunk = (id: string, text: string, sourceHash = 'a'.repeat(64)): KnowledgeChunk =>
    ({ id, projectId: a.id, corpus: 'canon', sourcePath: 'a.docx', sourceHash, startParagraph: 0, endParagraph: 1, text, confirmed: true });
  const embed = async (_p: 'document' | 'query', inputs: { id: string; text: string }[]) => inputs.map(input => ({ id: input.id, values: [input.text.includes('月') ? 1 : 0, 1, 1] }));
  return { workspace, store, service, a, fingerprint, chunk, embed, local };
}
const provider = (chunks: KnowledgeChunk[], warnings: string[] = []) => ({ collectChunks: async () => ({ chunks, warnings }) });

test('索引服务：没有嵌入指纹时明确说语义不可用，不假装已建索引', async t => {
  const f = await fixture(t);
  const status = await f.service.status(f.a.id, 'canon');
  assert.equal(status.exists, false); assert.equal(status.entries, 0);
  assert.match(status.warnings[0], /尚未选择嵌入连接/u);
});

test('索引服务：重建嵌入全部来源，再查状态看到条数与维度，语义检索可命中', async t => {
  const f = await fixture(t);
  const service = new KnowledgeIndexService(provider([f.chunk('c1', '月钥'), f.chunk('c2', '下雨')]), f.store, new VectorService(f.store), f.workspace);
  const result = await service.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed });
  assert.equal(result.stats.embedded, 2); assert.deepEqual(result.warnings, []);
  const status = await service.status(f.a.id, 'canon', f.fingerprint);
  assert.equal(status.exists, true); assert.equal(status.entries, 2); assert.equal(status.dimensions, 3);
  const search = await service.search(f.a.id, 'canon', f.fingerprint, [1, 1, 1], 5, new AbortController().signal);
  assert.equal(search.hits[0].chunk.id, 'c1');
});

test('索引服务：来源为空时清除旧索引；重复重建只补新分片；结束状态可再次重建', async t => {
  const f = await fixture(t);
  let chunks = [f.chunk('c1', '月钥')];
  const service = new KnowledgeIndexService({ collectChunks: async () => ({ chunks, warnings: [] }) }, f.store, new VectorService(f.store), f.workspace);
  await service.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed });
  chunks = [f.chunk('c1', '月钥'), f.chunk('c2', '下雨')];
  const second = await service.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed });
  assert.equal(second.stats.embedded, 1); assert.equal(second.stats.reused, 1);
  chunks = [];
  const cleared = await service.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed });
  assert.equal(cleared.stats.embedded, 0); assert.match(cleared.warnings.join('\n'), /没有可索引的来源|已清除/u);
  assert.equal((await service.status(f.a.id, 'canon', f.fingerprint)).exists, false);
});

test('索引服务：重建期间重复调用被拒绝，停止后可以重新开始', async t => {
  const f = await fixture(t);
  let release: (() => void) | undefined;
  const service = new KnowledgeIndexService({ collectChunks: () => new Promise(resolve => { release = () => resolve({ chunks: [f.chunk('c1', '月钥')], warnings: [] }); }) }, f.store, new VectorService(f.store), f.workspace);
  const running = service.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed });
  await assert.rejects(service.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed }), /已有索引重建进行中/u);
  service.cancel(f.a.id);
  release?.();
  await assert.rejects(running, /abort|已停止|取消/u);
  const restarted = new KnowledgeIndexService(provider([f.chunk('c1', '月钥')]), f.store, new VectorService(f.store), f.workspace);
  const again = await restarted.rebuild({ projectId: f.a.id, corpus: 'canon', fingerprint: f.fingerprint, dimensions: 3, embed: f.embed });
  assert.equal(again.stats.embedded, 1);
});
