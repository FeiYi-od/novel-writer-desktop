import { listenLocalHttp } from './support/local-http';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpEmbeddingProvider, embeddingFingerprint } from '../src/main/embedding-provider';
import { EmbeddingService } from '../src/main/embedding-service';
import { AuxiliaryModels } from '../src/main/auxiliary-models';
import type { AuxiliaryModelConnection } from '../src/shared/contracts';
import type { EmbeddingRequest } from '../src/core/knowledge';

async function fixture(t: TestContext) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-embedding-test-')); t.after(async () => { assert.match(path.relative(os.tmpdir(), dir), /^novel-embedding-test-[^\\/]+$/); await fs.rm(dir, { recursive: true, force: true }); }); return dir; }
const codec = { encrypt: (s: string) => Buffer.from('encoded:' + s), decrypt: (b: Buffer) => b.toString().slice(8) };
const profile = (url: string, type: string): AuxiliaryModelConnection => ({ id: randomUUID(), kind: 'embedding', name: '测试', type, hasKey: true, parameters: { embedding_api_base: url, embedding_model: 'test-embed', embedding_dimensions: 3, ...(type === 'openai_embedding' ? { embedding_dimensions_mode: 'manual' } : {}), timeout: 2 } });
const request = (p: AuxiliaryModelConnection): EmbeddingRequest => { const id = randomUUID(); return { scope: { projectId: id, corpus: 'canon', embeddingFingerprint: embeddingFingerprint(p, 3) }, dimensions: 3, purpose: 'document', inputs: [{ id: 'a', projectId: id, text: '完全虚构测试甲' }, { id: 'b', projectId: id, text: '完全虚构测试乙' }] }; };

test('五类嵌入真实HTTP形状与query/document用途、输出映射和思考无关', async t => {
  const calls: any[] = [], server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); calls.push({ url: req.url, body, headers: req.headers }); res.setHeader('Content-Type', 'application/json');
    const a = [1, 2, 3], b = [4, 5, 6];
    res.end(JSON.stringify(req.url!.includes('batchEmbedContents') ? { embeddings: [{ values: a }, { values: b }] } : req.url!.endsWith('/api/embed') ? { embeddings: [a, b] } : req.url!.includes('text-embedding/') ? { output: { embeddings: [{ text_index: 1, embedding: b }, { text_index: 0, embedding: a }] } } : { data: [{ index: 1, embedding: b }, { index: 0, embedding: a }] }));
  }); await listenLocalHttp(server); t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); })); const url = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const type of ['openai_embedding', 'gemini_embedding', 'nvidia_embedding', 'ollama_embedding', 'dashscope_embedding']) {
    const p = profile(url, type), input = request(p), provider = new HttpEmbeddingProvider(p, 'test-key');
    const result = await provider.embed(input, AbortSignal.timeout(2000)); assert.equal(result.scope.projectId, input.scope.projectId); assert.equal(result.scope.corpus, 'canon'); assert.deepEqual(result.vectors, [{ id: 'a', values: [1, 2, 3] }, { id: 'b', values: [4, 5, 6] }]);
    const call = calls.at(-1); assert.ok(!call.url.includes('test-key'));
    if (type === 'gemini_embedding') { assert.equal(call.headers.authorization, undefined); assert.equal(call.headers['x-goog-api-key'], 'test-key'); assert.equal(call.body.requests[0].taskType, 'RETRIEVAL_DOCUMENT'); }
    else assert.equal(call.headers.authorization, 'Bearer test-key');
    if (type === 'ollama_embedding') assert.equal(call.body.truncate, false);
    if (type === 'openai_embedding') assert.equal(call.body.dimensions, 3);
    if (type === 'nvidia_embedding') { assert.equal(call.body.truncate, 'NONE'); assert.equal(call.body.input_type, 'passage'); }
    await provider.embed({ ...input, purpose: 'query' }, AbortSignal.timeout(2000)); const query = calls.at(-1).body;
    if (type === 'gemini_embedding') assert.equal(query.requests[0].taskType, 'RETRIEVAL_QUERY');
    if (type === 'nvidia_embedding') assert.equal(query.input_type, 'query');
    if (type === 'dashscope_embedding') assert.equal(query.parameters.text_type, 'query');
  }
});

test('嵌入串书/错指纹/重复输入先拒绝，错误维度/索引/空向量/超大与重定向不入库', async t => {
  let calls = 0, mode = 'valid'; const server = createServer((_, res) => { calls++; res.setHeader('Content-Type', 'application/json'); if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/secret'); res.end(); return; } if (mode === 'huge') { res.end('x'.repeat(8 * 1024 * 1024 + 1)); return; } const index = mode === 'duplicate' ? 0 : 1, values = mode === 'zero' ? [0, 0, 0] : mode === 'dimension' ? [1, 2] : [1, 2, 3]; res.end(JSON.stringify({ data: [{ index: 0, embedding: values }, { index, embedding: values }] })); }); await listenLocalHttp(server); t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  const p = profile(`http://127.0.0.1:${(server.address() as any).port}`, 'openai_embedding'), input = request(p), provider = new HttpEmbeddingProvider(p, 'fake');
  await assert.rejects(provider.embed({ ...input, inputs: [{ ...input.inputs[0], projectId: randomUUID() }] }, AbortSignal.timeout(1000)), /串书/);
  await assert.rejects(provider.embed({ ...input, inputs: [input.inputs[0], input.inputs[0]] }, AbortSignal.timeout(1000)), /重复/);
  await assert.rejects(provider.embed({ ...input, scope: { ...input.scope, embeddingFingerprint: '0'.repeat(64) } }, AbortSignal.timeout(1000)), /指纹/); assert.equal(calls, 0);
  for (const value of ['duplicate', 'zero', 'dimension', 'huge', 'redirect']) { mode = value; await assert.rejects(provider.embed(input, AbortSignal.timeout(2000))); }
});

test('显式探测只发固定虚构句子，实际维度不自动改配置；迟到旧配置与取消拒绝', async t => {
  const sent: string[][] = []; let release: (() => void) | null = null, delaying = false;
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; sent.push(JSON.parse(raw).input); if (delaying) await new Promise<void>(r => release = r); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ embeddings: [[1, 2, 3, 4], [5, 6, 7, 8]] })); }); await listenLocalHttp(server); t.after(() => new Promise<void>(r => { release?.(); server.closeAllConnections(); server.close(() => r()); }));
  const dir = await fixture(t), models = new AuxiliaryModels(dir, codec), p = profile(`http://127.0.0.1:${(server.address() as any).port}`, 'ollama_embedding'); const { id: _id, hasKey: _key, ...edit } = p; let snapshot = await models.save(edit, ''); const service = new EmbeddingService(models), id = snapshot.connections[0].id;
  const raw = await fs.readFile(path.join(dir, 'auxiliary-models.json')); const result = await service.test(id, snapshot.hash, randomUUID()); assert.equal(result.dimensions, 4); assert.equal(result.dimensionMatches, false); assert.equal(result.inputCount, 2); assert.deepEqual(await fs.readFile(path.join(dir, 'auxiliary-models.json')), raw); assert.deepEqual(sent[0], ['虚构的学园位于山谷。', '虚构人物在图书馆阅读。']);
  delaying = true; const stale = service.test(id, snapshot.hash, randomUUID()); const waitSent = async (n: number) => { while (sent.length < n) await new Promise(r => setTimeout(r, 10)); }; await waitSent(2); snapshot = await models.save({ ...edit, id, name: '外部更新' }, snapshot.hash); (release as unknown as () => void)(); await assert.rejects(stale, /配置已更新/);
  const requestId = randomUUID(), pending = service.test(id, snapshot.hash, requestId); await waitSent(3); service.cancel(requestId); await assert.rejects(pending, /已停止/); (release as unknown as () => void)();
});
