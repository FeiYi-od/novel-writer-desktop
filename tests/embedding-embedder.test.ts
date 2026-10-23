import { listenLocalHttp } from './support/local-http';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createEmbedder } from '../src/main/embedding-embedder';
import type { AuxiliaryModelConnection } from '../src/shared/contracts';

async function mock(t: TestContext) {
  const calls: { url?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embeddings: (body.input as string[]).map((_, index) => [index + 0.1, 0.2, 0.3]) }));
  });
  await listenLocalHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}
const profile = (baseUrl: string): AuxiliaryModelConnection => ({ id: '11111111-1111-4111-8111-111111111111', kind: 'embedding', name: '本机 Ollama', type: 'ollama_embedding', parameters: { embedding_api_base: baseUrl, embedding_model: 'bge-m3', timeout: 30, embedding_dimensions: 1024 }, hasKey: false });

test('嵌入适配器：只给嵌入连接用，维度必须有效', () => {
  const connection = profile('http://127.0.0.1:11434');
  assert.throws(() => createEmbedder({ ...connection, kind: 'rerank' }, '', 1024, 'p', 'canon'), /不是嵌入模型/u);
  assert.throws(() => createEmbedder(connection, '', 0, 'p', 'canon'), /正整数/u);
  const bundle = createEmbedder(connection, '', 3, 'p', 'canon');
  assert.equal(bundle.dimensions, 3); assert.equal(bundle.scope.embeddingFingerprint, bundle.fingerprint);
});

test('嵌入适配器：把文档与查询用途、固定作用域传给本机服务，并原样返回向量', async t => {
  const service = await mock(t);
  const bundle = createEmbedder(profile(service.url), '', 3, '22222222-2222-4222-8222-222222222222', 'canon');
  const vectors = await bundle.embed('document', [{ id: 'c1', text: '月钥只能开启北门' }, { id: 'c2', text: '雨停了' }], new AbortController().signal);
  assert.deepEqual(vectors.map(vector => vector.id), ['c1', 'c2']);
  assert.equal(vectors[0].values.length, 3);
  assert.equal(service.calls[0].url, '/api/embed');
  const body = service.calls[0].body as { model: string; input: string[]; truncate: boolean };
  assert.equal(body.model, 'bge-m3'); assert.deepEqual(body.input, ['月钥只能开启北门', '雨停了']); assert.equal(body.truncate, false);
  await bundle.embed('query', [], new AbortController().signal);
  assert.equal(service.calls.length, 1); // empty input never hits the service
});
