import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { CharacterStore } from '../src/main/characters';
import { PlanningStore } from '../src/main/planning';
import { KnowledgeService } from '../src/main/knowledge-service';
import { emptyCharacter } from '../src/core/characters';
import { textDocument } from '../src/main/text-import';
import { encodeDocx } from '../src/main/docx';
import type { KnowledgeSearchRequest } from '../src/shared/contracts';
import type { KnowledgeChunk } from '../src/core/knowledge';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext, index?: ConstructorParameters<typeof KnowledgeService>[5], rerank?: ConstructorParameters<typeof KnowledgeService>[6]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-knowledge-test-'));
  t.after(async () => {
    assert.match(path.relative(os.tmpdir(), root), /^novel-knowledge-test-[^\\/]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const materials = path.join(root, 'materials');
  const workspace = new Workspace(path.join(root, 'local'), materials); await workspace.initialize();
  await Promise.all(['甲书', '乙书'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲书')), b = await workspace.attach(path.join(root, '乙书'));
  const library = new LibraryStore(id => workspace.getProject(id), materials);
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  const planning = new PlanningStore(id => workspace.getProject(id), materials);
  // Initialize the stores' existing Markdown migrations before checking that a search makes no writes.
  for (const id of [a.id, b.id]) { await workspace.readNotes(id); await characters.read(id); await library.read(id); await planning.read(id); }
  const service = new KnowledgeService(workspace, library, characters, planning, undefined, index, rerank);
  return { root, materials, workspace, library, characters, planning, service, a, b };
}
const request = (projectId: string, corpus: KnowledgeSearchRequest['corpus'] = 'discussion', query = '月钥'): KnowledgeSearchRequest => ({ projectId, requestId: randomUUID(), corpus, query, topK: 100 });

test('语义检索：索引可用时走向量结果并报告 semantic，不丢版本校验', async t => {
  const calls: string[] = [];
  let chunk: KnowledgeChunk | null = null;
  const port = {
    capability: async () => ({ embedding: true, index: true, stale: false, fingerprint: 'f'.repeat(64) }),
    embedQuery: async () => { calls.push('embed'); return { vector: [1, 0], fingerprint: 'f'.repeat(64) }; },
    search: async () => { calls.push('search'); return { hits: chunk ? [{ chunk, score: 0.9, embeddingFingerprint: 'f'.repeat(64) }] : [], warnings: [] }; }
  };
  const f = await fixture(t, port);
  const doc = await f.workspace.createChapter(f.a.id, textDocument('月钥在谷仓里。'));
  const baseline = await f.service.search(request(f.a.id, 'discussion', '月钥'));
  assert.ok(baseline.hits.length, '关键词检索应先命中本章');
  const base = baseline.hits[0];
  chunk = { id: 'semantic-1', projectId: base.projectId, corpus: base.corpus, sourcePath: base.sourcePath, sourceHash: base.sourceHash,
    startParagraph: base.startParagraph, endParagraph: base.endParagraph, text: '语义命中的段落', confirmed: base.confirmed };
  const result = await f.service.search({ ...request(f.a.id, 'discussion', '谷仓'), mode: 'semantic' });
  assert.equal(result.usedMode, 'semantic');
  assert.deepEqual(calls, ['embed', 'search']);
  assert.ok(result.hits.some(hit => hit.text === '语义命中的段落'));
  assert.deepEqual(result.warnings.filter(text => /降级|不可用/.test(text)), []);
});

test('混合检索：关键词与语义都进结果；索引缺失时降级且不调用嵌入', async t => {
  let embedded = 0;
  let chunk: KnowledgeChunk | null = null;
  const port = {
    capability: async () => ({ embedding: true, index: true, stale: false, fingerprint: 'f'.repeat(64) }),
    embedQuery: async () => { embedded++; return { vector: [1, 0], fingerprint: 'f'.repeat(64) }; },
    search: async () => ({ hits: chunk ? [{ chunk, score: 0.5, embeddingFingerprint: 'f'.repeat(64) }] : [], warnings: [] })
  };
  const f = await fixture(t, port);
  await f.workspace.createChapter(f.a.id, textDocument('月钥与雨声。'));
  const baseline = await f.service.search(request(f.a.id, 'discussion', '月钥'));
  assert.ok(baseline.hits.length, '关键词检索应先命中本章');
  const base = baseline.hits[0];
  chunk = { id: 'semantic-2', projectId: base.projectId, corpus: base.corpus, sourcePath: base.sourcePath, sourceHash: base.sourceHash,
    startParagraph: base.startParagraph, endParagraph: base.endParagraph, text: '仅语义命中', confirmed: base.confirmed };
  const hybrid = await f.service.search({ ...request(f.a.id, 'discussion', '月钥'), mode: 'hybrid' });
  assert.equal(hybrid.usedMode, 'hybrid');
  assert.equal(embedded, 1);
  assert.ok(hybrid.hits.some(hit => hit.text === '仅语义命中'));
  assert.ok(hybrid.hits.some(hit => hit.text.includes('月钥')));

  const degraded = await fixture(t, { ...port, capability: async () => ({ embedding: true, index: false, stale: false }) });
  const before = embedded;
  const fallback = await degraded.service.search({ ...request(degraded.a.id, 'discussion', '月钥'), mode: 'hybrid' });
  assert.equal(fallback.usedMode, 'keyword');
  assert.equal(embedded, before, '没有索引时不应调用嵌入');
  assert.match(fallback.warnings.join('\n'), /向量索引|重建/u);
});

test('语义/混合检索在未接嵌入时明确降级为关键词，usedMode 报实际模式', async t => {
  const f = await fixture(t);
  const baseline = await f.service.search(request(f.a.id, 'canon'));
  for (const mode of ['semantic', 'hybrid'] as const) {
    const result = await f.service.search({ ...request(f.a.id, 'canon'), mode });
    assert.equal(result.usedMode, 'keyword', `${mode} 必须报告实际执行的关键词检索`);
    assert.equal(result.hits.length, baseline.hits.length, '降级不应丢结果');
    assert.match(result.warnings.join('\n'), /嵌入连接|向量索引/u);
  }
  assert.equal(baseline.usedMode, 'keyword');
  assert.deepEqual(baseline.warnings.filter(text => /嵌入连接|向量索引/u.test(text)), [], '纯关键词检索不应出现降级告警');
});
async function files(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(absolute, relative));
    else if (entry.isFile()) result[relative] = hash(await fs.readFile(absolute));
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

test('正式设定只含保存世界观、启用角色和确认大纲；正文与另存候选单独检索且不自动成为正史', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.a.id, textDocument('月钥打开虚构的北塔。\n两个真实空格保留。'));
  // AIService.export uses this same chapter creation path, without adoption provenance.
  const candidate = await f.workspace.createChapter(f.a.id, textDocument('月钥另存未采纳AI候选，不能自动成为正史。'));
  await f.workspace.createChapter(f.b.id, textDocument('月钥属于乙书的秘密，绝不串书。'));
  let notes = await f.workspace.readNotes(f.a.id);
  notes = await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥世界有两个太阳。', characters: '月钥旧人物笔记已经保存。', preset: '月钥不应出现的预设指令', style: '月钥不应出现的旧文风' }, notes.hash);
  const card = { ...emptyCharacter(), name: '月钥学者', description: '月钥学者只住在北塔。', examples: '月钥不应出现的对话示例', firstMessage: '月钥不应出现的开场白', creatorNotes: '月钥不应出现的作者说明' };
  let cards = await f.characters.read(f.a.id);
  cards = await f.characters.save(f.a.id, { fields: card, enabled: true }, cards.hash);
  cards = await f.characters.save(f.a.id, { fields: { ...emptyCharacter(), name: '月钥不应出现的停用角色' }, enabled: false }, cards.hash);
  let plan = await f.planning.read(f.a.id);
  plan = await f.planning.save(f.a.id, { ...plan.value, outline: '月钥已确认大纲：打开北塔后归还钥匙。', drafts: { ...plan.value.drafts, outline: '月钥不应出现的筹备废稿' }, briefs: { ...plan.value.briefs, world: '月钥不应出现的构想' } }, plan.hash);
  let book = await f.library.read(f.a.id);
  book = await f.library.addSources(f.a.id, [{ name: '参考.txt', text: '月钥不应出现的参考作品剧情。' }], book.hash);
  const before = await files(f.root);
  const input = request(f.a.id, 'canon'), result = await f.service.search(input);
  assert.equal(result.projectId, f.a.id); assert.equal(result.requestId, input.requestId); assert.equal(result.usedMode, 'keyword');
  assert.equal(result.sourceCount, 4); assert.equal(result.hits.length, 4);
  assert.deepEqual(new Set(result.hits.map(hit => hit.sourceKind)), new Set(['world', 'character', 'outline']));
  assert.ok(result.hits.every(hit => hit.projectId === f.a.id && hit.corpus === 'canon' && hit.confirmed && /^[a-f0-9]{64}$/.test(hit.sourceHash)));
  const raw = JSON.stringify(result); assert.doesNotMatch(raw, /乙书的秘密|不应出现|未采纳AI候选|打开虚构的北塔/);
  const manuscript = await f.service.search(request(f.a.id));
  assert.equal(manuscript.hits.length, 2); assert.equal(manuscript.sourceCount, 2);
  assert.ok(manuscript.hits.every(hit => hit.corpus === 'discussion' && hit.sourceKind === 'chapter' && !hit.confirmed));
  assert.ok(manuscript.hits.some(hit => hit.sourcePath === `chapters:${candidate.path}` && hit.text.includes('未采纳AI候选')));
  assert.doesNotMatch(JSON.stringify(manuscript), /两个太阳|旧人物笔记|学者只住|已确认大纲|不应出现|乙书的秘密/);
  const body = manuscript.hits.find(hit => hit.sourcePath === `chapters:${chapter.path}`)!;
  assert.equal(body.sourcePath, `chapters:${chapter.path}`); assert.equal(body.sourceHash, chapter.hash);
  assert.match(body.text, /\u3000\u3000月钥/); assert.equal(body.startParagraph, 0); assert.equal(body.endParagraph, 1);
  assert.deepEqual(await files(f.root), before);
  const other = await f.service.search(request(f.b.id)); assert.equal(other.hits.length, 1); assert.match(other.hits[0].text, /乙书的秘密/);
});

test('参考库单独检索已登记TXT/DOCX原件，固定原始哈希/段落且不混入正史或另一书', async t => {
  const f = await fixture(t);
  await f.workspace.createChapter(f.a.id, textDocument('月钥正史不进入参考库。'));
  let book = await f.library.read(f.a.id);
  const original = await encodeDocx(textDocument('月钥参考DOCX第一段。\n月钥参考DOCX第二段。'));
  book = await f.library.addSources(f.a.id, [
    { name: '参考甲.txt', text: '月钥参考TXT第一行。\n月钥参考TXT第二行。' },
    { name: '参考乙.docx', text: '月钥参考DOCX第一段。\n月钥参考DOCX第二段。', original }
  ], book.hash);
  const other = await f.library.read(f.b.id); await f.library.addSources(f.b.id, [{ name: '参考甲.txt', text: '月钥乙书参考秘密。' }], other.hash);
  await fs.writeFile(path.join(f.a.root, '小说资料', 'style-sources', '未登记.txt'), '月钥未登记文件不能读取。');
  const before = await files(f.root), result = await f.service.search(request(f.a.id, 'style-reference'));
  assert.equal(result.hits.length, 2); assert.equal(result.sourceCount, 2);
  assert.ok(result.hits.every(hit => hit.corpus === 'style-reference' && hit.sourceKind === 'reference' && !hit.confirmed));
  assert.doesNotMatch(JSON.stringify(result), /正史不进入|乙书参考秘密|未登记文件/);
  const docxHit = result.hits.find(hit => hit.sourceLabel.includes('.docx'))!;
  assert.equal(docxHit.sourceHash, hash(original)); assert.equal(docxHit.startParagraph, 0); assert.equal(docxHit.endParagraph, 1);
  assert.ok(result.warnings.some(warning => warning.includes('复杂排版')));
  assert.deepEqual(await files(f.root), before);
});

test('检索过程中被外部覆盖的正文和参考原件旧版本丢弃并明确提示，之后读取新版本', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.a.id, textDocument('月钥旧版正文。'), 'txt');
  const readChapter = f.workspace.readChapterKnowledge.bind(f.workspace); let changed = false;
  f.workspace.readChapterKnowledge = async (...args) => {
    const snapshot = await readChapter(...args);
    if (!changed) { changed = true; await fs.writeFile(path.join(f.a.root, chapter.path), '月钥新版正文。'); }
    return snapshot;
  };
  const stale = await f.service.search(request(f.a.id));
  assert.equal(stale.hits.length, 0); assert.equal(stale.sourceCount, 0); assert.ok(stale.warnings.some(warning => warning.includes('旧版本结果已排除')));
  assert.match((await f.service.search(request(f.a.id))).hits[0].text, /新版正文/);
  let book = await f.library.read(f.a.id); book = await f.library.addSources(f.a.id, [{ name: '参考.txt', text: '月钥旧版参考。' }], book.hash);
  const readStyle = f.library.readStyleSources.bind(f.library); let referenceChanged = false;
  f.library.readStyleSources = async (...args) => {
    const snapshot = await readStyle(...args);
    if (!referenceChanged) { referenceChanged = true; await fs.writeFile(path.join(f.a.root, '小说资料', 'style-sources', `${book.value.sources[0].id}.txt`), '月钥新版参考。'); }
    return snapshot;
  };
  const staleReference = await f.service.search(request(f.a.id, 'style-reference'));
  assert.equal(staleReference.hits.length, 0); assert.ok(staleReference.warnings.some(warning => warning.includes('旧版本结果已排除')));
  assert.match((await f.service.search(request(f.a.id, 'style-reference'))).hits[0].text, /新版参考/);
});

test('DOCX检索绑定原件字节，改写同哈希编辑缓存不会伪造来源文字', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.a.id, textDocument('月钥真实DOCX文字必须来自原件。'));
  const originalFile = path.join(f.a.root, chapter.path), originalBytes = await fs.readFile(originalFile);
  const stateFile = path.join(f.a.root, '小说资料', 'documents', `${chapter.hash}.json`);
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(state.projectId, f.a.id); assert.equal(state.hash, chapter.hash);
  state.content = textDocument('伪造缓存文字不能以同一个DOCX哈希进入检索。');
  await fs.writeFile(stateFile, JSON.stringify(state));
  const tamperedCache = await fs.readFile(stateFile);
  const result = await f.service.search(request(f.a.id, 'discussion', '月钥'));
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].sourceHash, hash(originalBytes));
  assert.match(result.hits[0].text, /真实DOCX文字必须来自原件/);
  assert.doesNotMatch(result.hits[0].text, /伪造缓存文字/);
  assert.equal((await f.service.search(request(f.a.id, 'discussion', '伪造缓存文字'))).hits.length, 0);
  assert.deepEqual(await fs.readFile(originalFile), originalBytes);
  assert.deepEqual(await fs.readFile(stateFile), tamperedCache);
});

test('准备期间保留请求占位，可取消且错误小说或请求ID不取消；失败后可重新检索', async t => {
  const f = await fixture(t);
  await f.workspace.createChapter(f.a.id, textDocument('月钥取消保护。'));
  const chapters = f.workspace.chapters.bind(f.workspace);
  let entered!: () => void, release!: () => void;
  const reset = () => { const wait = new Promise<void>(resolve => release = resolve); const ready = new Promise<void>(resolve => entered = resolve); f.workspace.chapters = async id => { entered(); await wait; return chapters(id); }; return ready; };
  let ready = reset(); const first = request(f.a.id), pending = f.service.search(first); await ready;
  await assert.rejects(f.service.search(request(f.b.id)), /已有检索/);
  f.service.cancel(f.b.id, first.requestId); f.service.cancel(f.a.id, randomUUID()); release();
  assert.equal((await pending).hits.length, 1);
  ready = reset(); const second = request(f.a.id), stopping = f.service.search(second); await ready;
  f.service.cancel(f.a.id, second.requestId); release(); await assert.rejects(stopping, /检索已停止/);
  f.workspace.chapters = chapters;
  assert.equal((await f.service.search(request(f.a.id))).hits.length, 1);
});

test('损坏DOCX/未知编码被跳过并报告部分覆盖；外部DOCX仅提取且原件不变', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.a.root, '损坏.docx'), '损坏的压缩包');
  await fs.writeFile(path.join(f.a.root, '编码损坏.txt'), Buffer.from([0x81]));
  const original = await encodeDocx(textDocument('月钥外部Word正文。'));
  await fs.writeFile(path.join(f.a.root, '外部.docx'), original);
  const before = await files(f.root), result = await f.service.search(request(f.a.id));
  assert.equal(result.hits.length, 1); assert.match(result.hits[0].text, /外部Word正文/);
  assert.ok(result.warnings.some(warning => warning.includes('部分') || warning.includes('未覆盖')));
  assert.ok(result.warnings.some(warning => warning.includes('编码无法可靠识别')));
  assert.ok(result.warnings.some(warning => warning.includes('复杂排版')));
  assert.ok(result.warnings.every(warning => !warning.includes(f.root)));
  assert.deepEqual(await files(f.root), before); assert.deepEqual(await fs.readFile(path.join(f.a.root, '外部.docx')), original);
});

test('非法请求、串书读结果及来源数量/字符/总量上限明确失败，不返回截断的成功', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.search({ ...request(f.a.id), corpus: 'unknown' } as unknown as KnowledgeSearchRequest), /请求无效/);
  await assert.rejects(f.service.search({ ...request(f.a.id), topK: 0 }), /请求无效/);
  await assert.rejects(f.service.search({ ...request(f.a.id), query: 'x'.repeat(101) }), /每词不超过100/);
  await fs.writeFile(path.join(f.a.root, '超长.txt'), '月'.repeat(200001));
  await assert.rejects(f.service.search(request(f.a.id)), /超过读取限制/);
  await fs.unlink(path.join(f.a.root, '超长.txt'));
  const chapters = f.workspace.chapters.bind(f.workspace);
  f.workspace.chapters = async () => Array.from({ length: 501 }, (_, i) => ({ path: `${i}.txt`, name: `${i}.txt` }));
  await assert.rejects(f.service.search(request(f.a.id)), /超过500/);
  const read = f.workspace.readChapterKnowledge.bind(f.workspace);
  f.workspace.chapters = async () => Array.from({ length: 15 }, (_, i) => ({ path: `${i}.txt`, name: `${i}.txt` }));
  f.workspace.readChapterKnowledge = async (projectId, relative) => ({ projectId, path: relative, hash: hash(relative), paragraphs: ['月'.repeat(199999)], warnings: [] });
  await assert.rejects(f.service.search(request(f.a.id)), /总量超过8 MiB/);
  f.workspace.chapters = async () => [{ path: '串书.txt', name: '串书.txt' }];
  f.workspace.readChapterKnowledge = async (_, relative) => ({ projectId: f.b.id, path: relative, hash: hash(relative), paragraphs: ['月钥'], warnings: [] });
  await assert.rejects(f.service.search(request(f.a.id)), /另一部小说/);
  f.workspace.chapters = chapters; f.workspace.readChapterKnowledge = read;
  await fs.writeFile(path.join(f.a.root, '正常.txt'), '月钥正常恢复。');
  assert.equal((await f.service.search(request(f.a.id))).hits.length, 1);
});
