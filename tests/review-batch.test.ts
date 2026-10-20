import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { AIConnections } from '../src/main/ai-connections';
import { AIService } from '../src/main/ai-service';
import { textDocument } from '../src/main/text-import';
import type { AITask } from '../src/shared/contracts';

const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const report = (quote: string, replacement: string) => JSON.stringify({ summary: '独立报告', issues: [{ category: '错别字', quote, replacement, reason: '理由', evidence: '' }] });

async function fixture(t: TestContext, options: { beforeReply?: (model: string) => Promise<void> } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-review-batch-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲', '乙'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲')), b = await workspace.attach(path.join(root, '乙'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  await library.read(a.id); await characters.read(a.id);
  const calls: string[] = []; const keys: (string | undefined)[] = []; let active = 0, maximum = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { model: string }; calls.push(body.model); keys.push(req.headers.authorization); active++; maximum = Math.max(maximum, active);
    const output = body.model === 'mock-r2' ? '不是 JSON' : report(body.model === 'mock-r3' ? '雨停了。' : '推开们', body.model === 'mock-r3' ? '雨停了。' : '推开门');
    const ollama = req.url?.endsWith('/api/chat'), responses = req.url?.endsWith('/responses');
    res.writeHead(200, { 'Content-Type': ollama ? 'application/x-ndjson' : 'text/event-stream' });
    const done = () => { active--; if (!res.destroyed) res.end(ollama ? JSON.stringify({ message: { content: output }, done: true, done_reason: 'stop' }) + '\n'
      : responses ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: output })}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n` : sse(output)); };
    if (options.beforeReply) await options.beforeReply(body.model);
    done();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const, contextWindow: 32768, maxOutputTokens: 2048, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let hash = ''; const ids: Record<string, string> = {};
  for (const model of ['mock-r1', 'mock-r2', 'mock-r3']) {
    const saved = await connections.save({ name: model, ...base, model, apiKey: `fictional-${model}` }, hash);
    hash = saved.hash; ids[model] = saved.connections.at(-1)!.id;
  }
  const service = new AIService(local, connections, workspace, library, characters);
  const chapter = await workspace.createChapter(a.id, textDocument('林夏推开们。\n雨停了。'));
  return { workspace, service, connections, a, b, chapter, calls, keys, ids, restart: () => new AIService(local, connections, workspace, library, characters), maximum: () => maximum, reset: () => { maximum = 0; } };
}
const request = (projectId: string, chapter: { path: string; hash: string }, connectionIds: string[]) => ({ projectId, chapterPath: chapter.path, sourceHash: chapter.hash, connectionIds, reviewFormat: 'issues' as const, instruction: '检查错别字与语病' });

test('手动批量审稿：按顺序逐模型各出一份独立报告，无重叠请求', async t => {
  const { service, a, chapter, calls, ids, maximum, reset } = await fixture(t);
  const first = await service.startReviewBatch(request(a.id, chapter, [ids['mock-r1'], ids['mock-r3']]));
  assert.equal(first.mode, 'review'); assert.equal(first.reviewFormat, 'issues');
  assert.deepEqual(calls, ['mock-r1', 'mock-r3']);
  assert.equal(maximum(), 1, '批量审稿必须依次执行，不能并发');
  const tasks = (await service.list(a.id)).filter((task: AITask) => task.mode === 'review');
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map(task => task.status), ['complete', 'complete']);
  assert.deepEqual(new Set(tasks.map(task => task.reviewTaskId)), new Set([undefined]));
  assert.ok(tasks.every(task => task.sourceHash === chapter.hash && task.sourceText.includes('推开们') && task.reviewDocumentHash));
  reset();
});

test('手动批量审稿：一个模型失败不影响其余模型，各自结果保留', async t => {
  const { service, a, chapter, calls, ids, maximum } = await fixture(t);
  await service.startReviewBatch(request(a.id, chapter, [ids['mock-r1'], ids['mock-r2'], ids['mock-r3']]));
  assert.deepEqual(calls, ['mock-r1', 'mock-r2', 'mock-r3']);
  assert.equal(maximum(), 1);
  const tasks = (await service.list(a.id)).filter((task: AITask) => task.mode === 'review');
  assert.equal(tasks.length, 3);
  assert.deepEqual(Object.fromEntries(tasks.map(task => [task.connection.model, task.status])), { 'mock-r1': 'complete', 'mock-r2': 'failed', 'mock-r3': 'complete' });
  assert.match(tasks.find(task => task.connection.model === 'mock-r2')!.error, /格式|JSON|报告/u);
});

test('手动批量审稿：正文在批次中变化时停止剩余模型，已生成报告保留', async t => {
  let changed = false;
  const fixtureData = await fixture(t, { beforeReply: async model => {
    if (model !== 'mock-r1' || changed) return;
    changed = true;
    const current = await fixtureData.workspace.readChapter(fixtureData.a.id, fixtureData.chapter.path);
    await fixtureData.workspace.saveChapter({ projectId: fixtureData.a.id, path: fixtureData.chapter.path, expectedHash: current.hash,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　作者改过的正文。' }] }] } });
  } });
  const { service, a, chapter, calls, ids } = fixtureData;
  await service.startReviewBatch(request(a.id, chapter, [ids['mock-r1'], ids['mock-r3']]));
  assert.deepEqual(calls, ['mock-r1']); // the second model was never called
  const tasks = (await service.list(a.id)).filter((task: AITask) => task.mode === 'review');
  assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'complete');
});

test('手动批量审稿：拒绝空/超限/重复连接与跨书报告，且不发 HTTP', async t => {
  const { service, a, b, workspace, chapter, ids, calls } = await fixture(t);
  await assert.rejects(service.startReviewBatch({ ...request(a.id, chapter, []), connectionIds: [] }));
  await assert.rejects(service.startReviewBatch({ ...request(a.id, chapter, [ids['mock-r1'], ids['mock-r1']]) }), /不能重复/u);
  await assert.rejects(service.startReviewBatch({ ...request(a.id, chapter, [ids['mock-r1'], ids['mock-r2'], ids['mock-r3'], ids['mock-r1']]) }));
  const other = await workspace.createChapter(b.id, textDocument('乙书正文。'));
  const candidate = await service.start({ projectId: b.id, connectionId: ids['mock-r1'], mode: 'write', chapterPath: other.path, sourceHash: other.hash, instruction: '写' });
  assert.equal(candidate.projectId, b.id);
  const deadline = Date.now() + 5000;
  while ((await service.list(b.id)).find(task => task.id === candidate.id)?.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(service.startReviewBatch({ ...request(a.id, chapter, [ids['mock-r1']]), reviewTaskId: candidate.id }), /本书中未找到/u);
  assert.equal(calls.filter(model => model !== 'mock-r1').length, 0); // no reviewer ever ran
});

test('手动批量审稿：启动时固定全部模型凭据，运行中编辑下一模型不改动批次', async t => {
  const f = await fixture(t, { beforeReply: async model => {
    if (model !== 'mock-r1') return;
    const snapshot = await f.connections.read(), profile = snapshot.connections.find(item => item.id === f.ids['mock-r3'])!;
    await f.connections.save({ ...profile, model: 'changed-model', apiKey: 'changed-fictional-key' }, snapshot.hash);
  } });
  await f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], f.ids['mock-r3']]));
  assert.deepEqual(f.calls, ['mock-r1', 'mock-r3']);
  assert.deepEqual(f.keys, ['Bearer fictional-mock-r1', 'Bearer fictional-mock-r3']);
});

test('手动批量审稿：世界观在第一份报告期间变更后停止，其余报告不采用新基准继续收费', async t => {
  const f = await fixture(t, { beforeReply: async model => {
    if (model !== 'mock-r1') return;
    const notes = await f.workspace.readNotes(f.a.id);
    await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '修改后的正式世界观。' }, notes.hash);
  } });
  await f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], f.ids['mock-r3']]));
  assert.deepEqual(f.calls, ['mock-r1']);
  assert.equal((await f.service.list(f.a.id)).length, 1);
});

test('手动批量审稿：任一连接无效时在首笔 HTTP 前拒绝，不产生部分批次', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], '10000000-0000-4000-8000-000000000001'])));
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.hasPendingWork(), false);
});

test('手动批量审稿：初始历史保存失败时不跳过并继续请求下一模型', async t => {
  const f = await fixture(t), internals = f.service as unknown as { persist(task: AITask): Promise<void> };
  const persist = internals.persist.bind(f.service);
  internals.persist = async task => { if (task.connection.model === 'mock-r1') throw new Error('fictional disk full'); return persist(task); };
  await assert.rejects(f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], f.ids['mock-r3']])), /历史保存失败/u);
  assert.deepEqual(f.calls, []);
  assert.equal(f.service.hasPendingWork(), false);
});

test('手动批量审稿：最终保存失败及时返回并停止后续 HTTP，结果留在内存供复制', async t => {
  const f = await fixture(t), internals = f.service as unknown as { persist(task: AITask): Promise<void> };
  const persist = internals.persist.bind(f.service);
  internals.persist = async task => { if (task.status !== 'running') throw new Error('fictional disk full'); return persist(task); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], f.ids['mock-r3']])),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('持久化失败后批次仍挂起')), 2000); })]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(f.calls, ['mock-r1']);
  const [task] = await f.service.list(f.a.id);
  assert.equal(task.status, 'failed'); assert.match(task.error, /历史保存失败/u); assert.match(task.text, /独立报告/u);
  assert.equal(f.service.hasPendingWork(), true, '未落盘结果继续保护退出');
});

test('手动批量审稿：重叠批次不能清除整批取消，原批次停止后可新开', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { beforeReply: model => model === 'mock-r1' ? gate : Promise.resolve() });
  const pending = f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], f.ids['mock-r3']]));
  const deadline = Date.now() + 5000;
  while (!f.calls.length) { if (Date.now() > deadline) throw new Error('首笔模拟请求未启动'); await new Promise(resolve => setTimeout(resolve, 10)); }
  await assert.rejects(f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r3']])), /已有 AI 任务/u);
  const task = (await f.service.list(f.a.id))[0];
  await f.service.cancel(f.a.id, task.id); release(); await pending;
  assert.deepEqual(f.calls, ['mock-r1']);
  assert.equal(f.service.hasPendingWork(), false);
  await f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r3']]));
  assert.deepEqual(f.calls, ['mock-r1', 'mock-r3']);
});

for (const adapter of ['responses', 'ollama'] as const) test(`模型历史：${adapter} 真实配置保存、调用和服务重建后仍可读取报告`, async t => {
  const f = await fixture(t), snapshot = await f.connections.read();
  const profile = snapshot.connections.find(item => item.id === f.ids['mock-r1'])!;
  await f.connections.save({ ...profile, adapter, apiKey: 'fictional-protocol-key' }, snapshot.hash);
  const first = await f.service.startReviewBatch(request(f.a.id, f.chapter, [profile.id]));
  assert.deepEqual(f.calls, ['mock-r1']); assert.equal(first.connection.adapter, adapter);
  const saved = await f.restart().list(f.a.id);
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'complete'); assert.equal(saved[0].connection.adapter, adapter);
  assert.match(saved[0].text, /独立报告/u);
});

for (const phase of ['保存首份报告', '准备下一模型'] as const) test(`手动批量审稿：${phase}期间仍可用最后显示的任务停止整批`, async t => {
  const f = await fixture(t), internals = f.service as unknown as { persist(task: AITask): Promise<void> };
  const persist = internals.persist.bind(f.service);
  let release!: () => void, ready!: () => void, firstId = '';
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { ready = resolve; });
  internals.persist = async task => {
    if (task.connection.model === 'mock-r1') firstId = task.id;
    const target = phase === '保存首份报告' ? task.connection.model === 'mock-r1' && task.status === 'complete'
      : task.connection.model === 'mock-r3' && task.status === 'running';
    if (target) { ready(); await gate; }
    await persist(task);
  };
  const pending = f.service.startReviewBatch(request(f.a.id, f.chapter, [f.ids['mock-r1'], f.ids['mock-r3']]));
  await reached;
  await f.service.cancel(f.a.id, firstId); release(); await pending;
  assert.deepEqual(f.calls, ['mock-r1']); assert.equal(f.service.hasPendingWork(), false);
});
