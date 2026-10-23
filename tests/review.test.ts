import { listenLocalHttp } from './support/local-http';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { parseReview, applyReviewEdits } from '../src/core/review';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { AIConnections } from '../src/main/ai-connections';
import { AIService } from '../src/main/ai-service';
import { textDocument } from '../src/main/text-import';
import { copyableText } from '../src/core/typography';
import type { AIRequest } from '../src/shared/contracts';
const item = (quote: string, replacement: string, category = '错别字', evidence = '') => ({ quote, replacement, category, evidence, reason: '需要作者核对' });
const report = (issues: ReturnType<typeof item>[]) => JSON.stringify({ summary: '仅检查所给资料', issues });
const sse = (text: string, finish: string | null = 'stop') => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 15)); } throw new Error('等待写审测试超时'); };
test('结构化审稿：唯一引文、虚构依据、跨段、重复原句与格式验证', () => {
  const source = '她推开们。\n\n她说：“好。”她说：“好。”';
  const parsed = parseReview(report([item('推开们', '推开门'), item('她说：“好。”', '她说：“好的。”'), item('不存在原句', '改句'), item('她推开们。', '她推开门。', '角色', '不存在的规则'), item('推开们', '推开\n门')]), source, '林夏是学生');
  assert.equal(parsed.issues[0].start, 1);
  assert.match(parsed.issues[1].limitation, /重复/); assert.match(parsed.issues[2].limitation, /不匹配/); assert.match(parsed.issues[3].limitation, /依据/); assert.match(parsed.issues[4].limitation, /跨段/);
  assert.throws(() => parseReview('没问题', source, ''), /有效/);
  assert.throws(() => parseReview(report([item('推开们', '推开门', '胡编类型')]), source, ''), /有效/);
  assert.equal(applyReviewEdits(source, parsed.issues, ['issue-1']), '她推开门。\n\n她说：“好。”她说：“好。”');
  assert.throws(() => applyReviewEdits(source, parsed.issues, ['issue-2']), /定位/);
});
test('逐项修改：重叠/重复/失效/空稿拒绝，保留未选内容与顺序', () => {
  const source = '她推开们。雨停了。'; const parsed = parseReview(report([item('推开们', '推开门'), item('她推开们。', '她开门了。'), item('雨停了', '雨开始下了')]), source, '');
  assert.throws(() => applyReviewEdits(source, parsed.issues, ['issue-1', 'issue-2']), /重叠/);
  assert.throws(() => applyReviewEdits(source, parsed.issues, ['issue-1', 'issue-1']), /重复/);
  assert.throws(() => applyReviewEdits('她推开门。雨停了。', parsed.issues, ['issue-1']), /定位/);
  assert.equal(applyReviewEdits(source, parsed.issues, ['issue-3', 'issue-1']), '她推开门。雨开始下了。');
  const deletion = parseReview(report([item(source, '')]), source, ''); assert.throws(() => applyReviewEdits(source, deletion.issues, ['issue-1']), /为空/);
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-review-')); const local = path.join(root, 'local');
  const workspace = new Workspace(local); await workspace.initialize(); await fs.mkdir(path.join(root, 'A')); await fs.mkdir(path.join(root, 'B'));
  const a = await workspace.attach(path.join(root, 'A')), b = await workspace.attach(path.join(root, 'B'));
  const calls: { body: any; key?: string }[] = []; let writerResponse: ServerResponse | undefined; let reviewerResponse: ServerResponse | undefined;
  const output = '林夏推开们。\n雨停了。'; let writerFinish = 'stop', holdReview = false, invalidReview = false;
  const server = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw); calls.push({ body, key: req.headers.authorization }); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.model.startsWith('writer')) { writerResponse = res; res.write(sse(output, null)); }
    else if (holdReview) { reviewerResponse = res; res.write(sse('{"summary":', null)); }
    else res.end(sse(invalidReview ? 'not-json' : report([item('推开们', '推开门')])) + 'data: [DONE]\n\n');
  }); await listenLocalHttp(server);
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text.split('').reverse().join('')), decrypt: bytes => bytes.toString().split('').reverse().join('') });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const, contextWindow: 32768, maxOutputTokens: 2048, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let settings = await connections.save({ ...base, name: '写作', model: 'writer', apiKey: 'writer-test-key' }, '');
  settings = await connections.save({ ...base, name: '审稿', model: 'reviewer-original', apiKey: 'review-test-key' }, settings.hash);
  const library = new LibraryStore(id => workspace.getProject(id)), characters = new CharacterStore(id => workspace.getProject(id));
  const service = new AIService(local, connections, workspace, library, characters);
  const doc = await workspace.createChapter(a.id, textDocument('原始正文保持不变。'));
  const request: AIRequest = { projectId: a.id, chapterPath: doc.path, sourceHash: doc.hash, connectionId: settings.connections[0].id, mode: 'write', instruction: '续写', autoReviewConnectionId: settings.connections[1].id };
  const parent = async (id: string) => (await service.list(a.id)).find(t => t.id === id)!;
  const terminal = async (id: string) => { await until(async () => { const task = await parent(id); return !!task && !['pending', 'running'].includes(task.autoReview?.status ?? ''); }); return parent(id); };
  return { root, local, workspace, a, b, service, connections, settings, doc, request, calls, parent, terminal,
    release: () => writerResponse!.end(sse('', writerFinish) + 'data: [DONE]\n\n'), options: (options: { writerFinish?: string; holdReview?: boolean; invalidReview?: boolean }) => { writerFinish = options.writerFinish ?? 'stop'; holdReview = options.holdReview ?? false; invalidReview = options.invalidReview ?? false; },
    waitWriter: (count: number) => until(async () => calls.length >= count),
    close: async () => { writerResponse?.destroy(); reviewerResponse?.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await fs.rm(root, { recursive: true, force: true }); }
  };
}
test('自动异模审稿：模型/密钥冻结、候选关联、按书隔离、逐项另存和旧版本保护', async t => {
  const f = await fixture(); t.after(f.close); const original = await fs.readFile(path.join(f.a.root, f.doc.path));
  const first = await f.service.start(f.request); await f.waitWriter(1);
  await assert.rejects(f.service.start(f.request), /已有 AI/);
  await f.connections.save({ ...f.settings.connections[1], model: 'reviewer-changed', apiKey: 'new-review-key' }, f.settings.hash);
  f.release(); const done = await f.terminal(first.id); assert.equal(done.autoReview?.status, 'complete', JSON.stringify(done)); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.model, 'reviewer-original'); assert.equal(f.calls[1].key, 'Bearer review-test-key'); assert.match(f.calls[1].body.messages[1].content, /推开们/);
  const review = (await f.service.list(f.a.id)).find(t => t.id === done.autoReview?.taskId)!; assert.equal(review.reviewTaskId, first.id); assert.equal(review.reviewFormat, 'issues');
  assert.equal((await f.service.list(f.b.id)).length, 0); await assert.rejects(f.service.exportReviewEdits(f.b.id, review.id, ['issue-1']), /未找到/);
  const revised = await f.service.exportReviewEdits(f.a.id, review.id, ['issue-1']); assert.match(revised.path, /\.docx$/); assert.notEqual(revised.path, f.doc.path);
  if (typeof revised.content !== 'string') assert.equal(copyableText(revised.content), '　　林夏推开门。\n\n　　雨停了。');
  assert.deepEqual(await fs.readFile(path.join(f.a.root, f.doc.path)), original);
  assert.ok(!JSON.stringify(await f.service.list(f.a.id)).includes('review-test-key'));
  const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '改变的设定' }, notes.hash);
  await assert.rejects(f.service.exportReviewEdits(f.a.id, review.id, ['issue-1']), /设定已更新/);
});
test('自动审稿失败边界：取消、不完整、设定更新、无效 JSON、子任务取消及恢复不重试', async t => {
  const f = await fixture(); t.after(f.close);
  let count = 0;
  let task = await f.service.start(f.request); await f.waitWriter(++count); await f.service.cancel(f.a.id, task.id); assert.equal((await f.terminal(task.id)).autoReview?.status, 'skipped'); assert.equal(f.calls.length, count);
  f.options({ writerFinish: 'length' }); task = await f.service.start(f.request); await f.waitWriter(++count); f.release(); assert.equal((await f.terminal(task.id)).autoReview?.status, 'skipped'); assert.equal(f.calls.length, count);
  f.options({}); task = await f.service.start(f.request); await f.waitWriter(++count); const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '新世界' }, notes.hash); f.release(); assert.match((await f.terminal(task.id)).autoReview?.error ?? '', /设定已变化/); assert.equal(f.calls.length, count);
  f.options({ invalidReview: true }); task = await f.service.start(f.request); await f.waitWriter(++count); f.release(); count++; const failed = await f.terminal(task.id); assert.equal(failed.status, 'complete', JSON.stringify(failed)); assert.equal(failed.autoReview?.status, 'failed'); const invalid = (await f.service.list(f.a.id)).find(t => t.id === failed.autoReview?.taskId)!; assert.equal(invalid.text, 'not-json'); await assert.rejects(f.service.exportReviewEdits(f.a.id, invalid.id, ['issue-1']), /完整/);
  f.options({ holdReview: true }); task = await f.service.start(f.request); await f.waitWriter(++count); f.release(); await f.waitWriter(++count); await f.service.cancel(f.a.id, task.id); assert.equal((await f.terminal(task.id)).autoReview?.status, 'failed');
  const file = path.join(f.local, 'ai-tasks', f.a.id, `${task.id}.json`); const saved = JSON.parse(await fs.readFile(file, 'utf8')); saved.autoReview.status = 'running'; await fs.writeFile(file, JSON.stringify(saved));
  const restored = new AIService(f.local, f.connections, f.workspace, new LibraryStore(id => f.workspace.getProject(id)), new CharacterStore(id => f.workspace.getProject(id)));
  assert.equal((await restored.list(f.a.id)).find(t => t.id === task.id)?.autoReview?.status, 'interrupted'); assert.equal(f.calls.length, count);
});
