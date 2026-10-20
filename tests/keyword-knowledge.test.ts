import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chunkKnowledgeSource, KEYWORD_KNOWLEDGE_LIMITS, KeywordKnowledgeRetriever, type KeywordSource } from '../src/core/keyword-knowledge';
import type { RetrievalRequest } from '../src/core/knowledge';

const projectId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const source = (sourcePath: string, paragraphs: string[], extra: Partial<KeywordSource> = {}): KeywordSource => ({
  projectId, corpus: 'canon', sourcePath, sourceHash: digest(paragraphs.join('\n')),
  label: sourcePath, kind: 'chapter', paragraphs, confirmed: true, ...extra
});
const request = (sources: KeywordSource[], extra: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  scope: { projectId, corpus: 'canon', embeddingFingerprint: 'keyword-v1' }, query: '学园', topK: 100, mode: 'keyword',
  currentHashes: Object.fromEntries(sources.map(item => [item.sourcePath, item.sourceHash])), ...extra
});
const search = (retriever: KeywordKnowledgeRetriever, input: RetrievalRequest) => retriever.search(input, new AbortController().signal);

test('关键词分片保持真实文字、0起始段落定位与完整Unicode，重复长段的分片ID仍唯一', () => {
  const long = '🦊'.repeat(4501), original = source('第一章.docx', ['', '　　学园', '', '第一段', long, '尾声']);
  const chunks = chunkKnowledgeSource(original);
  assert.equal(chunks[0].text, '　　学园\n\n第一段');
  assert.equal(chunks[0].startParagraph, 1); assert.equal(chunks[0].endParagraph, 3);
  const pieces = chunks.filter(chunk => chunk.startParagraph === 4);
  assert.equal(pieces.length, 3);
  assert.equal(pieces.map((chunk, index) => Array.from(chunk.text).slice(index ? 99 : 0).join('')).join(''), long);
  assert.equal(new Set(pieces.map(chunk => chunk.id)).size, 3);
  assert.ok(pieces.every(chunk => chunk.endParagraph === 4 && Array.from(chunk.text).length <= 2000));
  assert.ok(pieces.every(chunk => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk.text)));
  assert.equal(chunks.at(-1)?.startParagraph, 5);
  assert.deepEqual(chunkKnowledgeSource(source('空.docx', ['', '  ', '　'])), []);
  assert.throws(() => chunkKnowledgeSource(source('坏.docx', ['\uD800'])), /Unicode/);
});

test('关键词ID依赖小说、用途、来源版本与文字；输入和返回结果不会改写检索快照', async () => {
  const original = source('原稿.docx', ['学园原文']); const expected = chunkKnowledgeSource(original);
  assert.deepEqual(chunkKnowledgeSource(structuredClone(original)), expected);
  for (const change of [{ projectId: otherId }, { corpus: 'style-reference' as const }, { sourceHash: digest('新版') }, { paragraphs: ['学园新版'] }])
    assert.notEqual(chunkKnowledgeSource({ ...original, ...change })[0].id, expected[0].id);
  const retriever = new KeywordKnowledgeRetriever([original]); const input = request([original]);
  original.paragraphs[0] = '外部改写'; original.confirmed = false; original.sourceHash = digest('改变');
  const first = await search(retriever, input); assert.equal(first.hits[0].chunk.text, '学园原文');
  first.hits[0].chunk.text = '结果被编辑'; first.hits[0].chunk.confirmed = false;
  const second = await search(retriever, input); assert.equal(second.hits[0].chunk.text, '学园原文'); assert.equal(second.hits[0].chunk.confirmed, true);
});

test('字面量任一词匹配不依赖模型；覆盖词数优先，重复次数次之，平分顺序稳定', async () => {
  const sources = [source('z.docx', ['学园'.repeat(20)]), source('b.docx', ['学园 fox']), source('a.docx', ['学园 FOX']), source('c.docx', ['FOX fox'])];
  const result = await search(new KeywordKnowledgeRetriever(sources), request(sources, { query: '学园 fox' }));
  assert.equal(result.usedMode, 'keyword'); assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.hits.map(hit => hit.chunk.sourcePath), ['a.docx', 'b.docx', 'z.docx', 'c.docx']);
  assert.ok(result.hits[1].score > result.hits[2].score);
  const otherOrder = await search(new KeywordKnowledgeRetriever([...sources].reverse()), request(sources, { query: 'FOX 学园 fox' }));
  assert.deepEqual(otherOrder.hits, result.hits);
  const literal = source('符号.docx', ['[a]+不是正则 . 学园']);
  assert.equal((await search(new KeywordKnowledgeRetriever([literal]), request([literal], { query: '[a]+' }))).hits.length, 1);
  assert.equal((await search(new KeywordKnowledgeRetriever([literal]), request([literal], { query: '不存在' }))).hits.length, 0);
  assert.equal((await search(new KeywordKnowledgeRetriever(sources), request(sources, { query: '学园 fox', topK: 1 }))).hits[0].chunk.sourcePath, 'a.docx');
  const crossing = source('长段.docx', ['x'.repeat(1998) + '图书馆' + 'x'.repeat(50)]);
  const crossingResult = await search(new KeywordKnowledgeRetriever([crossing]), request([crossing], { query: '图书馆' }));
  assert.equal(crossingResult.hits.length, 1);
  assert.ok(crossingResult.hits[0].chunk.text.includes('图书馆'));
});

test('旧版本与未确认正史不会命中，文风参考和讨论保持独立用途', async () => {
  const current = source('current.docx', ['学园']), stale = source('stale.docx', ['学园旧稿']), draft = source('draft.md', ['学园草稿'], { confirmed: false });
  const sources = [current, stale, draft];
  const result = await search(new KeywordKnowledgeRetriever(sources), request(sources, { currentHashes: { 'current.docx': current.sourceHash, 'stale.docx': digest('更新') } }));
  assert.deepEqual(result.hits.map(hit => hit.chunk.sourcePath), ['current.docx']);
  assert.equal((await search(new KeywordKnowledgeRetriever(sources), request(sources, { currentHashes: {} }))).hits.length, 0);
  for (const corpus of ['style-reference', 'discussion'] as const) {
    const isolated = source('reference.docx', ['学园参考'], { corpus, kind: 'reference', confirmed: false });
    const result = await search(new KeywordKnowledgeRetriever([isolated]), request([isolated], { scope: { projectId, corpus, embeddingFingerprint: 'keyword-v1' } }));
    assert.equal(result.hits.length, 1); assert.equal(result.hits[0].chunk.corpus, corpus); assert.equal(result.hits[0].chunk.confirmed, false);
  }
});

test('关键词检索拒绝串书、混用途、重复来源版本与冒充语义检索', async () => {
  const item = source('chapter.docx', ['学园']); const retriever = new KeywordKnowledgeRetriever([item]);
  assert.throws(() => new KeywordKnowledgeRetriever([item, { ...item, sourcePath: 'other.docx', projectId: otherId }]), /其他小说/);
  assert.throws(() => new KeywordKnowledgeRetriever([item, { ...item, sourcePath: 'style.docx', corpus: 'style-reference' }]), /其他用途/);
  assert.throws(() => new KeywordKnowledgeRetriever([item, { ...item }]), /路径重复/);
  assert.throws(() => new KeywordKnowledgeRetriever([item, { ...item, sourceHash: digest('新版') }]), /来源版本/);
  await assert.rejects(search(retriever, request([item], { scope: { projectId: otherId, corpus: 'canon', embeddingFingerprint: 'keyword-v1' } })), /其他小说/);
  await assert.rejects(search(retriever, request([item], { scope: { projectId, corpus: 'discussion', embeddingFingerprint: 'keyword-v1' } })), /其他用途/);
  for (const mode of ['semantic', 'hybrid'] as const) await assert.rejects(search(retriever, request([item], { mode })), /尚未接通/);
  assert.deepEqual(await search(new KeywordKnowledgeRetriever([]), request([])), { hits: [], usedMode: 'keyword', warnings: [] });
});

test('关键词来源与查询的边界真实拒绝，不静默截断文本或词项', async () => {
  const item = source('chapter.docx', ['学园']); const retriever = new KeywordKnowledgeRetriever([item]);
  assert.throws(() => chunkKnowledgeSource(source('oversize.docx', ['x'.repeat(200001)])), /格式无效/);
  assert.throws(() => chunkKnowledgeSource(source('oversize.docx', ['x'.repeat(100000), 'x'.repeat(100000)])), /20万/);
  assert.throws(() => chunkKnowledgeSource(source('paragraphs.docx', Array.from({ length: 10001 }, () => 'x'))), /格式无效/);
  assert.throws(() => new KeywordKnowledgeRetriever(Array.from({ length: 501 }, (_, index) => source(`${index}.docx`, ['x']))), /500/);
  assert.throws(() => new KeywordKnowledgeRetriever(Array.from({ length: 43 }, (_, index) => source(`${index}.docx`, ['x'.repeat(200000)]))), /8MiB/);
  assert.throws(() => new KeywordKnowledgeRetriever([{ ...item, projectId: 'other-book' }]), /格式无效/);
  assert.throws(() => new KeywordKnowledgeRetriever([{ ...item, sourceHash: 'unversioned' }]), /格式无效/);
  assert.throws(() => new KeywordKnowledgeRetriever([{ ...item, sourcePath: 'path\ncontrol' }]), /格式无效/);
  for (const query of [' ', 'x'.repeat(1001), 'x'.repeat(101), Array.from({ length: 17 }, (_, i) => `词${i}`).join(' ')])
    await assert.rejects(search(retriever, request([item], { query })), /查询/);
  for (const topK of [0, 101, 1.5]) await assert.rejects(search(retriever, request([item], { topK })), /格式无效/);
  await assert.rejects(search(retriever, request([item], { currentHashes: { 'chapter.docx': 'unversioned' } })), /格式无效/);
  assert.equal(KEYWORD_KNOWLEDGE_LIMITS.chunkCodePoints, 2000);
});

test('关键词检索冻结请求和来源版本；正在检索可取消且不交付部分命中', async () => {
  const item = source('chapter.docx', Array.from({ length: 100 }, () => '学园'.repeat(999)));
  const retriever = new KeywordKnowledgeRetriever([item]); const input = request([item]);
  const pending = search(retriever, input); input.query = '不存在'; input.currentHashes[item.sourcePath] = digest('后来改变'); input.scope.projectId = otherId;
  assert.ok((await pending).hits.length > 0);
  const aborted = new AbortController(); aborted.abort(new Error('已经停止'));
  await assert.rejects(retriever.search(request([item]), aborted.signal), /已经停止/);
  const controller = new AbortController(); const running = retriever.search(request([item]), controller.signal);
  const timer = setTimeout(() => controller.abort(new Error('停止当前检索')), 0);
  try { await assert.rejects(running, /停止当前检索/); } finally { clearTimeout(timer); }
});
