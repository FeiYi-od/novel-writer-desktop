import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { AIService } from '../src/main/ai-service';
import { AIConnections } from '../src/main/ai-connections';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { WorldInfoStore } from '../src/main/world-info';
import { CharacterTagMappingStore } from '../src/main/character-tag-mapping';
import { emptyCharacter } from '../src/core/characters';
import { textDocument } from '../src/main/text-import';
import { listenLocalHttp } from './support/local-http';
import type { AIRequest } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve('.artifacts/ai-world-safety-054-'));
  const local = path.join(root, 'local'), materials = path.join(root, 'materials'), book = path.join(root, '虚构小说');
  await fs.mkdir(book); const workspace = new Workspace(local, materials); await workspace.initialize();
  const project = await workspace.attach(book);
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const worldInfo = new WorldInfoStore(workspace);
  await worldInfo.import(project.id, '世界', { entries: { '0': { key: ['星港'], content: '仅林夏的虚构设定', characterFilter: { isExclude: false, names: ['林夏'], tags: [] } } } });
  const chapter = await workspace.createChapter(project.id, textDocument('星港的雨。'));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); });
  await listenLocalHttp(server);
  const port = (server.address() as { port: number }).port;
  const connections = new AIConnections(local, { encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() });
  const settings = await connections.save({ name: '虚构模型', model: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, adapter: 'generic', thinking: 'default',
    contextWindow: 32768, maxOutputTokens: 1024, tokenParameter: 'max_tokens', timeoutSeconds: 30 }, '');
  const mappings = new CharacterTagMappingStore(workspace, characters);
  const service = new AIService(local, connections, workspace, library, characters, undefined, undefined, undefined, worldInfo, mappings);
  const request: AIRequest = { projectId: project.id, chapterPath: chapter.path, sourceHash: chapter.hash, connectionId: settings.connections[0].id, mode: 'write', instruction: '续写' };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { project, characters, mappings, worldInfo, service, request, book, requestCount: () => requests };
}

test('角色资料在构建世界书上下文时失效：停止生成且不发送模型请求', async t => {
  const f = await fixture(t); const original = f.characters.read.bind(f.characters); let reads = 0;
  t.mock.method(f.characters, 'read', async (id: string) => { reads++; if (reads === 2) throw new Error('虚构角色资料损坏'); return original(id); });
  await assert.rejects(f.service.start(f.request), /角色|世界书/u);
  assert.equal(reads, 2); assert.equal(f.requestCount(), 0);
});

test('世界书上下文读取失败：停止生成且不发送模型请求', async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(f.worldInfo, 'context', async () => { calls++; throw new Error('虚构世界书读取失败'); });
  await assert.rejects(f.service.start(f.request), /世界书/u);
  assert.equal(calls, 1); assert.equal(f.requestCount(), 0);
});

test('世界书文件损坏时不能静默跳过并发送模型请求', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.book, '小说资料', '世界书', '世界.json'), '{损坏的世界书');
  await assert.rejects(f.service.start(f.request), /世界书/u);
  assert.equal(f.requestCount(), 0);
});

test('AI 世界书：显式绑定按单角色过滤，角色修改后关联失效', async t => {
  const f = await fixture(t), id = f.project.id;
  let cards = await f.characters.read(id);
  cards = await f.characters.save(id, { fields: { ...emptyCharacter(), name: '角色甲' }, enabled: true }, cards.hash);
  cards = await f.characters.save(id, { fields: { ...emptyCharacter(), name: '角色乙' }, enabled: true }, cards.hash);
  const [a, b] = cards.value.cards;
  await f.worldInfo.import(id, '绑定测试', { entries: { '0': { key: ['星港'], content: '特定角色与标签设定', characterFilter: { isExclude: false, names: ['avatar-a'], tags: ['tag-red'] } } } });
  let map = await f.mappings.read(id);
  map = await f.mappings.save(id, [{ characterId: a.id, avatarKey: 'avatar-a', tagIds: ['tag-blue'] }, { characterId: b.id, avatarKey: 'avatar-b', tagIds: ['tag-red'] }], map.hash, cards.hash);
  const context = () => (f.service as unknown as { worldContextFor(projectId: string, source: string): Promise<string> }).worldContextFor(id, '星港');
  assert.doesNotMatch(await context(), /特定角色与标签设定/u, '不能拼接不同角色的名称和标签');
  map = await f.mappings.save(id, [{ characterId: a.id, avatarKey: 'avatar-a', tagIds: ['tag-red'] }, { characterId: b.id, avatarKey: 'avatar-b', tagIds: ['tag-red'] }], map.hash, cards.hash);
  assert.match(await context(), /特定角色与标签设定/u);
  await f.characters.save(id, { id: a.id, fields: { ...emptyCharacter(), name: '角色甲', description: '作者修改了角色' }, enabled: true }, cards.hash);
  assert.equal((await f.mappings.read(id)).stale, true);
  assert.doesNotMatch(await context(), /特定角色与标签设定/u, '角色变化后不可使用过期关联');
  assert.equal(f.requestCount(), 0);
});


test('AI 空章节仍注入本书常驻世界设定', async t => {
  const f = await fixture(t);
  await f.worldInfo.import(f.project.id, '常驻', { entries: { '0': { key: [], constant: true, content: '空章常驻设定' } } });
  const context = await (f.service as unknown as { worldContextFor(projectId: string, source: string): Promise<string> }).worldContextFor(f.project.id, '');
  assert.match(context, /空章常驻设定/u); assert.equal(f.requestCount(), 0);
});
