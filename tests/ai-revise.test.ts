import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import mammoth from 'mammoth';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { AIConnections } from '../src/main/ai-connections';
import { AIService } from '../src/main/ai-service';
import { textDocument } from '../src/main/text-import';
import type { AITask } from '../src/shared/contracts';

const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const report = (quote: string, replacement: string) => JSON.stringify({ summary: '本模型核对', issues: [{ category: '错别字', quote, replacement, reason: '明显笔误', evidence: '' }] });
const until = async (check: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error(`${what} 等待超时`); await new Promise(resolve => setTimeout(resolve, 15)); }
};
type Call = { model: string; messages: { role: string; content: string }[] };

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-revise-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲', '乙'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲')), b = await workspace.attach(path.join(root, '乙'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  await library.read(a.id); await characters.read(a.id);
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw) as { model: string; messages: { role: string; content: string }[] };
    calls.push({ model: body.model, messages: body.messages });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.model.startsWith('reviser')) { res.end(sse('林夏推开门。\n雨停了。')); return; }
    // Reviewer models only return a report; the quote differs so tests can pick the located or ambiguous one.
    res.end(sse(report(body.model === 'reviewer-dup' ? '雨停了。' : '推开们', body.model === 'reviewer-dup' ? '雨停了。' : '推开门')));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); });
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const, contextWindow: 32768, maxOutputTokens: 2048, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let hash = '';
  const reviewer: Record<string, string> = {};
  for (const model of ['reviewer', 'reviewer-dup', 'reviser']) {
    const saved = await connections.save({ name: model, ...base, model, apiKey: `fictional-${model}-key` }, hash);
    hash = saved.hash; reviewer[model] = saved.connections.at(-1)!.id;
  }
  const service = new AIService(local, connections, workspace, library, characters);
  const chapter = await workspace.createChapter(a.id, textDocument('林夏推开们。\n雨停了。'));
  return { root, workspace, service, a, b, calls, reviewer, chapter };
}
const waitTask = async (service: AIService, projectId: string, id: string): Promise<AITask> => {
  let task: AITask | undefined;
  await until(async () => { task = (await service.list(projectId)).find(item => item.id === id); return !!task && task.status !== 'running'; }, 'AI 任务');
  return task!;
};

test('修订模型：只发送所选已定位问题，产出新候选并可另存，原稿不动、不自动复审', async t => {
  const { workspace, service, a, calls, reviewer, chapter } = await fixture(t);
  const review = await service.start({ projectId: a.id, connectionId: reviewer.reviewer, mode: 'review', reviewFormat: 'issues', chapterPath: chapter.path, sourceHash: chapter.hash, instruction: '检查错别字' });
  const reviewed = await waitTask(service, a.id, review.id);
  assert.equal(reviewed.status, 'complete');
  assert.equal(calls.length, 1);

  const revise = await service.start({ projectId: a.id, connectionId: reviewer.reviser, mode: 'revise', chapterPath: chapter.path, sourceHash: chapter.hash, instruction: '按审稿意见修订', reviewTaskId: review.id, issueIds: ['issue-1'] });
  assert.equal(revise.mode, 'revise'); assert.deepEqual(revise.reviseIssueIds, ['issue-1']);
  const revised = await waitTask(service, a.id, revise.id);
  assert.equal(revised.status, 'complete'); assert.equal(revised.text.trim(), '林夏推开门。\n雨停了。');
  assert.equal(calls.length, 2); // one review + one revision, no automatic re-review
  const prompt = calls[1].messages[1].content;
  assert.match(prompt, /只处理下列 1 个已定位问题/u); assert.match(prompt, /把「推开们」改为「推开门」/u);
  assert.match(calls[1].messages[0].content, /修订编辑/u);
  // The revision request keeps the reviewed text as its source, not the live chapter.
  assert.match(prompt, /待修订正文：\n　　林夏推开们。/u);

  // The original stays byte-identical, and the candidate is exported as a new DOCX.
  assert.equal((await workspace.readChapter(a.id, chapter.path)).hash, chapter.hash);
  assert.match(JSON.stringify(await workspace.readChapter(a.id, chapter.path)), /推开们/u);
  const saved = await service.export(a.id, revise.id);
  assert.notEqual(saved.path, chapter.path);
  const exported = (await mammoth.extractRawText({ path: path.join(a.root, saved.path) })).value;
  assert.match(exported, /林夏推开门。/u); assert.doesNotMatch(exported, /推开们/u);
});

test('修订模型：拒绝未定位/不存在/跨报告问题、非报告来源、版本变化与跨书任务', async t => {
  const { workspace, service, a, b, calls, reviewer, chapter } = await fixture(t);
  const review = await service.start({ projectId: a.id, connectionId: reviewer.reviewer, mode: 'review', reviewFormat: 'issues', chapterPath: chapter.path, sourceHash: chapter.hash, instruction: '检查错别字' });
  await waitTask(service, a.id, review.id);
  const base = { projectId: a.id, mode: 'revise' as const, chapterPath: chapter.path, sourceHash: chapter.hash, instruction: '修订' };
  await assert.rejects(service.start({ ...base, connectionId: reviewer.reviser, reviewTaskId: review.id, issueIds: ['issue-9'] }), /不在该报告中/u);
  await assert.rejects(service.start({ ...base, connectionId: reviewer.reviser, reviewTaskId: review.id }), /修订任务需要审稿报告与至少一个已定位问题|issueIds/u);
  await assert.rejects(service.start({ ...base, connectionId: reviewer.reviser, issueIds: ['issue-1'] }), /修订问题只能用于|修订任务需要/u);
  // A completed write candidate is not a review report.
  const write = await service.start({ projectId: a.id, connectionId: reviewer.reviser, mode: 'write', chapterPath: chapter.path, sourceHash: chapter.hash, instruction: '续写' });
  await waitTask(service, a.id, write.id);
  await assert.rejects(service.start({ ...base, connectionId: reviewer.reviser, reviewTaskId: write.id, issueIds: ['issue-1'] }), /逐项审稿报告/u);
  // Another novel cannot borrow this report.
  const other = await workspace.createChapter(b.id, textDocument('乙书正文。'));
  await assert.rejects(service.start({ projectId: b.id, connectionId: reviewer.reviser, mode: 'revise', chapterPath: other.path, sourceHash: other.hash, instruction: '修订', reviewTaskId: review.id, issueIds: ['issue-1'] }), /本书中未找到/u);
  const before = calls.length;

  // A duplicated sentence has no unique location, so it cannot be handed to the revision model.
  const dup = await workspace.createChapter(a.id, textDocument('雨停了。\n雨停了。'));
  const dupReview = await service.start({ projectId: a.id, connectionId: reviewer['reviewer-dup'], mode: 'review', reviewFormat: 'issues', chapterPath: dup.path, sourceHash: dup.hash, instruction: '检查' });
  await waitTask(service, a.id, dupReview.id);
  await assert.rejects(service.start({ ...base, connectionId: reviewer.reviser, chapterPath: dup.path, sourceHash: dup.hash, reviewTaskId: dupReview.id, issueIds: ['issue-1'] }), /没有唯一原文定位/u);

  // After the chapter changes, neither a new revision nor an export of the old one is allowed.
  const latest = await workspace.readChapter(a.id, chapter.path);
  await workspace.saveChapter({ projectId: a.id, path: chapter.path, expectedHash: latest.hash, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　作者改过了。' }] }] } });
  const changed = await workspace.readChapter(a.id, chapter.path);
  await assert.rejects(service.start({ ...base, sourceHash: changed.hash, connectionId: reviewer.reviser, reviewTaskId: review.id, issueIds: ['issue-1'] }), /正文或设定已更新|章节已在外部变化|编辑结构/u);
  const revision = await service.start({ projectId: a.id, connectionId: reviewer.reviser, mode: 'revise', chapterPath: chapter.path, sourceHash: changed.hash, instruction: '修订' , reviewTaskId: review.id, issueIds: ['issue-1'] }).catch(() => null);
  assert.equal(revision, null); // no usable revision against a stale report
  assert.ok(calls.length >= before + 1); // the ambiguous report still cost one review call
  assert.equal(calls.filter(call => call.model === 'reviser' && call.messages[1].content.includes('待修订正文')).length, 0); // no revision reached HTTP
});
