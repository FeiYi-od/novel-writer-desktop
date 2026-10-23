import { listenLocalHttp } from './support/local-http';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AIConnections, normalizeBaseUrl } from '../src/main/ai-connections';
import { chatBody, streamChat } from '../src/main/ai-provider';
import { AIService } from '../src/main/ai-service';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { emptyCharacter } from '../src/core/characters';
import { copyableText } from '../src/core/typography';
import type { AIConnection, AIConnectionEdit, AIRequest, AITask } from '../src/shared/contracts';

const profile = (baseUrl: string): AIConnection => ({ id: randomUUID(), name: '测试模型', model: 'mock', baseUrl, contextWindow: 32768, maxOutputTokens: 2000, tokenParameter: 'max_tokens', adapter: 'generic', thinking: 'default', timeoutSeconds: 30, hasKey: false });
const edit = (baseUrl: string): AIConnectionEdit => { const { id, hasKey, ...input } = profile(baseUrl); return input; };
const codec = { encrypt: (text: string) => Buffer.from(text.split('').reverse().join('')), decrypt: (bytes: Buffer) => bytes.toString().split('').reverse().join('') };
const waitFor = async (check: () => Promise<boolean>) => { const until = Date.now() + 6000; while (!await check()) { if (Date.now() > until) throw new Error('测试等待超时'); await new Promise(resolve => setTimeout(resolve, 20)); } };
const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\r\n\r\n`;

async function mockServer() {
  const calls: { body: any; authorization?: string; url?: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push({ body, authorization: req.headers.authorization, url: req.url });
    if (body.model === 'http-error') { res.writeHead(401); res.end('SECRET SERVER ERROR'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.model === 'bad-json') { res.end('data: invalid\n\n'); return; }
    if (body.model === 'slow') { res.write(chunk('保留的片段')); return; }
    if (body.model === 'eof') { res.end(chunk('不完整')); return; }
    const text = body.messages[0].content.includes('独立审稿人') ? '错字：原句「窗外下鱼」；建议改为「窗外下雨」。大纲未提供，未检查。' : '林夏推开窗户。\n雨声停了。';
    const data = Buffer.from(': keep-alive\r\n\r\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '不属于正文的推理' }, finish_reason: null }] }) + '\r\n\r\n' + chunk(text, body.model === 'length' ? 'length' : 'stop') + 'data: [DONE]\r\n\r\n');
    // Deliberately split inside UTF-8 and CRLF boundaries.
    for (let i = 0; i < data.length; i += 7) { res.write(data.subarray(i, i + 7)); await new Promise(resolve => setTimeout(resolve, 1)); }
    res.end();
  });
  await listenLocalHttp(server);
  const port = (server.address() as { port: number }).port;
  return { calls, url: `http://127.0.0.1:${port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('AI 连接：密钥单向 UI、地址变更保护、冲突检查、未来版本保护', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-ai-settings-'));
  try {
    const store = new AIConnections(root, codec);
    let snapshot = await store.save({ ...edit('https://api.deepseek.com/chat/completions/'), apiKey: 'test-secret-key' }, '');
    const first = snapshot.connections[0];
    assert.equal(first.baseUrl, 'https://api.deepseek.com'); assert.equal(first.hasKey, true);
    assert.ok(!JSON.stringify(snapshot).includes('test-secret-key'));
    assert.ok(!(await fs.readFile(path.join(root, 'ai-connections.json'), 'utf8')).includes('test-secret-key'));
    assert.equal((await store.resolve(first.id)).key, 'test-secret-key');
    await assert.rejects(store.save({ ...first, baseUrl: 'https://example.org/v1' }, snapshot.hash), /更换 API/);
    await assert.rejects(store.save({ ...first, model: 'other' }, ''), /已更新/);
    snapshot = await store.save({ ...first, clearKey: true, baseUrl: 'https://example.org/v1' }, snapshot.hash);
    assert.equal(snapshot.connections[0].hasKey, false);
    assert.equal(normalizeBaseUrl('http://[::1]:8080/v1/'), 'http://[::1]:8080/v1');
    for (const url of ['https://user:secret@example.org/v1', 'https://example.org/v1?key=secret', 'file:///tmp/a', 'http://example.org/v1']) assert.throws(() => normalizeBaseUrl(url));
    await fs.writeFile(path.join(root, 'ai-connections.json'), '{"schemaVersion":99}');
    await assert.rejects(store.read(), /版本不支持/);
    await assert.rejects(store.save(edit('https://api.deepseek.com'), snapshot.hash), /版本不支持/);
    assert.equal(await fs.readFile(path.join(root, 'ai-connections.json'), 'utf8'), '{"schemaVersion":99}');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('国内协议适配与 SSE：DeepSeek、千问参数，分片中文、心跳、推理分离、错误和截断', async () => {
  const server = await mockServer();
  try {
    const p = profile(server.url); const messages = [{ role: 'user' as const, content: 'hello' }];
    assert.deepEqual(chatBody({ ...p, adapter: 'deepseek', thinking: 'enabled' }, messages).thinking, { type: 'enabled' });
    assert.equal(chatBody({ ...p, adapter: 'qwen', thinking: 'disabled' }, messages).enable_thinking, false);
    assert.equal(chatBody({ ...p, tokenParameter: 'max_completion_tokens' }, messages).max_tokens, undefined);
    assert.equal(chatBody(p, messages).temperature, undefined);
    let text = ''; const finish = await streamChat(p, 'test-secret', messages, AbortSignal.timeout(5000), part => { text += part; });
    assert.equal(text, '林夏推开窗户。\n雨声停了。'); assert.equal(finish, 'stop');
    assert.equal(server.calls[0].authorization, 'Bearer test-secret'); assert.equal(server.calls[0].url, '/v1/chat/completions');
    assert.equal(await streamChat({ ...p, model: 'length' }, '', messages, AbortSignal.timeout(5000), () => {}), 'length');
    await assert.rejects(streamChat({ ...p, model: 'http-error' }, '', messages, AbortSignal.timeout(5000), () => {}), error => { assert.match(String(error), /HTTP 401/); assert.doesNotMatch(String(error), /SECRET/); return true; });
    await assert.rejects(streamChat({ ...p, model: 'bad-json' }, '', messages, AbortSignal.timeout(5000), () => {}), /无法解析/);
    let partial = ''; await assert.rejects(streamChat({ ...p, model: 'eof' }, '', messages, AbortSignal.timeout(5000), part => { partial += part; }), /完成原因/); assert.equal(partial, '不完整');
    const abort = new AbortController(); partial = '';
    await assert.rejects(streamChat({ ...p, model: 'slow' }, '', messages, abort.signal, part => { partial += part; abort.abort(); })); assert.equal(partial, '保留的片段');
  } finally { await server.close(); }
});

test('AI 工作流：实际 HTTP 写作与异模审稿、本书资料、取消恢复、迟到隔离、DOCX 默认与旧稿保护', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-ai-flow-')); const server = await mockServer();
  try {
    const local = path.join(root, 'local'); const workspace = new Workspace(local); await workspace.initialize();
    await fs.mkdir(path.join(root, 'A')); await fs.mkdir(path.join(root, 'B'));
    const a = await workspace.attach(path.join(root, 'A')), b = await workspace.attach(path.join(root, 'B'));
    const library = new LibraryStore(id => workspace.getProject(id)); const characters = new CharacterStore(id => workspace.getProject(id));
    const connections = new AIConnections(local, codec);
    let settings = await connections.save({ ...edit(server.url), name: '写作', apiKey: 'local-test-key' }, '');
    const writerId = settings.connections[0].id;
    settings = await connections.save({ ...edit(server.url), name: '审稿', model: 'reviewer' }, settings.hash);
    const reviewerId = settings.connections[1].id;
    const service = new AIService(local, connections, workspace, library, characters);
    const doc = await workspace.createChapter(a.id, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '窗外下鱼。' }] }] });
    const notes = await workspace.readNotes(a.id); await workspace.saveNotes(a.id, { ...notes.value, world: '学园没有魔法', characters: '林夏害怕海水' }, notes.hash);
    const bn = await workspace.readNotes(b.id); await workspace.saveNotes(b.id, { ...bn.value, world: '水手有魔法' }, bn.hash);
    await characters.save(a.id, { fields: { ...emptyCharacter(), name: '林夏', personality: '内向', description: '学园学生', systemPrompt: '不应注入', creatorNotes: '作者说明不应注入' }, enabled: true }, '');
    const book = await library.read(a.id); await library.save(a.id, { ...book.value, styles: [{ id: randomUUID(), name: '短句', rules: '短段落表达', sourceIds: [], createdAt: new Date().toISOString(), method: 'local-statistics-v1', metrics: { characters: 0, paragraphs: 0, meanSentenceLength: 0, meanParagraphLength: 0, dialogueRatio: 0, firstPersonPerThousand: 0 } }] }, book.hash);
    const updated = await library.read(a.id); await library.save(a.id, { ...updated.value, activeStyleId: updated.value.styles[0].id }, updated.hash);
    const request: AIRequest = { projectId: a.id, connectionId: writerId, mode: 'write', chapterPath: doc.path, sourceHash: doc.hash, instruction: '续写' };
    const finishTask = async (id: string) => { await waitFor(async () => (await service.list(a.id)).find(t => t.id === id)?.status !== 'running'); return (await service.list(a.id)).find(t => t.id === id)!; };
    let task = await service.start(request); task = await finishTask(task.id);
    assert.equal(task.status, 'complete'); assert.match(task.context, /学园没有魔法/); assert.match(task.context, /内向/); assert.match(task.context, /短段落表达/);
    assert.doesNotMatch(task.context, /水手有魔法|不应注入|\[object Object\]/);
    assert.equal((await service.list(b.id)).length, 0); assert.equal((await workspace.readChapter(a.id, doc.path)).hash, doc.hash);
    const exported = await service.export(a.id, task.id); assert.match(exported.path, /\.docx$/); assert.notEqual(exported.path, doc.path);
    assert.equal(typeof exported.content, 'object'); if (typeof exported.content !== 'string') assert.equal(copyableText(exported.content), '　　林夏推开窗户。\n\n　　雨声停了。');
    let review = await service.start({ ...request, connectionId: reviewerId, mode: 'review', reviewTaskId: task.id }); review = await finishTask(review.id);
    assert.equal(review.connection.id, reviewerId); assert.equal(review.sourceText, task.text); assert.match(review.text, /错字/);
    await assert.rejects(service.export(a.id, review.id), /正文候选/);
    await assert.rejects(service.cancel(b.id, task.id), /不属于本书/);
    await assert.rejects(service.start({ ...request, projectId: b.id, reviewTaskId: task.id, mode: 'review' }));
    const latestNotes = await workspace.readNotes(a.id); await workspace.saveNotes(a.id, { ...latestNotes.value, world: '学园有魔法' }, latestNotes.hash);
    await assert.rejects(service.export(a.id, task.id), /设定已更新/);
    await assert.rejects(service.start({ ...request, mode: 'review', reviewTaskId: task.id }), /设定已变化/);
    settings = await connections.save({ ...settings.connections[0], model: 'slow' }, settings.hash);
    const slow = await service.start(request);
    await waitFor(async () => (await service.list(a.id)).some(t => t.id === slow.id && t.text.includes('保留的片段')));
    await assert.rejects(service.start(request), /已有 AI/);
    settings = await connections.save({ ...settings.connections[0], model: 'changed-after-start' }, settings.hash);
    await service.cancel(a.id, slow.id); const stopped = await finishTask(slow.id);
    assert.equal(stopped.connection.model, 'slow'); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.text, '保留的片段');
    await waitFor(async () => JSON.parse(await fs.readFile(path.join(local, 'ai-tasks', a.id, `${slow.id}.json`), 'utf8')).status === 'cancelled');
    const restored = new AIService(local, connections, workspace, library, characters);
    assert.equal((await restored.list(a.id)).find(t => t.id === slow.id)?.text, '保留的片段');
    const partialFile = path.join(local, 'ai-tasks', a.id, `${slow.id}.json`);
    await fs.writeFile(partialFile, JSON.stringify({ ...stopped, status: 'running' }));
    assert.equal((await restored.list(a.id)).find(t => t.id === slow.id)?.status, 'interrupted');
    await assert.rejects(service.start({ ...request, sourceHash: '0'.repeat(64) }), /外部变化/);
    assert.ok(!JSON.stringify(await service.list(a.id)).includes('local-test-key'));
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }); }
});
