import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AIConnections } from '../src/main/ai-connections';
import { ModelDiscoveryService } from '../src/main/model-discovery';
import { streamChat } from '../src/main/ai-provider';
import { AuxiliaryModels } from '../src/main/auxiliary-models';
import { astrbotTemplates, chatPresets } from '../src/shared/model-presets';
import { ExitSaveRegistry } from '../src/renderer/src/save-before-exit';
import type { AIConnection } from '../src/shared/contracts';

async function server(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) { const server = createServer(handle); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); })); return `http://127.0.0.1:${(server.address() as any).port}`; }
async function fixture(t: TestContext) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-providers-test-')); t.after(async () => { assert.match(path.relative(os.tmpdir(), dir), /^novel-providers-test-[^\\/]+$/); await fs.rm(dir, { recursive: true, force: true }); }); return dir; }
const codec = { encrypt: (s: string) => Buffer.from('encoded:' + s), decrypt: (b: Buffer) => b.toString().slice(8) };
const profile = (baseUrl: string, adapter: AIConnection['adapter']): AIConnection => ({ id: randomUUID(), name: '模拟连接', model: 'test-model', baseUrl, adapter, thinking: 'default', hasKey: true, timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 1000, tokenParameter: 'max_tokens' });
const event = (res: ServerResponse, value: unknown) => res.write('data: ' + JSON.stringify(value) + '\r\n\r\n');

test('Gemini/Claude原生请求、目录与系统角色映射，思考过滤、截断和断流不伪装成功', async t => {
  const calls: { url: string; headers: IncomingMessage['headers']; body: any }[] = []; let mode = 'stop';
  const url = await server(t, async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; calls.push({ url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/g/models' ? { models: [{ name: 'models/test-model', displayName: 'Gemini测试', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 32768 }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }] } : { data: [{ id: 'claude-test', display_name: 'Claude测试' }], has_more: false })); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url!.startsWith('/g/')) { event(res, { candidates: [{ index: 0, content: { parts: [{ text: '不应出现的思考', thought: true }, { text: '中文正文' }] } }] }); if (mode !== 'broken') event(res, { candidates: [{ index: 0, finishReason: mode === 'length' ? 'MAX_TOKENS' : 'STOP' }] }); }
    else { event(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '不应出现' } }); event(res, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '秘密' } }); event(res, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }); event(res, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Claude正文' } }); event(res, { type: 'message_delta', delta: { stop_reason: mode === 'length' ? 'max_tokens' : 'end_turn' } }); if (mode !== 'broken') event(res, { type: 'message_stop' }); }
    res.end();
  });
  const messages = [{ role: 'system' as const, content: '本书世界观' }, { role: 'user' as const, content: '虚构正文测试' }];
  for (const adapter of ['gemini', 'anthropic'] as const) {
    const p = profile(url + (adapter === 'gemini' ? '/g' : '/a'), adapter); let text = '';
    assert.equal(await streamChat(p, 'test-key', messages, AbortSignal.timeout(3000), s => text += s), 'stop'); assert.equal(text, adapter === 'gemini' ? '中文正文' : 'Claude正文');
    const call = calls.at(-1)!; assert.ok(!call.url.includes('test-key')); assert.equal(call.headers.authorization, undefined);
    if (adapter === 'gemini') { assert.equal(call.url, '/g/models/test-model:streamGenerateContent?alt=sse'); assert.equal(call.headers['x-goog-api-key'], 'test-key'); assert.equal(call.body.systemInstruction.parts[0].text, '本书世界观'); assert.equal(call.body.generationConfig.maxOutputTokens, 1000); }
    else { assert.equal(call.url, '/a/messages'); assert.equal(call.headers['x-api-key'], 'test-key'); assert.equal(call.headers['anthropic-version'], '2023-06-01'); assert.equal(call.body.system, '本书世界观'); assert.equal(call.body.messages.length, 1); }
    mode = 'length'; assert.equal(await streamChat(p, '', messages, AbortSignal.timeout(3000), () => {}), 'length'); mode = 'broken'; await assert.rejects(streamChat(p, '', messages, AbortSignal.timeout(3000), () => {}), /未收到完成/); mode = 'stop';
    const dir = await fixture(t), connections = new AIConnections(dir, codec), discovered = await new ModelDiscoveryService(connections).discover({ expectedHash: '', baseUrl: p.baseUrl, adapter, apiKey: 'test-key' });
    assert.equal(discovered.models.length, 1); assert.equal(discovered.models[0].id, adapter === 'gemini' ? 'test-model' : 'claude-test');
  }
});

test('原生协议保存与密钥保护、模型路径/重定向拒绝及旧配置不转发密钥', async t => {
  const dir = await fixture(t), connections = new AIConnections(dir, codec);
  const saved = await connections.save({ ...profile('https://generativelanguage.googleapis.com/', 'gemini'), apiKey: 'secret', id: undefined }, '');
  assert.equal(saved.connections[0].baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  await assert.rejects(connections.save({ ...saved.connections[0], adapter: 'anthropic' }, saved.hash), /重新填写/);
  await assert.rejects(connections.save({ ...saved.connections[0], thinking: 'enabled' }, saved.hash), /默认思考/);
  await assert.rejects(new ModelDiscoveryService(connections).discover({ connectionId: saved.connections[0].id, expectedHash: saved.hash, baseUrl: saved.connections[0].baseUrl, adapter: 'anthropic' }), /更换地址或协议/);
  await assert.rejects(streamChat({ ...saved.connections[0], model: '../bad?key=secret' }, '', [], AbortSignal.timeout(1000), () => {}), /ID无效/);
  const endpoint = await server(t, (_, res) => { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/'); res.end('secret'); });
  await assert.rejects(streamChat(profile(endpoint, 'anthropic'), 'secret', [], AbortSignal.timeout(1000), () => {}));
});

test('AstrBot五类嵌入/五类重排独立配置，密钥不回显、冲突/错类别/未知版本保护', async t => {
  const dir = await fixture(t), store = new AuxiliaryModels(dir, codec);
  for (const kind of ['embedding', 'rerank'] as const) { const templates = astrbotTemplates.filter(t => t.provider_type === kind); assert.equal(templates.length, 5); }
  const edit = { kind: 'embedding' as const, name: '本地嵌入', type: 'ollama_embedding', parameters: { embedding_api_base: 'http://localhost:11434', embedding_model: 'nomic-embed-text', embedding_dimensions: 768, timeout: 60 }, apiKey: 'fixture-only-key' };
  const saved = await store.save(edit, ''); assert.equal(saved.connections[0].hasKey, true); assert.ok(!JSON.stringify(saved).includes('fixture-only-key'));
  assert.equal(saved.connections[0].kind, 'embedding');
  await assert.rejects(store.save(edit, ''), /已更新/);
  await assert.rejects(store.save({ ...edit, kind: 'rerank' }, saved.hash), /对应类别/);
  await assert.rejects(store.save({ ...edit, parameters: { ...edit.parameters, api_key: 'accidental-secret' } }, saved.hash), /未支持/);
  await assert.rejects(store.save({ ...edit, id: saved.connections[0].id, parameters: { ...edit.parameters, embedding_api_base: 'http://127.0.0.1:11435' }, apiKey: '' }, saved.hash), /重新填写/);
  await store.save({ kind: 'rerank', name: '本地排序', type: 'tei_rerank', parameters: { rerank_api_base: 'http://127.0.0.1:8080', timeout: 20 } }, saved.hash);
  const unknown = '{"schemaVersion":99,"connections":[]}'; await fs.writeFile(path.join(dir, 'auxiliary-models.json'), unknown); await assert.rejects(store.read(), /原件保留/); assert.equal(await fs.readFile(path.join(dir, 'auxiliary-models.json'), 'utf8'), unknown);
  assert.ok(chatPresets.some(p => p.label === 'Ollama' && p.value.baseUrl === 'http://127.0.0.1:11434/v1' && p.available));
  assert.ok(chatPresets.some(p => p.label.startsWith('gemini-web2api') && p.value.adapter === 'generic'));
});

test('退出预检阻止忙碌/未确认内容，保存顺序正确且失败不继续退出', async () => {
  const registry = new ExitSaveRegistry(), calls: string[] = [];
  registry.register('正文', () => ({ dirty: true, busy: false, save: async () => { calls.push('正文'); } }));
  const remove = registry.register('未确认记忆', () => ({ dirty: true, busy: false, reason: '先核对摘要' }));
  assert.throws(() => registry.preflight(), /先核对摘要/); assert.equal(calls.length, 0); remove();
  const busy = registry.register('网络模型', () => ({ dirty: false, busy: true })); assert.throws(() => registry.preflight(), /正在处理/); busy();
  registry.register('模型设置', () => ({ dirty: true, busy: false, save: async () => { calls.push('配置'); throw Error('外部版本已更新'); } }));
  registry.register('后续', () => ({ dirty: true, busy: false, save: async () => { calls.push('后续'); } }));
  await assert.rejects(registry.saveAll(registry.preflight()), /窗口.*保留/); assert.deepEqual(calls, ['正文', '配置']);
});

test('gemini-web2api与Ollama兼容路由：免密/Bearer、模型后缀和标准SSE完整返回', async t => {
  const calls: { url: string; auth?: string; model?: string }[] = [];
  const url = await server(t, async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ url: req.url!, auth: req.headers.authorization, model: raw ? JSON.parse(raw).model : undefined });
    if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemini-3.5-flash-thinking@think=2', object: 'model' }] })); return; }
    res.setHeader('Content-Type', 'text/event-stream'); event(res, { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }); event(res, { choices: [{ index: 0, delta: { content: '本地适配测试正文' }, finish_reason: null }] }); event(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); res.end('data: [DONE]\n\n');
  });
  const dir = await fixture(t), connections = new AIConnections(dir, codec), discovery = new ModelDiscoveryService(connections);
  const list = await discovery.discover({ expectedHash: '', baseUrl: url + '/v1', adapter: 'generic' });
  for (const key of ['', 'gateway-test-key']) { const p = { ...profile(url + '/v1', 'generic'), model: list.models[0].id }; let output = ''; assert.equal(await streamChat(p, key, [{ role: 'user', content: '完全虚构测试' }], AbortSignal.timeout(1000), s => output += s), 'stop'); assert.equal(output, '本地适配测试正文'); }
  assert.deepEqual(calls.map(c => c.url), ['/v1/models', '/v1/chat/completions', '/v1/chat/completions']); assert.equal(calls[1].auth, undefined); assert.equal(calls[2].auth, 'Bearer gateway-test-key'); assert.equal(calls[2].model, 'gemini-3.5-flash-thinking@think=2');
});

test('原生模型目录有界分页、去重、思考测试无空系统指令与循环游标拒绝', async t => {
  const calls: string[] = []; let loop = false;
  const url = await server(t, (req, res) => { calls.push(req.url!); res.setHeader('Content-Type', 'application/json'); const second = req.url!.includes('?'); const m = { name: 'models/one', supportedGenerationMethods: ['generateContent'] }; res.end(JSON.stringify(req.url!.startsWith('/g/') ? { models: second ? [m, { ...m, name: 'models/two' }] : [m], nextPageToken: !second || loop ? 'next' : undefined } : { data: second ? [{ id: 'one' }, { id: 'two' }] : [{ id: 'one' }], has_more: !second || loop, last_id: 'one' })); });
  const connections = new AIConnections(await fixture(t), codec), service = new ModelDiscoveryService(connections);
  for (const adapter of ['gemini', 'anthropic'] as const) { const list = await service.discover({ expectedHash: '', baseUrl: url + (adapter === 'gemini' ? '/g' : '/a'), adapter }); assert.deepEqual(list.models.map(m => m.id), ['one', 'two']); }
  assert.deepEqual(calls, ['/g/models', '/g/models?pageToken=next', '/a/models', '/a/models?after_id=one']); loop = true;
  await assert.rejects(service.discover({ expectedHash: '', baseUrl: url + '/g', adapter: 'gemini' }), /分页信息异常/);
  await assert.rejects(service.discover({ expectedHash: '', baseUrl: url + '/compat', adapter: 'generic' }), /兼容分页/);
  const { chatBody } = await import('../src/main/ai-provider'); assert.ok(!('systemInstruction' in chatBody(profile(url, 'gemini'), [{ role: 'user', content: '测试' }])));
});
