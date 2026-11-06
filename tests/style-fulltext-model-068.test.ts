import { listenLocalHttp } from './support/local-http';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { AIService } from '../src/main/ai-service';
import type { AIConnections } from '../src/main/ai-connections';
import { splitModelStyleText } from '../src/core/style-model-split';

function sse(text: string, finish = 'stop') {
  const data = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n';
  return Buffer.from(data, 'utf8');
}

async function server(options: { failCall?: number; longNotes?: boolean; failLayer?: number; truncateLayer?: boolean; multiLayer?: boolean; failDeep?: boolean } = {}) {
  const state = { failAllChunks: false, failIndex: 0, statusForChunks: 0, statusIndex: 0, maxRequestBytes: 0 };
  const messages: string[] = [];
  let layerCalls = 0;
  const calls: string[] = [];
  let chunkCalls = 0;
  const instance = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); const system = String(body.messages?.[0]?.content ?? '');
    calls.push(system.slice(0, 12));
    const userMessage = String(body.messages?.[1]?.content ?? ''); messages.push(userMessage);
    state.maxRequestBytes = Math.max(state.maxRequestBytes, Buffer.byteLength(system) + Buffer.byteLength(userMessage) + 256 + (body.max_tokens ?? 0));
    const isChunk = system.includes('这一段参考文本');
    const isLayer = system.includes('压缩成不超过 1200 字');
    if (isChunk && state.failIndex && userMessage.includes('第 ' + state.failIndex + '/')) { res.writeHead(500); res.end('fixture failure'); return; }
    if (isChunk && state.statusForChunks && (!state.statusIndex || userMessage.includes('第 ' + state.statusIndex + '/'))) { res.writeHead(state.statusForChunks); res.end('fixture refusal'); return; }
    if (state.failAllChunks && isChunk) { res.writeHead(500); res.end('fixture failure'); return; }
    if (isChunk) chunkCalls += 1;
    if (isLayer) layerCalls += 1;
    if (options.failDeep && isLayer && userMessage.includes('【分层汇总') && !(state as any).deepFailed) { (state as any).deepFailed = true; res.writeHead(500); res.end('fixture deep failure'); return; }
    if (options.failLayer && isLayer && layerCalls === options.failLayer && !(state as any).layerFailed) { (state as any).layerFailed = true; res.writeHead(500); res.end('fixture failure'); return; }
    if (options.failCall && isChunk && chunkCalls === options.failCall) { res.writeHead(500); res.end('fixture failure'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = isLayer ? (options.multiLayer ? '略。'.repeat(400) : '压缩要点：短句为主，对白密集，段落短。') : isChunk ? (options.longNotes ? '本段短句为主，对白密集。' + '细节说明。'.repeat(400) : '本段短句为主，对白密集。') : JSON.stringify({ rules: ['保持短句推进', '对白后补动作', '段落短而清晰'], limitations: [] });
    res.end(sse(reply, isLayer && options.truncateLayer ? 'length' : 'stop'));
  });
  await listenLocalHttp(instance);
  const port = (instance.address() as { port: number }).port;
  return { calls, messages, state, url: 'http://127.0.0.1:' + port + '/v1', close: async () => { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); } };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-style-model-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const parent = path.join(root, 'books'); await fs.mkdir(parent);
  const project = await workspace.createProject(parent, '分段模型书');
  const library = new LibraryStore(id => workspace.getProject(id), path.join(root, 'materials'));
  const characters = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  let book = await library.read(project.project.id);
  const long = Array.from({ length: 900 }, (_, index) => index % 3 === 0 ? '“第' + index + '句对白。”他说。' : '第' + index + '段叙述，用来撑长文本并保持句式变化，包含补充说明与细节描写。').join('\n');
  book = await library.addSources(project.project.id, [{ name: '长篇.txt', text: long }], book.hash);
  return { root, workspace, project, library, characters, book };
}

async function waitDone(service: AIService, projectId: string, id: string) {
  let current: any = null;
  for (let i = 0; i < 150; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    current = (await service.list(projectId)).find(item => item.id === id);
    if (current && current.status !== 'running') return current;
  }
  return current;
}

test('全文分段模型分析：逐段调用 + 一次汇总，覆盖与进度写入任务', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 32000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceId = f.book.value.sources[0]!.id;

  const plan = await f.library.stylePlanPreview(f.project.project.id, [sourceId], f.book.hash, 9000);
  assert.ok(plan.chunks > 1, '预估应切成多段');
  assert.equal(plan.estimatedRequests, plan.chunks + 1, '预计调用 = 段数 + 汇总');
  assert.ok(plan.largestChunkCharacters >= plan.smallestChunkCharacters);
  assert.ok(plan.totalCharacters > 10000);

  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '分段文风', sourceIds: [sourceId], expectedHash: f.book.hash, mode: 'full' });
  assert.equal(task.styleSource?.mode, 'full');
  assert.ok((task.styleSource?.chunks ?? 0) > 1, '应切成多段');
  const current = await waitDone(service, f.project.project.id, task.id);
  assert.equal(current.status, 'complete', current?.error);
  assert.equal(current.styleSource?.analyzed, current.styleSource?.chunks, '每段都应记录进度');
  assert.equal(srv.calls.length, (current.styleSource?.chunks ?? 0) + 1, '逐段调用 + 一次汇总');
  assert.match(current.text, /rules/u);
});

test('全文分段模型分析：单段失败会重试一次，其余段与汇总照常完成并记录失败段', async t => {
  const f = await fixture(); const srv = await server({ failCall: 2 });
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 32000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceId = f.book.value.sources[0]!.id;
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '重试文风', sourceIds: [sourceId], expectedHash: f.book.hash, mode: 'full' });
  const current = await waitDone(service, f.project.project.id, task.id);
  assert.equal(current.status, 'complete', current?.error);
  assert.equal(current.error, '', '重试成功后不应残留失败提示');
  assert.equal(srv.calls.length, (current.styleSource?.chunks ?? 0) + 2, '失败一次 + 重试一次，再加汇总');
});

test('全文分段：全部段失败后可从断点恢复，只补未完成段并完成汇总', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  srv.state.failAllChunks = true;
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 32000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceId = f.book.value.sources[0]!.id;
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '断点文风', sourceIds: [sourceId], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.notEqual(failed.status, 'complete');
  assert.match(String(failed.error), /模型分段未全部完成/u);
  const before = srv.calls.length;
  srv.state.failAllChunks = false;
  const resumed = await service.resumeStyleLearning(f.project.project.id, task.id);
  assert.equal(resumed.status, 'running');
  const done = await waitDone(service, f.project.project.id, task.id);
  assert.equal(done.status, 'complete', done.error);
  assert.ok(srv.calls.length > before, '恢复后应继续发起调用');
  assert.match(done.text, /rules/u);
});

test('全文分段：来源内容变化后断点恢复被拒绝', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  srv.state.failAllChunks = true;
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 32000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceId = f.book.value.sources[0]!.id;
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '变化文风', sourceIds: [sourceId], expectedHash: f.book.hash, mode: 'full' });
  await waitDone(service, f.project.project.id, task.id);
  srv.state.failAllChunks = false;
  const sourceFile = path.join(f.project.root, '小说资料', 'style-sources', sourceId + '.txt');
  await fs.writeFile(sourceFile, '内容被外部改写', 'utf8');
  await assert.rejects(service.resumeStyleLearning(f.project.project.id, task.id), /已变化/u);
});

test('全文分段模型分析：笔记超出预算时先分层压缩，再最终汇总', async t => {
  const f = await fixture(); const srv = await server({ longNotes: true });
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 9000, maxOutputTokens: 800, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceId = f.book.value.sources[0]!.id;
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '分层文风', sourceIds: [sourceId], expectedHash: f.book.hash, mode: 'full', chunkCharacters: 3000 });
  const current = await waitDone(service, f.project.project.id, task.id);
  assert.equal(current.status, 'complete', current?.error);
  const chunks = current.styleSource?.chunks ?? 0, layers = current.styleSource?.layers ?? 0;
  assert.ok(chunks > 3, '应切成多段');
  assert.ok(layers >= 2, '笔记超预算时应至少分两层压缩，实际 ' + layers);
  assert.ok(srv.state.maxRequestBytes <= profile.contextWindow, '每次请求都必须在保守 UTF-8 预算内');
  assert.equal(srv.calls.length, chunks + layers + 1, '调用数 = 分段 + 分层压缩 + 最终汇总');
  assert.match(current.text, /rules/u);
});

test('全文分段：分层压缩中途失败后，续跑跳过已完成层', async t => {
  const f = await fixture(); const srv = await server({ longNotes: true, failLayer: 2 });
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 9000, maxOutputTokens: 800, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceId = f.book.value.sources[0]!.id;
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '分层续跑', sourceIds: [sourceId], expectedHash: f.book.hash, mode: 'full', chunkCharacters: 3000 });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.equal(failed.status, 'failed');
  const kept = failed.styleSource?.layerNotes ?? [];
  assert.ok(kept.length >= 1, '失败前完成的层应被保存');
  const callsBefore = srv.calls.length;
  const resumed = await service.resumeStyleLearning(f.project.project.id, task.id);
  const done = await waitDone(service, f.project.project.id, resumed.id);
  assert.equal(done.status, 'complete', done?.error);
  const calls = srv.calls.length - callsBefore;
  const layers = failed.styleSource?.layers ?? 0;
  assert.equal(calls, (layers - kept.length) + 1, '续跑只补未完成的层与最终汇总，实际 ' + calls);
  assert.ok(calls < layers + 1, '不能重跑已完成的层');
  assert.match(done.text, /rules/u);
});

test('分段部分失败不能汇总或保存，配置不一致不能续跑，恢复后按原顺序汇总', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  srv.state.failIndex = 2;
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  let key = 'fixture-key';
  const connections = { resolve: async () => ({ profile, key }), read: async () => ({ hash: '', connections: [profile] }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '故障文风', sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /第 2 段失败/u);
  assert.equal(failed.styleSource.analyzed, failed.styleSource.chunks - 1);
  assert.equal(srv.calls.length, failed.styleSource.chunks + 1, '失败分段重试一次，不能请求汇总');
  await assert.rejects(service.confirmStyleLearning(f.project.project.id, task.id, '故障文风', '规则', f.book.hash), /完整/u);
  const before = srv.calls.length;
  profile.model = 'other-model';
  await assert.rejects(service.resumeStyleLearning(f.project.project.id, task.id), /配置或密钥已变化/u);
  profile.model = 'fixture-model'; key = 'other-key';
  await assert.rejects(service.resumeStyleLearning(f.project.project.id, task.id), /配置或密钥已变化/u);
  assert.equal(srv.calls.length, before, '配置变化不得发出请求');
  key = 'fixture-key'; srv.state.failIndex = 0;
  await service.resumeStyleLearning(f.project.project.id, task.id);
  const done = await waitDone(service, f.project.project.id, task.id);
  assert.equal(done.status, 'complete', done.error);
  assert.equal(srv.calls.length - before, 2, '只补失败段并汇总');
  const merged = srv.messages.at(-1)!;
  const positions = Array.from({ length: done.styleSource.chunks }, (_, i) => merged.indexOf('【第 ' + (i + 1) + '/'));
  assert.ok(positions.every((value, i) => value >= 0 && (i === 0 || value > positions[i - 1]!)), '汇总笔记必须保持来源顺序');
  const saved = await service.confirmStyleLearning(f.project.project.id, task.id, '故障文风', '保持短句推进', f.book.hash);
  assert.ok(saved.value.styles.some(style => style.name === '故障文风'));
});

test('旧记录即使误标完成，缺少分段时也不能保存或绕过模型配置安全续跑', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  srv.state.failIndex = 2;
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '旧任务', sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  failed.status = 'complete'; failed.text = JSON.stringify({ rules: ['短句'], limitations: [] });
  delete failed.styleSource.connectionSalt; delete failed.styleSource.connectionFingerprint;
  await (service as any).persist(failed);
  const before = srv.calls.length;
  await assert.rejects(service.confirmStyleLearning(f.project.project.id, task.id, '旧任务', '规则', f.book.hash), /分段记录不完整/u);
  await assert.rejects(service.resumeStyleLearning(f.project.project.id, task.id), /旧任务没有模型配置校验/u);
  assert.equal(srv.calls.length, before);
});


test('模型分段逐字覆盖短尾段、换行及 Unicode，不破坏其他全文分段器', async t => {
  const input = '甲'.repeat(999) + '😀' + '\r\n' + '乙'.repeat(1001) + '\n终';
  const pieces = splitModelStyleText(input, 1000);
  assert.equal(pieces.join(''), input);
  assert.ok(pieces.every(part => part.length <= 1000));
  assert.ok(pieces.every(part => !/[\uD800-\uDBFF]$/u.test(part) && !/^[\uDC00-\uDFFF]/u.test(part)));
  assert.ok(pieces.every(part => !part.endsWith('\r')));
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  const updated = await f.library.addSources(f.project.project.id, [{ name: '短篇.txt', text: input }, { name: '极短.txt', text: '短尾' }], f.book.hash);
  const ids = updated.value.sources.slice(-2).map(item => item.id);
  const plan = await f.library.styleChunks(f.project.project.id, ids, updated.hash, 1000);
  assert.equal(plan.chunks.filter(chunk => chunk.name === '短篇.txt').map(chunk => chunk.text).join(''), input);
  assert.equal(plan.chunks.filter(chunk => chunk.name === '极短.txt').map(chunk => chunk.text).join(''), '短尾');
  assert.equal(plan.totalCharacters, input.length + 2);
});


test('分层压缩输出被截断时保留分段，禁止汇总', async t => {
  const f = await fixture(); const srv = await server({ longNotes: true, truncateLayer: true });
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 9000, maxOutputTokens: 800, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '截断文风', sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /分层压缩未完整结束/u);
  assert.equal(failed.styleSource.chunkNotes.length, failed.styleSource.chunks);
  assert.equal(failed.styleSource.layerNotes?.length ?? 0, 0);
  assert.equal(srv.calls.length, failed.styleSource.chunks + 1, '不能对截断的压缩结果做最终汇总');
});


test('预估复用模型窗口与完整分段，模型变化时启动前拒绝且不发网络请求', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '预估夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const sourceIds = [f.book.value.sources[0]!.id];
  const preview = await service.previewStyleLearning(f.project.project.id, sourceIds, f.book.hash, profile.id);
  assert.equal(srv.calls.length, 0, '预估只在本机执行');
  assert.equal(preview.model, profile.model); assert.equal(preview.estimatedRequests, preview.chunks + 1);
  profile.contextWindow = 18000;
  const request = { projectId: f.project.project.id, connectionId: profile.id, name: '预估文风', sourceIds, expectedHash: f.book.hash, mode: 'full' as const, expectedPlanFingerprint: preview.planFingerprint };
  await assert.rejects(service.startStyleLearning(request), /重新预估/u);
  assert.equal(srv.calls.length, 0, '预估过期不能发送请求');
  profile.contextWindow = 14000;
  const task = await service.startStyleLearning(request);
  assert.equal(task.styleSource?.chunks, preview.chunks);
  assert.equal(task.styleSource?.chunkCharacters, preview.chunkCharacters);
  const done = await waitDone(service, f.project.project.id, task.id);
  assert.equal(done.status, 'complete', done.error);
});


test('超长文风笔记可多层压缩，深层失败后只继续未完成组', async t => {
  const f = await fixture(); const srv = await server({ longNotes: true, multiLayer: true, failDeep: true });
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 9000, maxOutputTokens: 800, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '多层文风', sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.styleSource.chunkNotes.length, failed.styleSource.chunks);
  assert.ok(failed.styleSource.mergeLevels[0].length > 1, '第一层要有多个压缩组');
  const saved = [...failed.styleSource.mergeLevels[0]];
  const before = srv.calls.length;
  const simultaneous = await Promise.allSettled([service.resumeStyleLearning(f.project.project.id, task.id), service.resumeStyleLearning(f.project.project.id, task.id)]);
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1, '同一任务不可并发续跑');
  assert.match(String((simultaneous.find(result => result.status === 'rejected') as PromiseRejectedResult).reason), /已有 AI 任务/u);
  const done = await waitDone(service, f.project.project.id, task.id);
  assert.equal(done.status, 'complete', done.error);
  assert.ok(done.styleSource.mergeLevels.length > 1, '实际执行多层压缩');
  assert.deepEqual(done.styleSource.mergeLevels[0], saved, '续跑保留第一层结果');
  assert.ok(srv.calls.length > before);
  assert.ok(srv.state.maxRequestBytes <= profile.contextWindow);
});


test('模型认证或额度错误立即停止，不对所有分段重复收费请求', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  for (const [status, expected] of [[400, /格式、地址或参数/u], [401, /认证或权限/u], [402, /余额或付款/u], [403, /认证或权限/u], [404, /格式、地址或参数/u], [413, /格式、地址或参数/u], [422, /格式、地址或参数/u], [429, /限流或余额不足/u]] as const) {
    srv.state.statusForChunks = status; const before = srv.calls.length;
    const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '连接失败' + status, sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
    const failed = await waitDone(service, f.project.project.id, task.id);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, expected);
    assert.equal(srv.calls.length - before, 1, '全局连接错误不应重试每段');
    assert.equal(failed.styleSource.chunkNotes.length, 0);
  }
});


test('中途限流保留完成分段，额度恢复后只补剩余分段', async t => {
  const f = await fixture(); const srv = await server();
  t.after(async () => { await srv.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: srv.url, adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 30, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  srv.state.statusForChunks = 429; srv.state.statusIndex = 2;
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '额度中断', sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /限流或余额不足/u);
  assert.equal(srv.calls.length, 2); assert.deepEqual(failed.styleSource.chunkNotes.map((item: any) => item.index), [1]);
  const before = srv.calls.length; srv.state.statusForChunks = 0;
  await service.resumeStyleLearning(f.project.project.id, task.id);
  const done = await waitDone(service, f.project.project.id, task.id);
  assert.equal(done.status, 'complete', done.error);
  assert.equal(srv.calls.length - before, done.styleSource.chunks, '剩余分段加汇总');
});


test('服务不可连接时停止全文分段并提示检查网络', async t => {
  const f = await fixture(); t.after(async () => fs.rm(f.root, { recursive: true, force: true }));
  // Bind and close a local port to obtain an endpoint with no listening server.
  const probe = http.createServer(); await listenLocalHttp(probe);
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const profile = { id: crypto.randomUUID(), name: '夹具', model: 'fixture-model', baseUrl: 'http://127.0.0.1:' + port + '/v1', adapter: 'generic' as const, thinking: 'default' as const, timeoutSeconds: 2, contextWindow: 14000, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, hasKey: false };
  const connections = { resolve: async () => ({ profile, key: '' }) } as unknown as AIConnections;
  const service = new AIService(path.join(f.root, 'state'), connections, f.workspace, f.library, f.characters);
  const task = await service.startStyleLearning({ projectId: f.project.project.id, connectionId: profile.id, name: '连接失败', sourceIds: [f.book.value.sources[0]!.id], expectedHash: f.book.hash, mode: 'full' });
  const failed = await waitDone(service, f.project.project.id, task.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /模型连接失败/u);
  assert.equal(failed.styleSource.chunkNotes.length, 0);
});
