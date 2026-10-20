import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AIService } from '../src/main/ai-service';
import { AIConnections, hashText } from '../src/main/ai-connections';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { ReviewDecisionStore, reviewReportFingerprint } from '../src/main/review-decisions';
import { reviewReportIdentityText } from '../src/core/review-identity';
import { textDocument } from '../src/main/text-import';
import type { AIRequest, AITask, ReviewDecisionSnapshot, ReviewDecisionRequest, RichNode } from '../src/shared/contracts';

const report = JSON.stringify({ summary: '虚构审稿', issues: [
  { category: '错别字', quote: '推开们', replacement: '推开门', reason: '门字误写', evidence: '' },
  { category: '语病', quote: '雨停了', replacement: '雨又下了', reason: '自选修改', evidence: '' },
  { category: '世界观', quote: '不存在的句子', replacement: '另句', reason: '无位置建议', evidence: '' }
] });
const until = async (predicate: () => Promise<boolean>) => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('等待审稿状态测试超时'); await new Promise(resolve => setTimeout(resolve, 10)); } };
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-decisions-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  const workspace = new Workspace(local, materials); await workspace.initialize();
  await Promise.all(['甲', '乙'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲')), b = await workspace.attach(path.join(root, '乙'));
  const library = new LibraryStore(id => workspace.getProject(id), materials), characters = new CharacterStore(id => workspace.getProject(id), materials);
  for (const project of [a, b]) await Promise.all([workspace.readNotes(project.id), library.read(project.id), characters.read(project.id)]);
  let calls = 0;
  const server = createServer(async (req, res) => { for await (const _ of req) {} calls++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: report }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connections = new AIConnections(local, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const settings = await connections.save({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, name: '虚构审稿', model: 'fictional', apiKey: 'fictional-key',
    adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 1024, tokenParameter: 'max_tokens', timeoutSeconds: 30 }, '');
  const restart = () => new AIService(local, connections, workspace, library, characters), service = restart();
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await until(async () => !service.hasPendingWork());
    assert.match(path.relative(os.tmpdir(), root), /^novel-decisions-[^\\/]+$/u); await fs.rm(root, { recursive: true, force: true }); });
  const doc = await workspace.createChapter(a.id, textDocument('林夏推开们。雨停了。'));
  const request: AIRequest = { projectId: a.id, chapterPath: doc.path, sourceHash: doc.hash, mode: 'review', reviewFormat: 'issues', connectionId: settings.connections[0].id, instruction: '审稿' };
  const start = async () => { const task = await service.start(request); await until(async () => !service.hasPendingWork()); const result = (await service.list(a.id)).find(item => item.id === task.id)!;
    assert.equal(result.status, 'complete', JSON.stringify(result)); return result; };
  const task = await start(), file = path.join(local, 'review-decisions', a.id, `${task.id}.json`), taskFile = path.join(local, 'ai-tasks', a.id, `${task.id}.json`);
  const read = () => service.reviewDecisions(a.id, task.id);
  const set = (snapshot: ReviewDecisionSnapshot, status: ReviewDecisionRequest['status'], issueId = 'issue-1') => service.setReviewDecision({ projectId: a.id, taskId: task.id,
    expectedHash: snapshot.hash, reportFingerprint: snapshot.reportFingerprint, issueId, status });
  const identity = { projectId: a.id, taskId: task.id, reportFingerprint: reviewReportFingerprint(task), issueIds: ['issue-1', 'issue-2', 'issue-3'] };
  const store = new ReviewDecisionStore(local, id => workspace.getProject(id));
  const mutateTask = async (change: (value: AITask) => void) => { const value = JSON.parse(await fs.readFile(taskFile, 'utf8')); change(value); await fs.writeFile(taskFile, JSON.stringify(value)); };
  return { root, local, materials, workspace, a, b, service, restart, doc, task, start, read, set, file, taskFile, identity, store, mutateTask, calls: () => calls };
}

test('首次读取只提供默认待处理、不创建文件；选择保存重启保留且旧版本有备份', async t => {
  const f = await fixture(t), first = await f.read(); assert.equal(first.hash, ''); assert.equal(first.stale, false);
  assert.deepEqual(first.items.map(item => item.status), ['pending', 'pending', 'pending']); assert.ok(first.items.every(item => item.updatedAt === ''));
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const second = await f.set(first, 'accepted'); assert.notEqual(second.hash, ''); assert.equal(second.items[0].status, 'accepted');
  const raw = await fs.readFile(f.file, 'utf8'), third = await f.set(second, 'ignored', 'issue-2');
  assert.equal(third.items[1].status, 'ignored'); assert.equal((await f.restart().reviewDecisions(f.a.id, f.task.id)).hash, third.hash);
  assert.equal(await fs.readFile(path.join(path.dirname(f.file), 'history', `${f.task.id}-${hashText(raw)}.json`), 'utf8'), raw);
  const persisted = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(persisted.items.length, 2); assert.equal(persisted.text, undefined); assert.equal(f.calls(), 1);
});

test('误报、忽略阻止另存；可显式重置后采用，applied记录真实副本路径和hash且不覆盖原稿', async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.a.root, f.doc.path));
  let state = await f.set(await f.read(), 'false-positive'); await assert.rejects(f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']), /误报/u);
  state = await f.set(state, 'ignored'); await assert.rejects(f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']), /忽略/u);
  state = await f.set(state, 'pending'); const output = await f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']);
  state = await f.read(); assert.equal(state.items[0].status, 'applied'); assert.equal(state.items[0].outputPath, output.path); assert.equal(state.items[0].outputHash, output.hash);
  assert.notEqual(output.path, f.doc.path); assert.deepEqual(await fs.readFile(path.join(f.a.root, f.doc.path)), original);
  await assert.rejects(f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']), /另存采纳/u);
  state = await f.set(state, 'pending'); assert.equal(state.items[0].outputPath, undefined);
  const another = await f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']); assert.notEqual(another.path, output.path);
});

test('每个问题和每份报告独立；跨书、伪造状态、无定位待采纳和未知问题拒绝', async t => {
  const f = await fixture(t), first = await f.set(await f.read(), 'accepted');
  assert.equal(first.items[1].status, 'pending'); const another = await f.start(); assert.equal((await f.service.reviewDecisions(f.a.id, another.id)).items[0].status, 'pending');
  await assert.rejects(f.service.reviewDecisions(f.b.id, f.task.id), /未找到/u);
  await assert.rejects(f.set(first, 'accepted', 'issue-3'), /定位/u);
  const request = { projectId: f.a.id, taskId: f.task.id, expectedHash: first.hash, reportFingerprint: first.reportFingerprint, issueId: 'issue-1', status: 'applied' };
  await assert.rejects(f.service.setReviewDecision(request as ReviewDecisionRequest));
  await assert.rejects(f.set(first, 'ignored', 'issue-99'), /不属于/u);
  const ignored = await f.set(first, 'false-positive', 'issue-3'); assert.equal(ignored.items[2].status, 'false-positive');
});

test('请求指纹和外部hash冲突不覆盖已有处理记录', async t => {
  const f = await fixture(t), first = await f.set(await f.read(), 'accepted'), raw = await fs.readFile(f.file, 'utf8');
  await assert.rejects(f.set({ ...first, reportFingerprint: 'a'.repeat(64) }, 'ignored'), /报告已变化/u);
  await assert.rejects(f.set({ ...first, hash: '' }, 'ignored'), /状态已变化/u);
  assert.equal(await fs.readFile(f.file, 'utf8'), raw);
});

test('正文/设定/同hash结构变化保留状态只读，禁止继续标记和另存', async t => {
  for (const kind of ['source', 'context', 'structure'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub), state = await f.set(await f.read(), 'accepted'), raw = await fs.readFile(f.file, 'utf8');
    if (kind === 'source') await fs.appendFile(path.join(f.a.root, f.doc.path), '外部修改');
    else if (kind === 'context') { const notes = await f.workspace.readNotes(f.a.id); await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '外部设定更新' }, notes.hash); }
    else { const file = path.join(f.a.root, '小说资料', 'documents', `${f.doc.hash}.json`), cached = JSON.parse(await fs.readFile(file, 'utf8'));
      (cached.content as RichNode).content![0].content![0].marks = [{ type: 'bold' }]; await fs.writeFile(file, JSON.stringify(cached)); }
    const stale = await f.read(); assert.equal(stale.stale, true); assert.equal(stale.items[0].status, 'accepted'); assert.match(stale.staleReason, /仅供查看/u);
    await assert.rejects(f.set(state, 'ignored')); await assert.rejects(f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']));
    assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  });
});

test('已存报告同taskId内容替换不得继承旧序号状态；原记录不变', async t => {
  const f = await fixture(t); await f.set(await f.read(), 'ignored'); const raw = await fs.readFile(f.file, 'utf8');
  await f.mutateTask(task => { task.text = task.text.replace('门字误写', '报告已重新生成'); });
  await assert.rejects(f.read(), /不匹配/u); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
});

test('未来schema、损坏、归属、指纹、重复问题、未知字段记录拒绝读取和覆盖', async t => {
  for (const kind of ['future', 'corrupt', 'project', 'task', 'fingerprint', 'duplicate', 'unknown'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub), state = await f.set(await f.read(), 'ignored'), value = JSON.parse(await fs.readFile(f.file, 'utf8'));
    if (kind === 'future') value.schemaVersion = 2;
    else if (kind === 'project') value.projectId = f.b.id;
    else if (kind === 'task') value.taskId = randomUUID();
    else if (kind === 'fingerprint') value.reportFingerprint = 'b'.repeat(64);
    else if (kind === 'duplicate') value.items.push(value.items[0]);
    else if (kind === 'unknown') value.future = true;
    const raw = kind === 'corrupt' ? '{broken' : JSON.stringify(value); await fs.writeFile(f.file, raw);
    await assert.rejects(f.read()); await assert.rejects(f.set(state, 'pending')); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  });
});

test('存储超限及身份路径注入拒绝；不读取其他小说记录', async t => {
  const f = await fixture(t); await assert.rejects(f.store.read({ ...f.identity, projectId: '../escape' }));
  await assert.rejects(f.store.read({ ...f.identity, taskId: '../escape' }));
  await fs.mkdir(path.dirname(f.file), { recursive: true }); await fs.writeFile(f.file, 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(f.read(), /大小|过大/u); assert.equal((await fs.stat(f.file)).size, 128 * 1024 + 1);
});

test('处理记录父目录junction拒绝，不读写被指向的外部目录', async t => {
  const f = await fixture(t), outside = path.join(f.root, '外部目录'); await fs.mkdir(outside);
  const marker = path.join(outside, '保留.txt'); await fs.writeFile(marker, '保留虚构文件');
  await fs.symlink(outside, path.join(f.local, 'review-decisions'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.read(), /目录或链接异常/u); assert.equal(await fs.readFile(marker, 'utf8'), '保留虚构文件');
});

test('报告身份覆盖原文、报告、上下文、引用、样式与连接快照，展示端可复算同一身份', async t => {
  const f = await fixture(t), fingerprint = reviewReportFingerprint(f.task);
  const changes: ((task: AITask) => void)[] = [
    task => { task.id = randomUUID(); }, task => { task.projectId = f.b.id; }, task => { task.text += ' '; },
    task => { task.sourceText += ' '; }, task => { task.sourceHash = 'a'.repeat(64); }, task => { task.chapterPath = '另一章.docx'; },
    task => { task.reviewTaskId = randomUUID(); }, task => { task.contextHash = 'b'.repeat(64); }, task => { task.context += '设定'; },
    task => { task.citationFingerprint = 'c'.repeat(64); }, task => { task.reviewDocumentHash = 'd'.repeat(64); },
    task => { task.connection.model = 'other-model'; }, task => { task.connection.baseUrl += '/other'; },
    task => { task.instruction += '另要求'; }, task => { task.createdAt = new Date(0).toISOString(); },
    task => { task.knowledgeCitations = [{ id: 'e'.repeat(64), projectId: task.projectId, corpus: 'canon', sourcePath: 'notes:world', sourceHash: 'f'.repeat(64), startParagraph: 0, endParagraph: 0 }]; },
    task => { task.styleSource = { name: '另一文风', sourceIds: [], sourceHashes: {}, sampled: false, sampleCharacters: 0, totalCharacters: 0,
      metrics: { characters: 0, paragraphs: 0, meanSentenceLength: 0, meanParagraphLength: 0, dialogueRatio: 0, firstPersonPerThousand: 0 } }; }
  ];
  for (const change of changes) { const task = structuredClone(f.task); change(task); assert.notEqual(reviewReportFingerprint(task), fingerprint); }
  const reverse = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
  const reordered = reverse(structuredClone(f.task)); reordered.connection = reverse(reordered.connection);
  assert.equal(reviewReportFingerprint(reordered), fingerprint);
  assert.equal(hashText(reviewReportIdentityText(reordered)), fingerprint);
  const cited = structuredClone(f.task); cited.knowledgeCitations = [{ id: 'e'.repeat(64), projectId: cited.projectId, corpus: 'canon', sourcePath: 'notes:world', sourceHash: 'f'.repeat(64), startParagraph: 0, endParagraph: 0 }];
  const other = structuredClone(cited); other.knowledgeCitations = other.knowledgeCitations!.map(reference => reverse(reference));
  assert.equal(reviewReportFingerprint(cited), reviewReportFingerprint(other));
});

test('发布前报告同名替换、状态外部变化或正文变化均阻止创建新DOCX', async t => {
  for (const kind of ['report', 'decision', 'source'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub), state = await f.set(await f.read(), 'accepted'), before = (await f.workspace.chapters(f.a.id)).length;
    const mutable = f.workspace as unknown as { recordState(...args: unknown[]): Promise<void> }, original = mutable.recordState.bind(f.workspace);
    mutable.recordState = async (...args) => { await original(...args);
      if (kind === 'report') await f.mutateTask(task => { task.instruction = '编码后替换报告身份'; });
      else if (kind === 'source') await fs.appendFile(path.join(f.a.root, f.doc.path), '保存期间修改');
      else { const value = JSON.parse(await fs.readFile(f.file, 'utf8')); value.items[0].status = 'ignored'; await fs.writeFile(f.file, JSON.stringify(value)); }
    };
    await assert.rejects(f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']));
    assert.equal((await f.workspace.chapters(f.a.id)).length, before); assert.notEqual(state.hash, '');
  });
});

test('状态保存前同taskId报告替换被末次find阻止，保留旧记录', async t => {
  const f = await fixture(t), first = await f.set(await f.read(), 'accepted'), raw = await fs.readFile(f.file, 'utf8');
  const mutable = f.service as unknown as { decisions: ReviewDecisionStore }, original = mutable.decisions.save.bind(mutable.decisions);
  mutable.decisions.save = async (identity, items, hash, callback) => { await f.mutateTask(task => { task.instruction = '替换后的报告身份'; }); return original(identity, items, hash, callback); };
  await assert.rejects(f.set(first, 'ignored'), /报告本身已变化/u); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
});

test('DOCX已成功创建但处理记录写入失败时返回副本及明确告警，不伪报正文失败', async t => {
  const f = await fixture(t), state = await f.set(await f.read(), 'accepted'), before = (await f.workspace.chapters(f.a.id)).length;
  const mutable = f.service as unknown as { decisions: ReviewDecisionStore }; mutable.decisions.save = async () => { throw new Error('fictional disk full'); };
  const output = await f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']);
  assert.equal((await f.workspace.chapters(f.a.id)).length, before + 1); assert.ok(output.warnings.some(warning => /副本已创建.*处理状态未保存/u.test(warning)));
  assert.equal((await f.read()).hash, state.hash); assert.equal((await f.read()).items[0].status, 'accepted');
  assert.equal((await f.workspace.readChapter(f.a.id, output.path)).hash, output.hash);
});

test('副本创建后同taskId报告替换仍不把旧建议标到新报告，返回已建副本告警', async t => {
  const f = await fixture(t); await f.set(await f.read(), 'accepted'); const original = await fs.readFile(f.file, 'utf8');
  const create = f.workspace.createChapter.bind(f.workspace);
  f.workspace.createChapter = async (...args) => { const output = await create(...args); await f.mutateTask(task => { task.instruction = '正文发布后报告被替换'; }); return output; };
  const output = await f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']);
  assert.ok(output.warnings.some(warning => /副本已创建.*处理状态未保存/u.test(warning)));
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.equal((await f.workspace.readChapter(f.a.id, output.path)).hash, output.hash);
});

test('本机处理队列对排队操作持续保护退出，旧hash第二次写失败且队列可恢复', async t => {
  const f = await fixture(t), state = await f.read(), mutable = f.service as unknown as { decisions: ReviewDecisionStore };
  const original = mutable.decisions.save.bind(mutable.decisions); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }); let blocked = false;
  mutable.decisions.save = async (...args) => { if (!blocked) { blocked = true; entered(); await gate; } return original(...args); };
  const first = f.set(state, 'ignored'); await started; const second = f.set(state, 'false-positive', 'issue-2'); const settled = second.then(() => 'success', () => 'conflict');
  assert.equal(f.service.hasPendingWork(), true); release(); await first; assert.equal(await settled, 'conflict');
  assert.equal(f.service.hasPendingWork(), false); const current = await f.read(); const last = await f.set(current, 'pending'); assert.equal(last.items[0].status, 'pending');
});

test('存储末次外部hash复核保留外部双方，默认未处理状态不能伪造已采纳记录', async t => {
  const f = await fixture(t), first = await f.read();
  await assert.rejects(f.store.save(f.identity, first.items.map(item => ({ ...item, status: 'applied' as const })), ''));
  await assert.rejects(f.store.save(f.identity, first.items.map(item => item.issueId === 'issue-1' ? { ...item, status: 'ignored', updatedAt: new Date().toISOString() } : item), '', async () => {
    await fs.writeFile(f.file, 'external-record', { flag: 'wx' });
  }), /变化|损坏/u);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'external-record');
});

test('带界面版本门闸的导出在入口拒绝同ID报告替换及外部状态变化，不产生副本', async t => {
  for (const kind of ['report', 'decision'] as const) await t.test(kind, async sub => {
    const f = await fixture(sub), displayed = await f.read(), before = (await f.workspace.chapters(f.a.id)).length;
    if (kind === 'report') await f.mutateTask(task => { task.text = task.text.replace('门字误写', '另一次报告'); });
    else await f.set(displayed, 'accepted', 'issue-2');
    await assert.rejects(f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1'], { reportFingerprint: displayed.reportFingerprint, expectedHash: displayed.hash }), /已变化/u);
    assert.equal((await f.workspace.chapters(f.a.id)).length, before);
  });
});

test('带版本门闸导出同步冻结guard与勾选数组；排队后改参数不能绕过入口校验', async t => {
  const f = await fixture(t), displayed = await f.read();
  const guard = { reportFingerprint: displayed.reportFingerprint, expectedHash: displayed.hash }, issues = ['issue-1'];
  const outputPromise = f.service.exportReviewEdits(f.a.id, f.task.id, issues, guard);
  guard.reportFingerprint = '0'.repeat(64); guard.expectedHash = '0'.repeat(64); issues[0] = 'issue-3';
  const output = await outputPromise; assert.ok(output.path.endsWith('.docx')); const state = await f.read();
  assert.equal(state.items[0].status, 'applied'); assert.equal(state.items[2].status, 'pending');
  assert.throws(() => f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-2'], { reportFingerprint: state.reportFingerprint, expectedHash: state.hash, future: true } as any));
});

test('旧版内部无guard导出仍兼容；界面guard错误不能以空白指纹绕过', async t => {
  const f = await fixture(t), state = await f.read();
  assert.throws(() => f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1'], { reportFingerprint: '', expectedHash: '' }));
  const output = await f.service.exportReviewEdits(f.a.id, f.task.id, ['issue-1']);
  assert.equal((await f.read()).items[0].outputHash, output.hash); assert.equal(state.hash, '');
});
