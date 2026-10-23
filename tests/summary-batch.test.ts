import { listenLocalHttp } from './support/local-http';
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
import { StoryMemoryStore } from '../src/main/story-memory';
import { textDocument } from '../src/main/text-import';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-summary-batch-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲', '乙'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲')), b = await workspace.attach(path.join(root, '乙'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  await library.read(a.id); await characters.read(a.id);
  const calls: { text: string; model: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { model: string; messages: { content: string }[] };
    const source = body.messages[1].content; calls.push({ text: source, model: body.model });
    if (source.includes('坏')) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"fake"}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `摘要：${source.slice(0, 12)}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenLocalHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const saved = await connections.save({ name: '摘要模型', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'mock-summary', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 2048, tokenParameter: 'max_tokens', timeoutSeconds: 30, apiKey: 'fictional-summary-key' }, '');
  const memory = new StoryMemoryStore(workspace, materials);
  const service = new AIService(local, connections, workspace, library, characters, undefined, memory);
  const chapter = (text: string) => workspace.createChapter(a.id, textDocument(text));
  return { workspace, service, memory, a, b, chapter, calls, connectionId: saved.connections[0].id };
}

test('批量摘要：顺序逐章生成独立草稿，确认前不进入故事记忆', async t => {
  const { service, memory, a, chapter, calls, connectionId } = await fixture(t);
  const one = await chapter('第一章正文。'), two = await chapter('第二章正文。'), three = await chapter('第三章正文。');
  const first = await service.startSummaryBatch({ projectId: a.id, connectionId, items: [{ path: one.path }, { path: two.path, hash: two.hash }, { path: three.path }] });
  assert.equal(first.mode, 'summary');
  assert.equal(calls.length, 3);
  const tasks = (await service.list(a.id)).filter(task => task.mode === 'summary');
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every(task => task.status === 'complete'));
  assert.deepEqual(new Set(tasks.map(task => task.chapterPath)), new Set([one.path, two.path, three.path]));
  assert.deepEqual(new Set(tasks.map(task => task.sourceHash)), new Set([one.hash, two.hash, three.hash]));
  assert.equal((await memory.read(a.id)).value.entries.length, 0); // drafts are never auto-confirmed
  const state = service.summaryBatch(a.id)!;
  assert.equal(state.completed, 3); assert.equal(state.created, 3); assert.deepEqual(state.failures, []);
});

test('批量摘要：单章失败只记录该项，其余章节继续且不自动确认', async t => {
  const { service, memory, a, chapter, calls, connectionId } = await fixture(t);
  const good = await chapter('正常第一章。'), bad = await chapter('这一章会坏掉。'), after = await chapter('正常第三章。');
  await service.startSummaryBatch({ projectId: a.id, connectionId, items: [{ path: good.path }, { path: bad.path }, { path: after.path }] });
  assert.equal(calls.length, 3);
  const state = service.summaryBatch(a.id)!;
  assert.equal(state.created, 2); assert.equal(state.failures.length, 1); assert.equal(state.failures[0].path, bad.path);
  assert.equal((await memory.read(a.id)).value.entries.length, 0);
  assert.equal((await service.list(a.id)).filter(task => task.mode === 'summary' && task.status === 'complete').length, 2);
});

test('批量摘要：启动前拒绝空/重复/超限/跨书/版本不符且不发 HTTP，无批次时停止为无害', async t => {
  const { service, a, b, workspace, chapter, calls, connectionId } = await fixture(t);
  const one = await chapter('第一章正文。');
  const other = await workspace.createChapter(b.id, textDocument('乙书正文。'));
  await assert.rejects(service.startSummaryBatch({ projectId: a.id, connectionId, items: [] }));
  await assert.rejects(service.startSummaryBatch({ projectId: a.id, connectionId, items: [{ path: one.path }, { path: one.path }] }), /不能重复/u);
  await assert.rejects(service.startSummaryBatch({ projectId: a.id, connectionId, items: Array.from({ length: 51 }, (_, index) => ({ path: `x${index}.txt` })) }));
  await assert.rejects(service.startSummaryBatch({ projectId: a.id, connectionId, items: [{ path: other.path }] }));
  await assert.rejects(service.startSummaryBatch({ projectId: a.id, connectionId, items: [{ path: one.path, hash: 'f'.repeat(64) }] }), /外部变化/u);
  assert.equal(calls.length, 0);
  assert.equal(service.summaryBatch(a.id), null);
  service.cancelSummaryBatch(a.id); // no batch yet: harmless
});
