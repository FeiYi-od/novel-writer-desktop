import { listenLocalHttp } from './support/local-http';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpRerankProvider, RERANK_PROBE_PROJECT_ID, RERANK_PROBE_QUERY, RERANK_PROBE_TEXTS } from '../src/main/rerank-provider';
import { RerankService } from '../src/main/rerank-service';
import { AuxiliaryModels } from '../src/main/auxiliary-models';
import type { AuxiliaryModelConnection } from '../src/shared/contracts';
import type { RerankProvider } from '../src/core/knowledge';
import { WAIT_LIMIT } from './wait';

const codec = { encrypt: (s: string) => Buffer.from('encoded:' + s), decrypt: (b: Buffer) => b.toString().slice(8) };
type Request = Parameters<RerankProvider['rerank']>[0];
function profile(url: string, type = 'vllm_rerank'): AuxiliaryModelConnection {
  const common = { timeout: 2 };
  return { id: randomUUID(), kind: 'rerank', name: '虚构测试', type, hasKey: true, parameters: type === 'nvidia_rerank'
    ? { ...common, nvidia_rerank_api_base: url, nvidia_rerank_model: 'nvidia/mock-reranker', nvidia_rerank_model_endpoint: '/reranking', nvidia_rerank_truncate: 'NONE' }
    : type === 'tei_rerank' ? { ...common, rerank_api_base: url, tei_rerank_truncate: false, tei_rerank_truncation_direction: 'Right', tei_rerank_raw_scores: true, tei_rerank_return_text: false }
    : { ...common, rerank_api_base: url, rerank_model: 'mock-reranker', ...(type === 'vllm_rerank' ? { rerank_api_suffix: '/v1/rerank' } : {}), ...(type === 'bailian_rerank' ? { return_documents: true, instruct: 'Retrieve passages answering this fictional question.' } : {}) } };
}
function request(): Request {
  const projectId = randomUUID();
  return { projectId, query: RERANK_PROBE_QUERY, topK: 2, candidates: RERANK_PROBE_TEXTS.map((text, index) => ({ chunk: { id: `fictional-${index}`, projectId, corpus: 'canon', sourcePath: `虚构资料/${index}.md`, sourceHash: String(index).repeat(64), startParagraph: index, endParagraph: index, text, confirmed: true }, score: 0.1 * index, embeddingFingerprint: 'a'.repeat(64) })) };
}
async function mock(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer(handler); await listenLocalHttp(server);
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-rerank-test-'));
  t.after(async () => { assert.match(path.relative(os.tmpdir(), dir), /^novel-rerank-test-[^\\/]+$/); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
const waitFor = async (predicate: () => boolean) => { const end = Date.now() + WAIT_LIMIT; while (!predicate()) { if (Date.now() > end) throw new Error('mock request timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('五类重排序HTTP契约、来源映射、原始负logit、稳定排序及配置/请求快照', async t => {
  const calls: { url: string; body: any; auth: string | undefined }[] = [];
  const url = await mock(t, async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; calls.push({ url: req.url!, body: JSON.parse(raw), auth: req.headers.authorization });
    const ranks = [{ index: 0, relevance_score: 0.5, document: { text: '不可采用的服务端替换' } }, { index: 1, relevance_score: 0.9 }];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url!.endsWith('/reranking') ? { rankings: [{ index: 2, logit: -4 }, { index: 0, logit: -1 }, { index: 1, logit: 2 }] }
      : req.url === '/prefix/rerank' ? [{ index: 2, score: -3, text: '不可采用的服务端替换' }, { index: 1, score: 0.5 }, { index: 0, score: 0.5 }]
      : req.url!.endsWith('/text-rerank') ? { output: { results: ranks } } : { results: ranks }));
  });
  for (const type of ['vllm_rerank', 'xinference_rerank', 'bailian_rerank', 'nvidia_rerank', 'tei_rerank']) {
    const p = profile(url + (type === 'bailian_rerank' ? '/prefix/text-rerank' : '/prefix'), type), input = request(), original = structuredClone(input);
    const provider = new HttpRerankProvider(p, 'fictional-key'), pending = provider.rerank(input, AbortSignal.timeout(3000));
    p.parameters.timeout = 0; p.parameters.rerank_api_base = 'https://untrusted.invalid'; input.candidates[0].chunk.text = '后来改动的虚构内容'; input.candidates[0].chunk.projectId = randomUUID();
    const result = await pending, expected = type === 'tei_rerank' ? [0, 1] : [1, 0];
    assert.deepEqual(result.map(hit => hit.chunk), expected.map(index => original.candidates[index].chunk));
    assert.deepEqual(result.map(hit => hit.embeddingFingerprint), ['a'.repeat(64), 'a'.repeat(64)]);
    assert.deepEqual(result.map(hit => hit.score), type === 'nvidia_rerank' ? [2, -1] : type === 'tei_rerank' ? [0.5, 0.5] : [0.9, 0.5]);
    const call = calls.at(-1)!; assert.equal(call.auth, 'Bearer fictional-key'); assert.ok(!call.url.includes('fictional-key')); assert.equal(call.body.timeout, undefined);
    if (type === 'nvidia_rerank') { assert.equal(call.url, '/prefix/nvidia/mock-reranker/reranking'); assert.deepEqual(call.body.query, { text: original.query }); assert.deepEqual(call.body.passages, original.candidates.map(c => ({ text: c.chunk.text }))); assert.equal(call.body.truncate, 'NONE'); assert.equal(call.body.top_n, undefined); }
    else if (type === 'tei_rerank') { assert.equal(call.url, '/prefix/rerank'); assert.deepEqual(call.body.texts, original.candidates.map(c => c.chunk.text)); assert.equal(call.body.raw_scores, true); assert.equal(call.body.truncation_direction, 'Right'); assert.equal(call.body.truncate, false); assert.equal(call.body.return_text, false); assert.equal(call.body.model, undefined); }
    else if (type === 'bailian_rerank') { assert.equal(call.url, '/prefix/text-rerank'); assert.deepEqual(call.body.input, { query: original.query, documents: original.candidates.map(c => c.chunk.text) }); assert.equal(call.body.parameters.top_n, 2); assert.equal(call.body.parameters.return_documents, true); assert.equal(call.body.parameters.instruct, 'Retrieve passages answering this fictional question.'); }
    else { assert.equal(call.url, '/prefix/v1/rerank'); assert.deepEqual(call.body.documents, original.candidates.map(c => c.chunk.text)); assert.equal(call.body.query, original.query); assert.equal(call.body.top_n, 2); assert.equal(call.body.return_documents, false); assert.equal(call.body.model, 'mock-reranker'); assert.equal(call.body.launch_model_if_not_running, undefined); }
  }
  assert.equal(calls.length, 5);
});

test('串书/串用途/未确认正史/重复ID/坏来源/限量/路径逃逸在重排序网络调用前拒绝', async t => {
  let calls = 0; const url = await mock(t, (_, res) => { calls++; res.end('{}'); }), p = profile(url), provider = new HttpRerankProvider(p, 'fake');
  for (const mutate of [
    (r: Request) => r.candidates[0].chunk.projectId = randomUUID(), (r: Request) => r.candidates[0].chunk.corpus = 'style-reference',
    (r: Request) => r.candidates[0].chunk.confirmed = false, (r: Request) => r.candidates[0].chunk.id = r.candidates[1].chunk.id,
    (r: Request) => r.candidates[0].chunk.sourcePath = r.candidates[1].chunk.sourcePath,
    (r: Request) => r.candidates[0].chunk.sourceHash = 'bad', (r: Request) => r.candidates[0].chunk.endParagraph = -1,
    (r: Request) => r.candidates[0].score = Infinity, (r: Request) => r.query = '   ', (r: Request) => r.topK = 4,
    (r: Request) => r.candidates = Array.from({ length: 101 }, () => r.candidates[0]),
    (r: Request) => r.candidates = Array.from({ length: 20 }, (_, index) => ({ ...r.candidates[0], chunk: { ...r.candidates[0].chunk, id: `id-${index}`, text: '汉'.repeat(16000) } }))
  ]) { const input = request(); mutate(input); await assert.rejects(provider.rerank(input, AbortSignal.timeout(1000)), /重排序/); }
  for (const suffix of ['https://untrusted.invalid/rerank', '//untrusted.invalid', '/../rerank', '/x/../rerank', '/%2e%2e/rerank', '/a%2Fb', '/a\\b', '/rerank?key=secret', '/rerank#fragment', '/rerank\n']) {
    const bad = profile(url); bad.parameters.rerank_api_suffix = suffix; await assert.rejects(new HttpRerankProvider(bad, 'fake').rerank(request(), AbortSignal.timeout(1000)), /重排序/);
  }
  const badNvidia = profile(url, 'nvidia_rerank'); badNvidia.parameters.nvidia_rerank_model_endpoint = 'reranking'; await assert.rejects(new HttpRerankProvider(badNvidia, 'fake').rerank(request(), AbortSignal.timeout(1000)), /路径/);
  const external = profile('http://example.invalid'); await assert.rejects(new HttpRerankProvider(external, 'fake').rerank(request(), AbortSignal.timeout(1000)), /地址/);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(provider.rerank(request(), aborted.signal));
  assert.equal(calls, 0);
});

test('重排序拒绝重复/越界/缺失/非有限分数及部分整批响应，原候选保持', async t => {
  let value: unknown = null; const url = await mock(t, (_, res) => { res.end(typeof value === 'string' ? value : JSON.stringify(value)); });
  const p = profile(url), provider = new HttpRerankProvider(p, 'fake'), input = request(), original = structuredClone(input);
  for (const result of [ { results: [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] },
    { results: [{ index: 3, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }, { results: [{ index: 1.5, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] },
    { results: [{ relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }, { results: [{ index: 0, relevance_score: '0.9' }, { index: 1, relevance_score: 0.1 }] },
    { results: [{ index: 0, relevance_score: null }, { index: 1, relevance_score: 0.1 }] }, { results: [{ index: 0, relevance_score: 0.9 }] },
    { results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }, { index: 2, relevance_score: 0.2 }] }, 'not-json', '{"results":[{"index":0,"relevance_score":1e999},{"index":1,"relevance_score":0.1}]}' ]) {
    value = result; await assert.rejects(provider.rerank(input, AbortSignal.timeout(2000)), /重排序/); assert.deepEqual(input, original);
  }
  value = [{ index: 0, score: 0.9 }, { index: 1, score: 0.1 }]; await assert.rejects(new HttpRerankProvider(profile(url, 'tei_rerank'), 'fake').rerank(input, AbortSignal.timeout(2000)), /数量/);
  value = { rankings: [{ index: 0, logit: 0.9 }, { index: 1, logit: -1 }] }; await assert.rejects(new HttpRerankProvider(profile(url, 'nvidia_rerank'), 'fake').rerank(input, AbortSignal.timeout(2000)), /数量/);
});

test('重排序响应4MiB/无效UTF8/重定向/超时/HTTP错误不采用且不回显服务端机密', async t => {
  let mode = 'huge', redirectCalls = 0;
  const url = await mock(t, (req, res) => {
    if (req.url === '/redirect-target') { redirectCalls++; res.end('{}'); return; }
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', '/redirect-target'); res.end(); }
    else if (mode === 'huge') res.end('x'.repeat(4 * 1024 * 1024 + 1));
    else if (mode === 'utf8') res.end(Buffer.from([0xff, 0xfe]));
    else if (mode === 'timeout') { /* Keep open until the client timeout; fixture closes it. */ }
    else if (mode === 'body-timeout') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }
    else { res.statusCode = 401; res.end('fictional-key/private/provider/error'); }
  });
  const p = profile(url); p.parameters.timeout = 1; const provider = new HttpRerankProvider(p, 'fictional-key');
  for (const next of ['huge', 'utf8', 'redirect', 'timeout', 'body-timeout', 'error']) { mode = next; await assert.rejects(provider.rerank(request(), AbortSignal.timeout(2500)), e => { assert.ok(e instanceof Error); assert.ok(!e.message.includes('fictional-key')); assert.ok(!e.message.includes('private/provider')); return true; }); }
  assert.equal(redirectCalls, 0);
});

test('显式重排序探测仅虚构文本且不改配置；迟到配置/错会话/取消/并发均保护', async t => {
  const calls: any[] = []; let release: (() => void) | undefined, delaying = false;
  const url = await mock(t, async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; calls.push(JSON.parse(raw)); if (delaying) await new Promise<void>(r => release = r);
    res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.9 }] }));
  });
  t.after(() => release?.()); const dir = await fixture(t), models = new AuxiliaryModels(dir, codec), p = profile(url);
  const { id: _id, hasKey: _key, ...edit } = p; let snapshot = await models.save({ ...edit, apiKey: 'fictional-key' }, ''), id = snapshot.connections[0].id;
  const service = new RerankService(models), raw = await fs.readFile(path.join(dir, 'auxiliary-models.json')), sessionId = randomUUID();
  const result = await service.test(id, snapshot.hash, sessionId); assert.equal(result.connectionId, id); assert.equal(result.requestId, sessionId); assert.equal(result.projectId, RERANK_PROBE_PROJECT_ID); assert.equal(result.candidateCount, 3); assert.deepEqual(result.results, [{ index: 1, score: 0.9 }, { index: 0, score: 0.5 }]); assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(calls[0].documents, [...RERANK_PROBE_TEXTS]); assert.equal(calls[0].query, RERANK_PROBE_QUERY); assert.equal(calls[0].top_n, 2); assert.deepEqual(await fs.readFile(path.join(dir, 'auxiliary-models.json')), raw);
  delaying = true; const stale = service.test(id, snapshot.hash, randomUUID()); await waitFor(() => calls.length === 2);
  await assert.rejects(service.test(id, snapshot.hash, randomUUID()), /正在运行/); assert.throws(() => service.cancel(randomUUID()), /不匹配/);
  snapshot = await models.save({ ...edit, id, name: '更新虚构配置' }, snapshot.hash); release!(); await assert.rejects(stale, /配置已更新/);
  const requestId = randomUUID(), canceled = service.test(id, snapshot.hash, requestId); await waitFor(() => calls.length === 3); service.cancel(requestId); await assert.rejects(canceled, /已停止/); release!();
  assert.throws(() => service.cancel(requestId), /已结束/); delaying = false;
  await assert.rejects(service.test(id, 'stale-hash', randomUUID()), /配置已更新/); assert.equal(calls.length, 3);
  assert.equal((await service.test(id, snapshot.hash, randomUUID())).results[0].index, 1);
});

test('重排序服务失败只返回安全信息，嵌入类别拒绝且不联网', async t => {
  let calls = 0; const url = await mock(t, (_, res) => { calls++; res.statusCode = 403; res.end('fictional-secret-key/private'); });
  const models = new AuxiliaryModels(await fixture(t), codec), p = profile(url), { id: _id, hasKey: _key, ...edit } = p;
  let snapshot = await models.save({ ...edit, apiKey: 'fictional-secret-key' }, ''); const service = new RerankService(models);
  await assert.rejects(service.test(snapshot.connections[0].id, snapshot.hash, randomUUID()), e => { assert.ok(e instanceof Error); assert.match(e.message, /HTTP 403/); assert.ok(!e.message.includes('fictional-secret-key')); assert.ok(!e.message.includes('private')); return true; });
  snapshot = await models.save({ kind: 'embedding', type: 'ollama_embedding', name: '仅嵌入虚构模型', parameters: { embedding_api_base: url, embedding_model: 'mock', embedding_dimensions: 3, timeout: 2 } }, snapshot.hash);
  await assert.rejects(service.test(snapshot.connections[1].id, snapshot.hash, randomUUID()), /不能将/); assert.equal(calls, 1);
});

test('重排序准备阶段已锁定会话，取消后不发HTTP，随后允许新测试', async t => {
  let calls = 0, release: (() => void) | undefined;
  const url = await mock(t, (_, res) => { calls++; res.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }, { index: 1, relevance_score: 0.9 }] })); });
  const p = profile(url);
  const models = { resolve: async () => { await new Promise<void>(r => release = r); return { profile: p, key: '' }; }, read: async () => ({ hash: 'frozen-hash' }) } as unknown as AuxiliaryModels;
  const service = new RerankService(models), requestId = randomUUID(), pending = service.test(p.id, 'frozen-hash', requestId);
  await waitFor(() => release !== undefined); await assert.rejects(service.test(p.id, 'frozen-hash', randomUUID()), /正在运行/);
  assert.throws(() => service.cancel(randomUUID()), /不匹配/); service.cancel(requestId); release!(); await assert.rejects(pending, /已停止/); assert.equal(calls, 0);
  const next = service.test(p.id, 'frozen-hash', randomUUID()); release!(); assert.equal((await next).candidateCount, 3); assert.equal(calls, 1);
});
