import { listenLocalHttp } from './support/local-http';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { AIService } from '../src/main/ai-service';
import { AIConnections, hashText } from '../src/main/ai-connections';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { PlanningStore } from '../src/main/planning';
import { ChapterConfirmationStore } from '../src/main/chapter-confirmation';
import { KnowledgeService } from '../src/main/knowledge-service';
import { copyableText, normalizeParagraphs } from '../src/core/typography';
import type { AIRequest, AITask, KnowledgeCitationReference, RichNode } from '../src/shared/contracts';
import { WAIT_LIMIT } from './wait';

const richDocument: RichNode = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '第一集 夜雨', marks: [{ type: 'bold' }] }] },
  { type: 'paragraph', content: [{ type: 'text', text: '林夏推', marks: [{ type: 'bold' }] }, { type: 'text', text: '开们。', marks: [{ type: 'italic' }] }, { type: 'text', text: '雨停了。' }] },
  { type: 'paragraph', content: [] },
  { type: 'paragraph', content: [{ type: 'text', text: '未改', marks: [{ type: 'italic' }] }, { type: 'hardBreak' }, { type: 'text', text: '下一行。', marks: [{ type: 'bold' }] }] }
] };
const report = JSON.stringify({ summary: '虚构文本本地测试', issues: [
  { category: '错别字', quote: '推开们', replacement: '推开门', reason: '门字误写', evidence: '' },
  { category: '语病', quote: '夜雨', replacement: '清晨', reason: '可选建议', evidence: '' }
] });
const sse = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const until = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + WAIT_LIMIT;
  while (!await check()) { if (Date.now() > deadline) throw new Error('等待格式审稿测试超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-rich-review-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲书', '乙书'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲书')), b = await workspace.attach(path.join(root, '乙书'));
  const library = new LibraryStore(id => workspace.getProject(id), materials), characters = new CharacterStore(id => workspace.getProject(id), materials);
  const planning = new PlanningStore(id => workspace.getProject(id), materials), confirmations = new ChapterConfirmationStore(workspace, materials);
  const knowledge = new KnowledgeService(workspace, library, characters, planning, confirmations);
  for (const project of [a, b]) { await workspace.readNotes(project.id); await library.read(project.id); await characters.read(project.id); await planning.read(project.id); }
  const citationPath = '依据.txt'; await fs.writeFile(path.join(a.root, citationPath), '月钥只能开启北门。');
  const preview = await confirmations.preview(a.id, citationPath), initial = await confirmations.read(a.id, false);
  await confirmations.confirm({ projectId: a.id, path: preview.path, sourceHash: preview.hash, expectedHash: initial.hash });
  const hits = (await knowledge.search({ projectId: a.id, requestId: randomUUID(), corpus: 'canon', query: '月钥', topK: 10 })).hits;
  const refs: KnowledgeCitationReference[] = hits.map(hit => ({ id: hit.id, projectId: a.id, corpus: 'canon', sourcePath: hit.sourcePath,
    sourceHash: hit.sourceHash, startParagraph: hit.startParagraph, endParagraph: hit.endParagraph }));
  const calls: { model: string; messages: { content: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); calls.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse(body.model === 'writer' ? '候选林夏推开们。' : report));
  }); await listenLocalHttp(server);
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const base = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, adapter: 'generic' as const, thinking: 'default' as const, contextWindow: 32768,
    maxOutputTokens: 1024, tokenParameter: 'max_tokens' as const, timeoutSeconds: 30 };
  let settings = await connections.save({ ...base, model: 'reviewer', name: '审稿模型', apiKey: 'fictional-test-key' }, '');
  settings = await connections.save({ ...base, model: 'writer', name: '写作模型' }, settings.hash);
  const service = new AIService(local, connections, workspace, library, characters, planning, undefined, knowledge);
  const doc = await workspace.createChapter(a.id, structuredClone(richDocument));
  const sourceFile = path.join(a.root, doc.path), cacheFile = path.join(a.root, '小说资料', 'documents', `${doc.hash}.json`);
  const request: AIRequest = { projectId: a.id, chapterPath: doc.path, sourceHash: doc.hash, connectionId: settings.connections[0].id,
    mode: 'review', reviewFormat: 'issues', instruction: '检查虚构正文' };
  const get = async (id: string) => (await service.list(a.id)).find(task => task.id === id)!;
  const finished = async (id: string) => { await until(async () => !service.hasPendingWork()); return get(id); };
  const start = async (override: Partial<AIRequest> = {}) => finished((await service.start({ ...request, ...override })).id);
  const taskFile = (id: string) => path.join(local, 'ai-tasks', a.id, `${id}.json`);
  const cache = async (edit: (content: RichNode) => void) => { const state = JSON.parse(await fs.readFile(cacheFile, 'utf8')); edit(state.content); await fs.writeFile(cacheFile, JSON.stringify(state)); };
  const restart = () => new AIService(local, connections, workspace, library, characters, planning, undefined, knowledge);
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await until(async () => !service.hasPendingWork());
    assert.match(path.relative(os.tmpdir(), root), /^novel-rich-review-[^\\/]+$/u); await fs.rm(root, { recursive: true, force: true });
  });
  return { root, local, materials, workspace, a, b, library, characters, planning, knowledge, connections, settings, confirmations, service,
    doc, sourceFile, cacheFile, citationPath, refs, request, calls, get, start, finished, taskFile, cache, restart };
}

test('原章实际送审保存结构指纹，跨粗斜体建议采纳保留标题、软换行、空段及未选格式，原件字节不变', async t => {
  const f = await fixture(t), original = await fs.readFile(f.sourceFile), task = await f.start();
  assert.equal(task.status, 'complete'); assert.equal(task.reviewTaskId, undefined);
  assert.equal(task.reviewDocumentHash, hashText(JSON.stringify(normalizeParagraphs(f.doc.content as RichNode))));
  assert.match(f.calls[0].messages[1].content, /第一集 夜雨/u); assert.match(f.calls[0].messages[1].content, /林夏推开们/u);
  const revised = await f.service.exportReviewEdits(f.a.id, task.id, ['issue-1']); assert.notEqual(revised.path, f.doc.path);
  assert.equal(typeof revised.content, 'object'); const document = revised.content as RichNode;
  assert.equal(document.content!.length, 4); assert.deepEqual(document.content![0], (f.doc.content as RichNode).content![0]);
  assert.deepEqual(document.content![2], (f.doc.content as RichNode).content![2]); assert.deepEqual(document.content![3], (f.doc.content as RichNode).content![3]);
  assert.equal(copyableText(document), task.sourceText.replace('推开们', '推开门'));
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(f.a.root, revised.path))), xml = await zip.file('word/document.xml')!.async('string');
  const styles = await zip.file('word/styles.xml')!.async('string');
  assert.match(xml, /w:pStyle w:val="Heading2"/u); assert.match(xml, /<w:b\/>/u); assert.match(xml, /<w:i\/>/u); assert.match(xml, /<w:br\/>/u);
  assert.match(styles, /宋体/u); assert.match(styles, /w:sz w:val="21"/u); assert.match(xml, /　　/u);
  assert.deepEqual(await fs.readFile(f.sourceFile), original); assert.equal((await f.service.list(f.b.id)).length, 0);
  await assert.rejects(f.service.exportReviewEdits(f.b.id, task.id, ['issue-1']), /未找到/u);
  assert.equal((await f.restart().list(f.a.id)).find(item => item.id === task.id)!.reviewDocumentHash, task.reviewDocumentHash);
});

test('同正文、同原件hash但缓存样式变化后报告仍可读，禁止按旧格式采用', async t => {
  const f = await fixture(t), original = await fs.readFile(f.sourceFile), task = await f.start();
  await f.cache(content => { content.content![1].content![0].marks = [{ type: 'italic' }]; });
  const current = await f.workspace.readChapter(f.a.id, f.doc.path);
  assert.equal(current.hash, f.doc.hash); assert.equal(copyableText(current.content as RichNode), task.sourceText);
  const count = (await f.workspace.chapters(f.a.id)).length;
  await assert.rejects(f.service.exportReviewEdits(f.a.id, task.id, ['issue-1']), /结构/u);
  assert.equal((await f.workspace.chapters(f.a.id)).length, count); assert.equal((await f.get(task.id)).status, 'complete');
  assert.deepEqual(await fs.readFile(f.sourceFile), original);
});

test('旧版无结构指纹手动报告只在当前支持结构与送审文字完全一致时保留格式采纳', async t => {
  const f = await fixture(t), task = await f.start();
  const old: AITask = { ...task }; delete old.reviewDocumentHash; await fs.writeFile(f.taskFile(task.id), JSON.stringify(old));
  const revised = await f.restart().exportReviewEdits(f.a.id, task.id, ['issue-1']);
  assert.deepEqual((revised.content as RichNode).content![0], (f.doc.content as RichNode).content![0]);
  await f.cache(content => { content.content![1].content![0].text = '缓存原文被改写'; });
  await assert.rejects(f.restart().exportReviewEdits(f.a.id, task.id, ['issue-1']), /正文|文字|匹配/u);
});

test('缺失编辑缓存、未知格式或缓存文字变化不得静默降级为纯文本修改稿', async t => {
  for (const change of ['missing', 'format', 'text'] as const) await t.test(change, async sub => {
    const f = await fixture(sub), task = await f.start();
    const before = (await f.workspace.chapters(f.a.id)).length;
    if (change === 'missing') await fs.unlink(f.cacheFile);
    else await f.cache(content => { if (change === 'format') content.content![0].attrs!.alignment = 'right'; else content.content![1].content![0].text = '相同字节下伪造缓存'; });
    await assert.rejects(f.service.exportReviewEdits(f.a.id, task.id, ['issue-1']));
    assert.equal((await f.workspace.chapters(f.a.id)).length, before);
  });
});

test('手动候选审稿和自动候选审稿无原章格式指纹，另存仍为候选基本段落', async t => {
  const f = await fixture(t), original = await fs.readFile(f.sourceFile);
  const writer = await f.start({ mode: 'write', reviewFormat: undefined, connectionId: f.settings.connections[1].id, autoReviewConnectionId: f.settings.connections[0].id });
  assert.equal(writer.reviewDocumentHash, undefined); assert.equal(writer.autoReview!.status, 'complete');
  const automatic = await f.get(writer.autoReview!.taskId!), manual = await f.start({ reviewTaskId: writer.id });
  for (const task of [automatic, manual]) {
    assert.equal(task.reviewDocumentHash, undefined); assert.equal(task.sourceText, writer.text);
    const revised = await f.service.exportReviewEdits(f.a.id, task.id, ['issue-1']), content = revised.content as RichNode;
    assert.equal(copyableText(content), '　　候选林夏推开门。'); assert.ok(content.content!.every(block => block.type === 'paragraph'));
    assert.ok(content.content!.every(block => block.content!.every(run => !run.marks?.length)));
  }
  assert.deepEqual(await fs.readFile(f.sourceFile), original);
});

test('新结构指纹历史严格校验用途、候选关联、hash格式和schemaVersion，未知资料原样保留', async t => {
  const f = await fixture(t), task = await f.start(), file = f.taskFile(task.id);
  const malformed: Record<string, unknown>[] = [{ mode: 'write' }, { reviewTaskId: randomUUID() }, { reviewDocumentHash: 'future-fingerprint' }, { schemaVersion: 2 }];
  for (const edit of malformed) {
    const raw = JSON.stringify({ ...task, ...edit }); await fs.writeFile(file, raw);
    await assert.rejects(f.restart().list(f.a.id)); assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});

test('启动时未知格式和未托管TXT在模型HTTP前拒绝，保留原稿和任务目录', async t => {
  const f = await fixture(t); await f.cache(content => { content.content![0].attrs!.align = 'center'; });
  await assert.rejects(f.service.start(f.request), /格式|属性|支持/u); assert.equal(f.calls.length, 0);
  await fs.writeFile(path.join(f.a.root, '原始UTF16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('旧编码推开们。', 'utf16le')]));
  const chapter = await f.workspace.readChapter(f.a.id, '原始UTF16.txt');
  await assert.rejects(f.service.start({ ...f.request, chapterPath: chapter.path, sourceHash: chapter.hash }), /编辑结构/u);
  assert.equal(f.calls.length, 0); assert.equal((await f.service.list(f.a.id)).length, 0);
});

test('正文、设定和正式引用变化使原章报告不能另存，历史和原件保留', async t => {
  for (const change of ['source', 'context', 'citation'] as const) await t.test(change, async sub => {
    const f = await fixture(sub), task = await f.start({ knowledgeCitations: f.refs });
    const count = (await f.workspace.chapters(f.a.id)).length;
    if (change === 'source') await fs.appendFile(f.sourceFile, 'external-change');
    else if (change === 'context') { const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '新世界观' }, notes.hash); }
    else await fs.writeFile(path.join(f.a.root, f.citationPath), '月钥已经失效。');
    await assert.rejects(f.service.exportReviewEdits(f.a.id, task.id, ['issue-1']), /正文或设定已更新/u);
    assert.equal((await f.workspace.chapters(f.a.id)).length, count); assert.equal((await f.get(task.id)).text, task.text);
  });
});

test('编码或缓存持久化期间原文/结构/设定/引用变化，最终发布门闸阻止新正文', async t => {
  for (const change of ['source', 'structure', 'context', 'citation'] as const) await t.test(change, async sub => {
    const f = await fixture(sub), task = await f.start({ knowledgeCitations: f.refs });
    const count = (await f.workspace.chapters(f.a.id)).length;
    const recordState = (f.workspace as any).recordState.bind(f.workspace);
    (f.workspace as any).recordState = async (...args: unknown[]) => {
      await recordState(...args);
      if (change === 'source') await fs.appendFile(f.sourceFile, 'changed-during-encoding');
      else if (change === 'structure') await f.cache(content => { content.content![1].content![0].marks = [{ type: 'italic' }]; });
      else if (change === 'context') {
        const file = path.join(f.materials, f.a.id, '创作笔记.md'), raw = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, raw.replace('<!-- nw-field:world -->\n', '<!-- nw-field:world -->\n编码期间外部世界观变更'));
      } else await fs.writeFile(path.join(f.a.root, f.citationPath), '编码期间外部引用变更');
    };
    await assert.rejects(f.service.exportReviewEdits(f.a.id, task.id, ['issue-1']), /更新|结构|引用/u);
    assert.equal((await f.workspace.chapters(f.a.id)).length, count);
  });
});

test('候选原稿另存也在编码后复核依据，最终回调拒绝时不发布新正文', async t => {
  const f = await fixture(t), task = await f.start({ mode: 'write', reviewFormat: undefined, connectionId: f.settings.connections[1].id });
  const count = (await f.workspace.chapters(f.a.id)).length;
  const recordState = (f.workspace as any).recordState.bind(f.workspace);
  (f.workspace as any).recordState = async (...args: unknown[]) => { await recordState(...args); await fs.appendFile(f.sourceFile, 'changed-before-publish'); };
  await assert.rejects(f.service.export(f.a.id, task.id), /正文或设定已更新/u);
  assert.equal((await f.workspace.chapters(f.a.id)).length, count);
});

test('Workspace内部发布回调可读取原章且在写入新正文前执行，失败无新文稿', async t => {
  const f = await fixture(t), count = (await f.workspace.chapters(f.a.id)).length;
  let checks = 0;
  await assert.rejects(f.workspace.createChapter(f.a.id, structuredClone(richDocument), 'docx', async () => {
    checks++; assert.equal((await f.workspace.readChapter(f.a.id, f.doc.path)).hash, f.doc.hash);
    assert.equal((await f.workspace.chapters(f.a.id)).length, count); throw new Error('模拟发布保护失败');
  }), /发布保护失败/u);
  assert.equal(checks, 1); assert.equal((await f.workspace.chapters(f.a.id)).length, count);
});

test('原章任务初始持久化期间同hash缓存仅样式变化，最终发送门闸阻止第一笔HTTP', async t => {
  const f = await fixture(t), original = await fs.readFile(f.sourceFile), originalText = copyableText(f.doc.content as RichNode);
  const mutable = f.service as unknown as { persist(task: AITask): Promise<void> }, persist = mutable.persist.bind(f.service);
  let changed = false;
  mutable.persist = async task => {
    await persist(task);
    if (changed || task.mode !== 'review' || task.reviewTaskId || task.status !== 'running') return;
    changed = true;
    await f.cache(content => { content.content![1].content![0].marks = [{ type: 'italic' }]; });
  };
  const task = await f.start(), current = await f.workspace.readChapter(f.a.id, f.doc.path);
  assert.equal(changed, true); assert.equal(current.hash, f.doc.hash); assert.equal(copyableText(current.content as RichNode), originalText);
  assert.equal(task.status, 'failed'); assert.match(task.error, /格式或编辑结构已变化/u); assert.match(task.error, /未发起模型请求/u);
  assert.equal(task.text, ''); assert.equal(f.calls.length, 0); assert.equal(f.service.hasPendingWork(), false);
  assert.equal((await f.restart().list(f.a.id)).find(saved => saved.id === task.id)!.status, 'failed');
  assert.deepEqual(await fs.readFile(f.sourceFile), original);
});
