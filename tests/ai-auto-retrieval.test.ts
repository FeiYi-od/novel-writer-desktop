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
import { textDocument } from '../src/main/text-import';
import type { KnowledgeService } from '../src/main/knowledge-service';
import type { KnowledgeCitationReference } from '../src/shared/contracts';

const citationId = 'c'.repeat(64);
const hit = (id: string, sourcePath = 'chapters:月钥.txt') => ({ id, projectId: 'p', corpus: 'canon' as const, sourcePath, sourceHash: 'a'.repeat(64),
  startParagraph: 0, endParagraph: 0, text: '月钥只能开启北门。', sourceLabel: '已确认事实', sourceKind: 'chapter' as const, confirmed: true, score: 1 });
async function fixture(t: TestContext, behaviour: 'ok' | 'degrade' | 'fail' = 'ok') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-auto-retrieval-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await fs.mkdir(path.join(root, '甲')); const a = await workspace.attach(path.join(root, '甲'));
  const library = new LibraryStore(id => workspace.getProject(id), materials);
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  await library.read(a.id); await characters.read(a.id);
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '候选正文' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); });
  await listenLocalHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const saved = await connections.save({ name: 'writer', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'mock-writer', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 1024, tokenParameter: 'max_tokens', timeoutSeconds: 30, apiKey: 'fictional' }, '');
  const searches: string[] = [];
  const stub = {
    search: async (request: { mode?: string }) => {
      searches.push(request.mode ?? 'keyword');
      if (behaviour === 'fail') throw new Error('索引不可用');
      return { hits: [hit(citationId)], usedMode: behaviour === 'degrade' ? 'keyword' : 'hybrid', warnings: behaviour === 'degrade' ? ['尚未配置嵌入连接，本次降级为关键词检索'] : [] };
    },
    resolveCitations: async (_projectId: string, refs: KnowledgeCitationReference[]) => ({ context: '引用依据：月钥只能开启北门。', references: refs, fingerprint: 'b'.repeat(64) })
  } as unknown as KnowledgeService;
  const service = new AIService(local, connections, workspace, library, characters, undefined, undefined, stub);
  const chapter = await workspace.createChapter(a.id, textDocument('林夏推开月门。'));
  return { service, a, chapter, connectionId: saved.connections[0].id, searches };
}
const waitTask = async (service: AIService, projectId: string, id: string) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const task = (await service.list(projectId)).find(item => item.id === id);
    if (task && task.status !== 'running') return task;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('等待任务超时');
};

test('自动检索：未手选依据时按本书正式内容取回并记录实际模式', async t => {
  const { service, a, chapter, connectionId, searches } = await fixture(t);
  const task = await service.start({ projectId: a.id, connectionId, mode: 'write', chapterPath: chapter.path, sourceHash: chapter.hash,
    instruction: '续写雨夜场景', autoRetrieval: { mode: 'hybrid', topK: 3 } });
  assert.deepEqual(searches, ['hybrid']);
  assert.equal(task.autoRetrieval?.requested, 'hybrid'); assert.equal(task.autoRetrieval?.used, 'hybrid');
  assert.equal(task.autoRetrieval?.hits, 1); assert.equal(task.autoRetrieval?.warning, '');
  assert.equal(task.knowledgeCitations?.length, 1);
  assert.equal(task.citationFingerprint, 'b'.repeat(64));
  await waitTask(service, a.id, task.id);
});

test('自动检索：显式依据优先，不再自动检索；降级与失败都如实写进任务', async t => {
  const explicit = await fixture(t);
  const task = await explicit.service.start({ projectId: explicit.a.id, connectionId: explicit.connectionId, mode: 'write',
    chapterPath: explicit.chapter.path, sourceHash: explicit.chapter.hash, instruction: '续写',
    knowledgeCitations: [{ id: citationId, projectId: explicit.a.id, corpus: 'canon', sourcePath: 'chapters:月钥.txt', sourceHash: 'a'.repeat(64), startParagraph: 0, endParagraph: 0 }],
    autoRetrieval: { mode: 'hybrid' } });
  assert.deepEqual(explicit.searches, []);
  assert.equal(task.autoRetrieval, undefined);
  await waitTask(explicit.service, explicit.a.id, task.id);

  const degraded = await fixture(t, 'degrade');
  const fallback = await degraded.service.start({ projectId: degraded.a.id, connectionId: degraded.connectionId, mode: 'write',
    chapterPath: degraded.chapter.path, sourceHash: degraded.chapter.hash, instruction: '续写', autoRetrieval: { mode: 'hybrid' } });
  assert.equal(fallback.autoRetrieval?.used, 'keyword');
  assert.match(String(fallback.autoRetrieval?.warning), /降级/u);
  assert.equal(fallback.autoRetrieval?.hits, 1);
  await waitTask(degraded.service, degraded.a.id, fallback.id);

  const failed = await fixture(t, 'fail');
  const broken = await failed.service.start({ projectId: failed.a.id, connectionId: failed.connectionId, mode: 'write',
    chapterPath: failed.chapter.path, sourceHash: failed.chapter.hash, instruction: '续写', autoRetrieval: { mode: 'hybrid' } });
  assert.equal(broken.autoRetrieval?.hits, 0);
  assert.match(String(broken.autoRetrieval?.warning), /自动检索失败/u);
  await waitTask(failed.service, failed.a.id, broken.id);
});
