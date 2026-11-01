import { listenLocalHttp } from './support/local-http';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { PlanningStore } from '../src/main/planning';
import { ChapterConfirmationStore } from '../src/main/chapter-confirmation';
import { KnowledgeService } from '../src/main/knowledge-service';
import { AIConnections } from '../src/main/ai-connections';
import { AIService } from '../src/main/ai-service';
import { textDocument } from '../src/main/text-import';
import { copyableText } from '../src/core/typography';
import type { AIRequest, AITask, KnowledgeCitationReference } from '../src/shared/contracts';
import { WAIT_LIMIT } from './wait';

const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + WAIT_LIMIT;
  while (!await check()) { if (Date.now() > deadline) throw new Error('多审稿测试等待超时'); await new Promise(resolve => setTimeout(resolve, 15)); }
};
const sse = (text: string, finish: string | null = 'stop') => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
const report = JSON.stringify({ summary: '本模型独立核对所给候选', issues: [{ quote: '推开们', replacement: '推开门', category: '错别字', evidence: '', reason: '门字误写' }] });
type Behaviour = 'ok' | 'hold' | 'http' | 'json' | 'timeout';
type Call = { body: { model: string; messages: { role: string; content: string }[] }; key: string | undefined };
type Internals = { pipeline: unknown; live: Map<string, unknown>; persist(task: AITask): Promise<void> };

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-multi-review-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲', '乙'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲')), b = await workspace.attach(path.join(root, '乙'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials), planning = new PlanningStore(id => workspace.getProject(id), materials);
  const confirmations = new ChapterConfirmationStore(workspace, materials), knowledge = new KnowledgeService(workspace, library, characters, planning, confirmations);
  const notes = await workspace.readNotes(a.id); await workspace.saveNotes(a.id, { ...notes.value, world: '甲书校园没有魔法。' }, notes.hash);
  await library.read(a.id); await characters.read(a.id); await planning.read(a.id);
  const citationPath = '已确认事实.txt'; await fs.writeFile(path.join(a.root, citationPath), '月钥只能开启北门。');
  const preview = await confirmations.preview(a.id, citationPath), confirmation = await confirmations.read(a.id, false);
  await confirmations.confirm({ projectId: a.id, path: citationPath, sourceHash: preview.hash, expectedHash: confirmation.hash });
  const hit = (await knowledge.search({ projectId: a.id, requestId: randomUUID(), corpus: 'canon', query: '月钥', topK: 1 })).hits[0];
  const refs: KnowledgeCitationReference[] = [{ id: hit.id, projectId: a.id, corpus: 'canon', sourcePath: hit.sourcePath, sourceHash: hit.sourceHash, startParagraph: hit.startParagraph, endParagraph: hit.endParagraph }];
  const doc = await workspace.createChapter(a.id, textDocument('作者原文保留。'));
  const calls: Call[] = [], responses = new Map<string, ServerResponse>(), behaviours = new Map<string, Behaviour>();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as Call['body']; calls.push({ body, key: req.headers.authorization }); responses.set(body.model, res);
    const behaviour = behaviours.get(body.model) ?? (body.model === 'writer' ? 'hold' : 'ok');
    if (behaviour === 'http') { res.writeHead(503); res.end('fake local error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = body.model === 'writer' ? '林夏推开们。\n雨停了。' : behaviour === 'json' ? '本报告不是有效 JSON' : report;
    if (behaviour === 'hold' || behaviour === 'timeout') res.write(sse(body.model === 'writer' ? text : '{"summary":', null));
    else res.end(sse(text) + 'data: [DONE]\n\n');
  });
  await listenLocalHttp(server);
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const, contextWindow: 32768, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let settings = await connections.read();
  for (const model of ['writer', 'review1', 'review2', 'review3']) settings = await connections.save({ ...base, name: model, model, apiKey: `${model}-fake-key` }, settings.hash);
  const service = new AIService(local, connections, workspace, library, characters, planning, undefined, knowledge), internals = service as unknown as Internals;
  const request: AIRequest = { projectId: a.id, connectionId: settings.connections[0].id, mode: 'write', chapterPath: doc.path, sourceHash: doc.hash, instruction: '续写', autoReviewConnectionIds: settings.connections.slice(1).map(item => item.id), knowledgeCitations: refs };
  const get = async (id: string) => (await service.list(a.id)).find(task => task.id === id)!;
  const finished = async (id: string) => { await until(async () => internals.pipeline === null && !!(await get(id)) && (await get(id)).status !== 'running'); return get(id); };
  const release = (model = 'writer', finish = 'stop') => {
    const res = responses.get(model); assert.ok(res);
    res.end(sse(model === 'writer' ? '' : report.slice('{"summary":'.length), finish) + 'data: [DONE]\n\n');
  };
  t.after(async () => {
    for (const res of responses.values()) res.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await until(async () => internals.pipeline === null);
    assert.match(path.relative(os.tmpdir(), root), /^novel-multi-review-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true });
  });
  return { root, local, workspace, a, b, library, characters, planning, confirmations, knowledge, connections, service, internals, settings, doc, refs, citationPath, calls, behaviours, request, get, finished, release,
    waitCalls: (count: number) => until(async () => calls.length >= count),
    restart: () => new AIService(local, connections, workspace, library, characters, planning, undefined, knowledge),
    taskFile: (id: string) => path.join(local, 'ai-tasks', a.id, `${id}.json`) };
}

test('多模型顺序审同一候选、冻结全部凭据、独立报告继承引用、另存不覆盖且按书隔离', async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.a.root, f.doc.path)); f.behaviours.set('review1', 'hold');
  const task = await f.service.start(f.request); await f.waitCalls(1);
  let settings = f.settings;
  for (const profile of settings.connections.slice(1)) settings = await f.connections.save({ ...profile, model: `${profile.model}-changed`, apiKey: 'changed-fake-key' }, settings.hash);
  f.release(); await f.waitCalls(2); await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(f.calls.length, 2);
  f.release('review1'); const parent = await f.finished(task.id);
  assert.equal(parent.status, 'complete'); assert.equal(parent.autoReview, undefined); assert.deepEqual(parent.autoReviews?.map(state => state.status), ['complete', 'complete', 'complete']);
  assert.deepEqual(f.calls.map(call => call.body.model), ['writer', 'review1', 'review2', 'review3']);
  assert.deepEqual(f.calls.map(call => call.key), ['Bearer writer-fake-key', 'Bearer review1-fake-key', 'Bearer review2-fake-key', 'Bearer review3-fake-key']);
  for (const call of f.calls.slice(1)) { assert.match(call.body.messages[0].content, /月钥只能开启北门/); assert.match(call.body.messages[1].content, /林夏推开们/); }
  const children = await Promise.all(parent.autoReviews!.map(state => f.get(state.taskId!)));
  assert.equal(new Set(children.map(child => child.id)).size, 3);
  for (const child of children) {
    assert.equal(child.reviewTaskId, task.id); assert.equal(child.projectId, f.a.id); assert.equal(child.sourceText, parent.text);
    assert.deepEqual(child.knowledgeCitations, parent.knowledgeCitations); assert.equal(child.citationFingerprint, parent.citationFingerprint); assert.equal(child.contextHash, parent.contextHash);
    assert.equal(child.autoReview, undefined); assert.equal(child.autoReviews, undefined); assert.equal(child.reviewFormat, 'issues');
  }
  const revised = await f.service.exportReviewEdits(f.a.id, children[2].id, ['issue-1']);
  assert.match(revised.path, /\.docx$/); assert.notEqual(revised.path, f.doc.path);
  if (typeof revised.content !== 'string') assert.equal(copyableText(revised.content), '　　林夏推开门。\n\n　　雨停了。');
  assert.deepEqual(await fs.readFile(path.join(f.a.root, f.doc.path)), original); assert.equal((await f.service.list(f.b.id)).length, 0);
  await assert.rejects(f.service.exportReviewEdits(f.b.id, children[2].id, ['issue-1']), /未找到/);
  assert.doesNotMatch(JSON.stringify(await f.service.list(f.a.id)), /fake-key/);
});

test('单个 HTTP、JSON、预算或超时失败保留其他报告，任何模型请求都不重试', async t => {
  for (const failure of ['http', 'json', 'budget', 'timeout'] as const) await t.test(failure, async sub => {
    const f = await fixture(sub);
    if (failure === 'budget') await f.connections.save({ ...f.settings.connections[2], contextWindow: 512, maxOutputTokens: 100 }, f.settings.hash);
    else f.behaviours.set('review2', failure);
    if (failure === 'timeout') {
      const resolve = f.connections.resolve.bind(f.connections);
      // Allow the local request to arrive under full-suite load, then time out
      // the deliberately unfinished SSE response. 80ms also timed out setup.
      f.connections.resolve = async id => { const value = await resolve(id); if (value.profile.model === 'review2') value.profile.timeoutSeconds = 1; return value; };
    }
    const task = await f.service.start(f.request); await f.waitCalls(1); f.release(); const parent = await f.finished(task.id);
    assert.deepEqual(parent.autoReviews?.map(state => state.status), ['complete', failure === 'budget' ? 'skipped' : 'failed', 'complete']);
    assert.deepEqual(f.calls.map(call => call.body.model), failure === 'budget' ? ['writer', 'review1', 'review3'] : ['writer', 'review1', 'review2', 'review3']);
    assert.equal(parent.status, 'complete'); assert.equal(f.service.hasPendingWork(), false);
    if (failure === 'json') assert.equal((await f.get(parent.autoReviews![1].taskId!)).text, '本报告不是有效 JSON');
  });
});

test('从父任务或正在运行的子报告取消都停止后续模型，跨书取消拒绝', async t => {
  for (const target of ['parent', 'child'] as const) await t.test(target, async sub => {
    const f = await fixture(sub); f.behaviours.set('review1', 'hold');
    const task = await f.service.start(f.request); await f.waitCalls(1); f.release(); await f.waitCalls(2);
    const active = await f.get(task.id), childId = active.autoReviews![0].taskId!;
    await assert.rejects(f.service.cancel(f.b.id, childId), /不属于/);
    await f.service.cancel(f.a.id, target === 'parent' ? task.id : childId); const parent = await f.finished(task.id);
    assert.deepEqual(parent.autoReviews?.map(state => state.status), ['failed', 'skipped', 'skipped']); assert.equal(f.calls.length, 2);
    const child = await f.get(childId); assert.equal(child.status, 'cancelled'); assert.equal(child.text, '{"summary":'); assert.equal(parent.status, 'complete');
  });
});

test('审稿期间正文、设定或正式引用变化后停止后续审稿且旧结果仍可复制', async t => {
  for (const change of ['chapter', 'context', 'citation'] as const) await t.test(change, async sub => {
    const f = await fixture(sub); f.behaviours.set('review1', 'hold');
    const task = await f.service.start(f.request); await f.waitCalls(1); f.release(); await f.waitCalls(2);
    if (change === 'chapter') await f.workspace.saveChapter({ projectId: f.a.id, path: f.doc.path, expectedHash: f.doc.hash, content: textDocument('作者更新的正文。') });
    else if (change === 'citation') await fs.writeFile(path.join(f.a.root, f.citationPath), '月钥依据新版。');
    else { const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '作者更新的世界观。' }, notes.hash); }
    f.release('review1'); const parent = await f.finished(task.id);
    assert.deepEqual(parent.autoReviews?.map(state => state.status), ['complete', 'skipped', 'skipped']); assert.equal(f.calls.length, 2);
    assert.equal((await f.get(parent.autoReviews![0].taskId!)).text, report);
    await assert.rejects(f.service.exportReviewEdits(f.a.id, parent.autoReviews![0].taskId!, ['issue-1']), /更新|失效/);
  });
});

test('子任务保存后依据失效时最终 HTTP 门闸整队停，写作候选保留', async t => {
  const f = await fixture(t), persist = f.internals.persist.bind(f.service); let changed = false;
  f.internals.persist = async task => {
    await persist(task);
    if (changed || task.mode !== 'review' || task.status !== 'running') return; changed = true;
    await fs.writeFile(path.join(f.a.root, f.citationPath), '保存子任务期间更新依据。');
  };
  const task = await f.service.start(f.request); await f.waitCalls(1); f.release(); const parent = await f.finished(task.id);
  assert.equal(f.calls.length, 1); assert.deepEqual(parent.autoReviews?.map(state => state.status), ['failed', 'skipped', 'skipped']);
  const child = await f.get(parent.autoReviews![0].taskId!); assert.match(child.error, /未发起模型请求/); assert.equal(parent.text, '林夏推开们。\n雨停了。');
});

test('候选不完整或写作取消时不启动任何审稿模型', async t => {
  for (const finish of ['length', 'cancel'] as const) await t.test(finish, async sub => {
    const f = await fixture(sub), task = await f.service.start(f.request); await f.waitCalls(1);
    if (finish === 'cancel') await f.service.cancel(f.a.id, task.id); else f.release('writer', 'length');
    const parent = await f.finished(task.id); assert.deepEqual(parent.autoReviews?.map(state => state.status), ['skipped', 'skipped', 'skipped']); assert.equal(f.calls.length, 1);
  });
});

test('数量、重复、互斥与用途校验在任何请求/历史写入前拒绝', async t => {
  const f = await fixture(t), ids = f.request.autoReviewConnectionIds!;
  const invalid = [
    { autoReviewConnectionIds: [] }, { autoReviewConnectionIds: [...ids, randomUUID()] }, { autoReviewConnectionIds: [ids[0], ids[0]] },
    { autoReviewConnectionId: ids[0] }, { mode: 'review' }, { autoReviewConnectionIds: [randomUUID()] }
  ];
  for (const edit of invalid) await assert.rejects(f.service.start({ ...f.request, ...edit } as AIRequest));
  assert.equal(f.calls.length, 0); assert.equal((await f.service.list(f.a.id)).length, 0); assert.equal(f.service.hasPendingWork(), false);
});

test('历史恢复逐项保留完成/失败，pending/running标中断不重试；损坏队列拒绝读取并保留', async t => {
  const f = await fixture(t), task = await f.service.start(f.request); await f.waitCalls(1); f.release(); const parent = await f.finished(task.id), file = f.taskFile(task.id);
  const saved = structuredClone(parent); saved.autoReviews![1].status = 'running'; saved.autoReviews![2].status = 'pending';
  await fs.writeFile(file, JSON.stringify(saved)); const count = f.calls.length;
  const restored = (await f.restart().list(f.a.id)).find(item => item.id === task.id)!;
  assert.deepEqual(restored.autoReviews?.map(state => state.status), ['complete', 'interrupted', 'interrupted']); assert.equal(restored.autoReviews![0].taskId, parent.autoReviews![0].taskId); assert.equal(f.calls.length, count);
  for (const edit of [{ autoReview: parent.autoReviews![0] }, { mode: 'review' }, { autoReviews: [] }, { autoReviews: [parent.autoReviews![0], parent.autoReviews![0]] }]) {
    const raw = JSON.stringify({ ...parent, ...edit }); await fs.writeFile(file, raw); await assert.rejects(f.restart().list(f.a.id)); assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  await fs.writeFile(file, JSON.stringify(parent));
});

test('准备阶段同步占锁并冻结 UI 数组，缺少任意审稿连接时整次拒绝', async t => {
  const f = await fixture(t), resolve = f.connections.resolve.bind(f.connections);
  let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let preparing = false;
  f.connections.resolve = async id => { if (id === f.settings.connections[1].id) { preparing = true; await gate; } return resolve(id); };
  const input = structuredClone(f.request), pending = f.service.start(input);
  input.autoReviewConnectionIds!.reverse(); input.projectId = f.b.id; input.instruction = '迟到的新书要求';
  await until(async () => preparing); assert.equal(f.service.hasPendingWork(), true); await assert.rejects(f.service.start(f.request), /准备 AI/); assert.equal(f.calls.length, 0);
  release(); const task = await pending; await f.waitCalls(1); f.release(); const parent = await f.finished(task.id);
  assert.deepEqual(parent.autoReviews?.map(state => state.connection.id), f.request.autoReviewConnectionIds); assert.equal(parent.projectId, f.a.id); assert.equal(parent.instruction, '续写');
});

test('历史初存、最终写入、checkpoint及父队列保存失败都停止剩余收费请求', async t => {
  for (const failure of ['initial-child', 'final-child', 'checkpoint', 'parent-between'] as const) await t.test(failure, async sub => {
    const f = await fixture(sub), persist = f.internals.persist.bind(f.service); let failed = false;
    if (failure === 'checkpoint') f.behaviours.set('review1', 'hold');
    f.internals.persist = async task => {
      const child = task.mode === 'review' && task.connection.model === 'review1';
      const trigger = failure === 'initial-child' ? child && task.status === 'running'
        : failure === 'final-child' ? child && task.status === 'complete'
          : failure === 'checkpoint' ? child && task.status === 'running' && !!task.text
            : task.mode === 'write' && task.autoReviews?.[0].status === 'complete';
      if (!failed && trigger) { failed = true; throw new Error('fictional local disk failure'); }
      await persist(task);
    };
    const task = await f.service.start(f.request); await f.waitCalls(1); f.release(); const parent = await f.finished(task.id);
    assert.equal(failed, true); assert.equal(f.calls.length, failure === 'initial-child' ? 1 : 2);
    assert.deepEqual(parent.autoReviews?.slice(1).map(state => state.status), ['skipped', 'skipped']); assert.equal(parent.text, '林夏推开们。\n雨停了。');
    const child = await f.get(parent.autoReviews![0].taskId!); assert.ok(child);
    if (failure !== 'parent-between') { assert.equal(child.status, 'failed'); assert.match(child.error, /保存失败/); }
    else { assert.equal(child.status, 'complete'); assert.equal(child.text, report); }
  });
});

test('最终父状态写入仍占运行锁，成功报告状态不被临时覆盖', async t => {
  const f = await fixture(t), persist = f.internals.persist.bind(f.service); let saving = false, release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  f.internals.persist = async task => {
    if (!saving && task.mode === 'write' && task.autoReviews?.every(state => state.status === 'complete')) { saving = true; await gate; }
    await persist(task);
  };
  const task = await f.service.start(f.request); await f.waitCalls(1); f.release(); await until(async () => saving);
  const locked = await f.get(task.id); assert.equal(locked.status, 'running'); assert.deepEqual(locked.autoReviews?.map(state => state.status), ['complete', 'complete', 'complete']);
  await assert.rejects(f.service.start(f.request), /已有 AI/); release(); assert.equal((await f.finished(task.id)).status, 'complete');
});
