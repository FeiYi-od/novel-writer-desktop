import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { AIService } from '../src/main/ai-service';
import { AIConnections } from '../src/main/ai-connections';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { PlanningStore } from '../src/main/planning';
import { ChapterConfirmationStore } from '../src/main/chapter-confirmation';
import { KnowledgeService } from '../src/main/knowledge-service';
import { textDocument } from '../src/main/text-import';
import { copyableText } from '../src/core/typography';
import type { AIRequest, AITask, KnowledgeCitationReference, KnowledgeSearchHit } from '../src/shared/contracts';

const waitFor = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('AI 引用测试等待超时'); await new Promise(resolve => setTimeout(resolve, 15)); }
};
const sse = (text: string, finish: string | null = 'stop') => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
const reference = (hit: KnowledgeSearchHit): KnowledgeCitationReference => ({ id: hit.id, projectId: hit.projectId, corpus: 'canon', sourcePath: hit.sourcePath,
  sourceHash: hit.sourceHash, startParagraph: hit.startParagraph, endParagraph: hit.endParagraph });

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-ai-citations-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲书', '乙书'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲书')), b = await workspace.attach(path.join(root, '乙书'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials), planning = new PlanningStore(id => workspace.getProject(id), materials);
  const confirmations = new ChapterConfirmationStore(workspace, materials), knowledge = new KnowledgeService(workspace, library, characters, planning, confirmations);
  for (const id of [a.id, b.id]) {
    const notes = await workspace.readNotes(id); await workspace.saveNotes(id, { ...notes.value, world: id === a.id ? '甲书校园没有魔法。' : '乙书水手会魔法。' }, notes.hash);
    await library.read(id); await characters.read(id); await planning.read(id);
  }
  const sourcePath = '已确认北门.txt', sourcePath2 = '已确认南门.txt';
  await fs.writeFile(path.join(a.root, sourcePath), '月钥只能开启北门。\n月钥由林夏保管。');
  await fs.writeFile(path.join(a.root, sourcePath2), '月钥不能开启南门。');
  for (const relative of [sourcePath, sourcePath2]) {
    const preview = await confirmations.preview(a.id, relative), snapshot = await confirmations.read(a.id, false);
    await confirmations.confirm({ projectId: a.id, path: preview.path, sourceHash: preview.hash, expectedHash: snapshot.hash });
  }
  const hits = (await knowledge.search({ projectId: a.id, requestId: randomUUID(), corpus: 'canon', query: '月钥', topK: 10 })).hits;
  assert.equal(hits.length, 2);
  const refs = hits.map(reference), doc = await workspace.createChapter(a.id, textDocument('她推开们。'));
  type Call = { model: string; messages: { role: string; content: string }[] };
  const calls: Call[] = []; let holdWriter = false; let writerResponse: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as Call; calls.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.model === 'writer') {
      if (holdWriter) { writerResponse = res; res.write(sse('林夏推开们。', null)); }
      else res.end(sse('林夏推开们。') + 'data: [DONE]\n\n');
    } else res.end(sse(JSON.stringify({ summary: '依据已确认的月钥原文核对', issues: [{ category: '错别字', quote: '推开们', replacement: '推开门', reason: '门字误写', evidence: '' }] })) + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connections = new AIConnections(local, { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const,
    contextWindow: 32768, maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let settings = await connections.save({ ...base, name: '写作模型', model: 'writer' }, '');
  settings = await connections.save({ ...base, name: '独立审稿模型', model: 'reviewer' }, settings.hash);
  const service = new AIService(local, connections, workspace, library, characters, planning, undefined, knowledge);
  const request: AIRequest = { projectId: a.id, connectionId: settings.connections[0].id, mode: 'write', chapterPath: doc.path, sourceHash: doc.hash, instruction: '续写', knowledgeCitations: refs };
  const get = async (id: string) => (await service.list(a.id)).find(task => task.id === id)!;
  const finished = async (id: string) => { await waitFor(async () => { const task = await get(id); return !!task && task.status !== 'running' && !['pending', 'running'].includes(task.autoReview?.status ?? '') && !service.hasPendingWork(); }); return get(id); };
  t.after(async () => {
    writerResponse?.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await waitFor(async () => !service.hasPendingWork());
    assert.match(path.relative(os.tmpdir(), root), /^novel-ai-citations-[^\\/]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, local, workspace, library, characters, planning, confirmations, knowledge, connections, settings, service, a, b, doc, refs, sourcePath, sourcePath2, calls, request, get, finished,
    hold: () => { holdWriter = true; }, release: () => { assert.ok(writerResponse); writerResponse.end(sse('', 'stop') + 'data: [DONE]\n\n'); },
    restart: () => new AIService(local, connections, workspace, library, characters, planning, undefined, knowledge),
    taskFile: (id: string) => path.join(local, 'ai-tasks', a.id, `${id}.json`) };
}

test('正式引用实际进入 HTTP，异模自动审稿与手动候选审稿继承固定引用，历史重启保留且原稿不变', async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.a.root, f.doc.path));
  const sources = await Promise.all([f.sourcePath, f.sourcePath2].map(relative => fs.readFile(path.join(f.a.root, relative))));
  const parent = await f.finished((await f.service.start({ ...f.request, autoReviewConnectionId: f.settings.connections[1].id })).id);
  assert.equal(parent.status, 'complete'); assert.equal(parent.autoReview?.status, 'complete'); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].model, 'writer'); assert.equal(f.calls[1].model, 'reviewer');
  assert.match(parent.context, /甲书校园没有魔法/); assert.match(parent.context, /月钥只能开启北门/); assert.doesNotMatch(parent.context, /乙书/);
  assert.deepEqual(parent.knowledgeCitations, f.refs); assert.match(parent.citationFingerprint!, /^[a-f0-9]{64}$/);
  for (const call of f.calls) { assert.match(call.messages[0].content, /月钥只能开启北门/); assert.match(call.messages[0].content, /月钥不能开启南门/); }
  const child = await f.get(parent.autoReview!.taskId!);
  assert.equal(child.reviewTaskId, parent.id); assert.deepEqual(child.knowledgeCitations, parent.knowledgeCitations);
  assert.equal(child.citationFingerprint, parent.citationFingerprint); assert.equal(child.contextHash, parent.contextHash); assert.equal(child.context, parent.context);
  const manual = await f.finished((await f.service.start({ ...f.request, mode: 'review', connectionId: f.settings.connections[1].id, reviewTaskId: parent.id, knowledgeCitations: [...f.refs].reverse(), reviewFormat: 'issues' })).id);
  assert.equal(manual.sourceText, parent.text); assert.deepEqual(manual.knowledgeCitations, parent.knowledgeCitations); assert.equal(manual.citationFingerprint, parent.citationFingerprint);
  const inherited = await f.finished((await f.service.start({ ...f.request, mode: 'review', connectionId: f.settings.connections[1].id, reviewTaskId: parent.id, knowledgeCitations: undefined })).id);
  assert.deepEqual(inherited.knowledgeCitations, parent.knowledgeCitations);
  const count = f.calls.length;
  await assert.rejects(f.service.start({ ...f.request, mode: 'review', reviewTaskId: parent.id, knowledgeCitations: [f.refs[0]] }), /继承/); assert.equal(f.calls.length, count);
  const restored = (await f.restart().list(f.a.id)).find(task => task.id === parent.id)!;
  assert.deepEqual(restored.knowledgeCitations, f.refs); assert.equal(restored.citationFingerprint, parent.citationFingerprint);
  assert.equal((await f.service.list(f.b.id)).length, 0);
  const exported = await f.service.export(f.a.id, parent.id), revised = await f.service.exportReviewEdits(f.a.id, child.id, ['issue-1']);
  assert.notEqual(exported.path, f.doc.path); assert.notEqual(revised.path, f.doc.path);
  assert.equal(typeof revised.content, 'object'); if (typeof revised.content !== 'string') assert.equal(copyableText(revised.content), '　　林夏推开门。');
  assert.deepEqual(await fs.readFile(path.join(f.a.root, f.doc.path)), original);
  assert.deepEqual(await Promise.all([f.sourcePath, f.sourcePath2].map(relative => fs.readFile(path.join(f.a.root, relative)))), sources);
});

test('来源变化或作者停用确认后，旧候选/审稿结果仍可读取，禁止候选审稿和两种另存', async t => {
  for (const change of ['source', 'disable'] as const) await t.test(change, async sub => {
    const f = await fixture(sub), original = await fs.readFile(path.join(f.a.root, f.doc.path));
    const parent = await f.finished((await f.service.start({ ...f.request, autoReviewConnectionId: f.settings.connections[1].id })).id);
    if (change === 'source') await fs.writeFile(path.join(f.a.root, f.sourcePath), '月钥新版可以开启东门。');
    else { const snapshot = await f.confirmations.read(f.a.id, false); await f.confirmations.disable(f.a.id, snapshot.value.entries.find(entry => entry.sourcePath === f.sourcePath)!.id, snapshot.hash); }
    const count = f.calls.length;
    await assert.rejects(f.service.export(f.a.id, parent.id), /引用依据/);
    await assert.rejects(f.service.exportReviewEdits(f.a.id, parent.autoReview!.taskId!, ['issue-1']), /引用依据/);
    await assert.rejects(f.service.start({ ...f.request, mode: 'review', reviewTaskId: parent.id })); assert.equal(f.calls.length, count);
    assert.equal((await f.get(parent.id)).text, '林夏推开们。'); assert.equal((await f.restart().list(f.a.id)).find(task => task.id === parent.id)?.text, parent.text);
    assert.deepEqual(await fs.readFile(path.join(f.a.root, f.doc.path)), original);
  });
});

test('运行期间依据变化保留已收到的候选，自动审稿跳过且不会重试计费请求', async t => {
  const f = await fixture(t); f.hold();
  const started = await f.service.start({ ...f.request, autoReviewConnectionId: f.settings.connections[1].id });
  await waitFor(async () => f.calls.length === 1 && (await f.get(started.id)).text === '林夏推开们。');
  await fs.writeFile(path.join(f.a.root, f.sourcePath), '月钥依据已经更新。'); f.release();
  const parent = await f.finished(started.id);
  assert.equal(parent.status, 'complete'); assert.equal(parent.text, '林夏推开们。'); assert.equal(parent.autoReview?.status, 'skipped'); assert.match(parent.autoReview!.error, /引用依据/);
  assert.equal(f.calls.length, 1); await assert.rejects(f.service.export(f.a.id, parent.id), /引用依据/);
});

test('跨书、非正式、重复、伪造分片和数量越界引用在网络前整次拒绝', async t => {
  const f = await fixture(t);
  const invalid = [
    [{ ...f.refs[0], projectId: f.b.id }], [{ ...f.refs[0], corpus: 'discussion' }], [f.refs[0], f.refs[0]], [], Array.from({ length: 11 }, () => f.refs[0]),
    [{ ...f.refs[0], id: '0'.repeat(64) }], [{ ...f.refs[0], sourceHash: '0'.repeat(64) }], [{ ...f.refs[0], startParagraph: 1, endParagraph: 0 }],
    [{ ...f.refs[0], sourcePath: 'chapters:../越界.txt' }], [{ ...f.refs[0], text: 'UI 伪造文本不能发送' }]
  ];
  for (const knowledgeCitations of invalid) await assert.rejects(f.service.start({ ...f.request, knowledgeCitations } as AIRequest));
  assert.equal(f.calls.length, 0); assert.equal((await f.service.list(f.a.id)).length, 0); assert.equal(f.service.hasPendingWork(), false);
});

test('引用计入整体 UTF-8 预算，超限拒绝且不剪引用；不带引用的旧任务保持原行为', async t => {
  const f = await fixture(t);
  // A source with several small canon chunks can exceed a deliberately small model window.
  const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '' }, notes.hash);
  let settings = await f.connections.read(); settings = await f.connections.save({ ...settings.connections[0], contextWindow: 2048, maxOutputTokens: 256 }, settings.hash);
  await fs.writeFile(path.join(f.a.root, f.sourcePath), '月钥' + '很长的正式依据。'.repeat(190));
  const preview = await f.confirmations.preview(f.a.id, f.sourcePath), snapshot = await f.confirmations.read(f.a.id, false);
  await f.confirmations.confirm({ projectId: f.a.id, path: preview.path, sourceHash: preview.hash, expectedHash: snapshot.hash });
  const longRef = reference((await f.knowledge.search({ projectId: f.a.id, requestId: randomUUID(), corpus: 'canon', query: '月钥', topK: 10 })).hits.find(hit => hit.sourcePath === `chapters:${f.sourcePath}`)!);
  await assert.rejects(f.service.start({ ...f.request, knowledgeCitations: [longRef] }), /预算/); assert.equal(f.calls.length, 0);
  const legacy = await f.finished((await f.service.start({ ...f.request, knowledgeCitations: undefined })).id);
  assert.equal(legacy.status, 'complete'); assert.equal(legacy.knowledgeCitations, undefined); assert.equal(legacy.citationFingerprint, undefined);
  assert.doesNotMatch(f.calls[0].messages[0].content, /很长的正式依据/); await f.service.export(f.a.id, legacy.id);
});

test('调用参数在首个 await 后被 UI 改写时，项目、章节、指令与引用仍绑定启动快照', async t => {
  const f = await fixture(t), input = structuredClone(f.request);
  const pending = f.service.start(input);
  input.projectId = f.b.id; input.chapterPath = '另一章.docx'; input.instruction = '被界面迟到修改'; input.knowledgeCitations![0].projectId = f.b.id; input.knowledgeCitations![0].id = '0'.repeat(64); input.knowledgeCitations!.splice(1);
  const task = await f.finished((await pending).id);
  assert.equal(task.projectId, f.a.id); assert.equal(task.chapterPath, f.doc.path); assert.equal(task.instruction, '续写'); assert.deepEqual(task.knowledgeCitations, f.refs);
  assert.doesNotMatch(JSON.stringify(f.calls), /被界面迟到修改/); assert.equal((await f.service.list(f.b.id)).length, 0);
});

test('历史引用与指纹必须成对，只允许本书 write/review，损坏历史保留并拒绝读取', async t => {
  const f = await fixture(t), complete = await f.finished((await f.service.start(f.request)).id), file = f.taskFile(complete.id);
  const malformed: Partial<AITask>[] = [
    { citationFingerprint: undefined }, { knowledgeCitations: undefined }, { mode: 'summary' },
    { knowledgeCitations: [{ ...f.refs[0], projectId: f.b.id }] }, { knowledgeCitations: [f.refs[0], f.refs[0]] }
  ];
  for (const edit of malformed) {
    const raw = JSON.stringify({ ...complete, ...edit }); await fs.writeFile(file, raw);
    await assert.rejects(f.restart().list(f.a.id)); assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  await fs.writeFile(file, JSON.stringify(complete)); assert.equal((await f.restart().list(f.a.id))[0].citationFingerprint, complete.citationFingerprint);
});

test('任务持久化期间原件/确认/正文/设定变化时，最终发送门闸阻止真实 HTTP', async t => {
  for (const change of ['source', 'disable', 'chapter', 'context'] as const) await t.test(change, async sub => {
    const f = await fixture(sub);
    const mutable = f.service as unknown as { persist(task: AITask): Promise<void> }, persist = mutable.persist.bind(f.service); let changed = false;
    mutable.persist = async task => {
      await persist(task);
      if (changed || task.status !== 'running') return; changed = true;
      if (change === 'source') await fs.writeFile(path.join(f.a.root, f.sourcePath), '月钥在保存任务期间已变化。');
      else if (change === 'disable') { const snapshot = await f.confirmations.read(f.a.id, false); await f.confirmations.disable(f.a.id, snapshot.value.entries[0].id, snapshot.hash); }
      else if (change === 'chapter') await f.workspace.saveChapter({ projectId: f.a.id, path: f.doc.path, content: textDocument('正文在保存任务期间已变化。'), expectedHash: f.doc.hash });
      else { const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '设定在保存任务期间已变化。' }, notes.hash); }
    };
    const parent = await f.finished((await f.service.start({ ...f.request, autoReviewConnectionId: f.settings.connections[1].id })).id);
    assert.equal(parent.status, 'failed'); assert.match(parent.error, /未发起模型请求/); assert.equal(parent.text, '');
    assert.equal(parent.autoReview?.status, 'skipped'); assert.equal(f.calls.length, 0); assert.equal(f.service.hasPendingWork(), false);
    assert.equal((await f.restart().list(f.a.id)).find(task => task.id === parent.id)?.status, 'failed');
  });
});

test('自动审稿子任务持久化期间依据变化时，仅保留一次写作 HTTP 并拒绝审稿发送', async t => {
  const f = await fixture(t), mutable = f.service as unknown as { persist(task: AITask): Promise<void> }, persist = mutable.persist.bind(f.service); let changed = false;
  mutable.persist = async task => {
    await persist(task);
    if (changed || task.mode !== 'review' || task.status !== 'running') return; changed = true;
    const snapshot = await f.confirmations.read(f.a.id, false); await f.confirmations.disable(f.a.id, snapshot.value.entries[0].id, snapshot.hash);
  };
  const parent = await f.finished((await f.service.start({ ...f.request, autoReviewConnectionId: f.settings.connections[1].id })).id);
  assert.equal(parent.status, 'complete'); assert.equal(parent.autoReview?.status, 'failed'); assert.equal(f.calls.length, 1);
  const child = await f.get(parent.autoReview!.taskId!); assert.equal(child.status, 'failed'); assert.match(child.error, /未发起模型请求/); assert.deepEqual(child.knowledgeCitations, parent.knowledgeCitations);
});
