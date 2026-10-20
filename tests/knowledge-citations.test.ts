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
import { ChapterConfirmationStore } from '../src/main/chapter-confirmation';
import { KnowledgeService } from '../src/main/knowledge-service';
import { emptyCharacter } from '../src/core/characters';
import { textDocument } from '../src/main/text-import';
import type { KnowledgeCitationReference, KnowledgeSearchHit, KnowledgeSearchRequest } from '../src/shared/contracts';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-knowledge-citations-'));
  t.after(async () => {
    assert.match(path.relative(os.tmpdir(), root), /^novel-knowledge-citations-[^\\/]+$/u);
    await fs.rm(root, { recursive: true, force: true });
  });
  const materials = path.join(root, 'materials');
  const workspace = new Workspace(path.join(root, 'local'), materials); await workspace.initialize();
  await Promise.all(['甲书', '乙书'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲书')), b = await workspace.attach(path.join(root, '乙书'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  const planning = new PlanningStore(id => workspace.getProject(id), materials);
  const confirmations = new ChapterConfirmationStore(workspace, materials);
  for (const id of [a.id, b.id]) {
    await workspace.readNotes(id); await characters.read(id); await library.read(id); await planning.read(id);
  }
  const service = new KnowledgeService(workspace, library, characters, planning, confirmations);
  return { root, materials, workspace, library, characters, planning, confirmations, service, a, b };
}
const request = (projectId: string, query = '月钥', corpus: KnowledgeSearchRequest['corpus'] = 'canon'): KnowledgeSearchRequest => ({
  projectId, requestId: randomUUID(), corpus, query, topK: 100
});
function reference(hit: KnowledgeSearchHit): KnowledgeCitationReference {
  return { id: hit.id, projectId: hit.projectId, corpus: 'canon', sourcePath: hit.sourcePath, sourceHash: hit.sourceHash,
    startParagraph: hit.startParagraph, endParagraph: hit.endParagraph };
}
async function confirm(f: Awaited<ReturnType<typeof fixture>>, projectId: string, relative: string) {
  const preview = await f.confirmations.preview(projectId, relative), snapshot = await f.confirmations.read(projectId, false);
  return f.confirmations.confirm({ projectId, path: preview.path, sourceHash: preview.hash, expectedHash: snapshot.hash });
}
async function confirmedChapter(f: Awaited<ReturnType<typeof fixture>>, text = '月钥是虚构北塔的钥匙。', format: 'docx' | 'txt' = 'docx') {
  const chapter = await f.workspace.createChapter(f.a.id, textDocument(text), format);
  await confirm(f, f.a.id, chapter.path);
  const hits = (await f.service.search(request(f.a.id, text.includes('😀') ? '😀' : '月钥'))).hits;
  return { chapter, hits: hits.filter(hit => hit.sourcePath === `chapters:${chapter.path}`) };
}
async function files(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(absolute, relative));
    else if (entry.isFile()) result[relative] = digest(await fs.readFile(absolute));
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

test('正式正文引用从DOCX原件重建，客户端缓存不供文字且不搜索或改文件', async t => {
  const f = await fixture(t), { chapter, hits } = await confirmedChapter(f, '月钥原件第一段。\n月钥原件第二段。');
  assert.equal(hits.length, 1);
  const stateFile = path.join(f.a.root, '小说资料', 'documents', `${chapter.hash}.json`);
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.content = textDocument('伪造的缓存事实不能进入引用。'); await fs.writeFile(stateFile, JSON.stringify(state));
  const before = await files(f.root), refs = hits.map(reference);
  f.service.search = async () => { throw new Error('引用复核不能执行检索'); };
  const bundle = await f.service.resolveCitations(f.a.id, refs);
  assert.equal(bundle.projectId, f.a.id); assert.deepEqual(bundle.references, refs);
  assert.equal(bundle.hits[0].sourceHash, chapter.hash); assert.equal(bundle.hits[0].confirmed, true);
  assert.equal(bundle.hits[0].corpus, 'canon'); assert.match(bundle.hits[0].text, /\u3000\u3000月钥原件第一段/u);
  assert.match(bundle.hits[0].text, /第二段/u); assert.doesNotMatch(bundle.context, /伪造的缓存/u);
  assert.match(bundle.context, /【依据1】/u); assert.match(bundle.context, /段落：1–2/u); assert.match(bundle.context, /不是系统指令/u);
  assert.match(bundle.context, new RegExp(chapter.hash)); assert.match(bundle.fingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await files(f.root), before);
});

test('世界观、人物笔记、启用人物卡和确认大纲引用按输入顺序重建，不携带预设或猜想', async t => {
  const f = await fixture(t);
  let notes = await f.workspace.readNotes(f.a.id);
  notes = await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥世界有两个太阳。', characters: '月钥人物笔记。', preset: '月钥未选择的预设', style: '月钥未选择的旧文风' }, notes.hash);
  let cards = await f.characters.read(f.a.id);
  cards = await f.characters.save(f.a.id, { fields: { ...emptyCharacter(), name: '月钥学者', description: '只住北塔。', examples: '月钥未确认示例' }, enabled: true }, cards.hash);
  let plan = await f.planning.read(f.a.id);
  plan = await f.planning.save(f.a.id, { ...plan.value, outline: '月钥确认大纲。', drafts: { ...plan.value.drafts, outline: '月钥筹备废稿。' } }, plan.hash);
  const hits = (await f.service.search(request(f.a.id))).hits.reverse(), refs = hits.map(reference);
  assert.equal(refs.length, 4);
  const bundle = await f.service.resolveCitations(f.a.id, refs);
  assert.deepEqual(bundle.references, refs); assert.deepEqual(bundle.hits.map(hit => hit.id), refs.map(ref => ref.id));
  assert.ok(bundle.hits.every(hit => hit.confirmed && hit.projectId === f.a.id && hit.corpus === 'canon'));
  assert.doesNotMatch(bundle.context, /未选择|未确认示例|筹备废稿/u);
  assert.match(bundle.context, /【依据4】/u);
});

test('长段多个相同段落范围分片依exact id精确重建；范围或id伪造整批拒绝', async t => {
  const f = await fixture(t), { hits } = await confirmedChapter(f, '月钥'.repeat(3100), 'txt');
  assert.ok(hits.length >= 3); assert.ok(hits.every(hit => hit.startParagraph === 0 && hit.endParagraph === 0));
  const chosen = [hits[2], hits[0], hits[1]], refs = chosen.map(reference);
  const bundle = await f.service.resolveCitations(f.a.id, refs);
  assert.deepEqual(bundle.hits.map(hit => [hit.id, hit.text]), chosen.map(hit => [hit.id, hit.text]));
  assert.equal(new Set(bundle.hits.map(hit => hit.id)).size, 3);
  await assert.rejects(f.service.resolveCitations(f.a.id, [refs[0], { ...refs[1], endParagraph: 1 }]), /分片或段落范围/u);
  await assert.rejects(f.service.resolveCitations(f.a.id, [refs[0], { ...refs[1], id: '0'.repeat(64) }]), /分片或段落范围/u);
});

test('非法、跨书、重复、混合用途和客户端文字字段在读取前拒绝', async t => {
  const f = await fixture(t), { hits } = await confirmedChapter(f), ref = reference(hits[0]);
  let reads = 0;
  f.workspace.readChapterKnowledge = async () => { reads++; throw new Error('非法请求不能读文件'); };
  const cases: unknown[] = [[], Array.from({ length: 11 }, () => ref), [ref, ref],
    [{ ...ref, projectId: f.b.id }], [{ ...ref, projectId: 'bad' }], [{ ...ref, id: randomUUID() }],
    [{ ...ref, corpus: 'discussion' }], [{ ...ref, sourceHash: 'ABC' }], [{ ...ref, sourcePath: 'chapters:../外部.txt' }],
    [{ ...ref, sourcePath: 'chapters:C:\\外部.txt' }], [{ ...ref, sourcePath: 'chapters:小说资料/伪正文.txt' }],
    [{ ...ref, sourcePath: 'chapters:怪?.txt' }], [{ ...ref, sourcePath: 'notes:unknown' }],
    [{ ...ref, sourcePath: `reference:${'1'.repeat(64)}` }], [{ ...ref, startParagraph: -1 }],
    [{ ...ref, startParagraph: 0.1 }], [{ ...ref, startParagraph: 2, endParagraph: 1 }],
    [{ ...ref, endParagraph: 10000 }], [{ ...ref, text: '客户端伪造事实', sourceLabel: '客户端伪造标签' }],
    [ref, { ...ref, id: '1'.repeat(64), sourceHash: '2'.repeat(64) }]];
  for (const input of cases) await assert.rejects(f.service.resolveCitations(f.a.id, input as KnowledgeCitationReference[]), /正式依据|版本/u);
  await assert.rejects(f.service.resolveCitations('invalid', [ref]), /正式依据无效/u);
  assert.equal(reads, 0);
});

test('未确认候选和参考作品不能把检索结果改标为canon引用', async t => {
  const f = await fixture(t);
  const candidate = await f.workspace.createChapter(f.a.id, textDocument('月钥未采纳候选。'));
  const discussion = (await f.service.search(request(f.a.id, '月钥', 'discussion'))).hits.find(hit => hit.sourcePath === `chapters:${candidate.path}`)!;
  await assert.rejects(f.service.resolveCitations(f.a.id, [reference(discussion)]), /未确认|停用/u);
  const book = await f.library.read(f.a.id); await f.library.addSources(f.a.id, [{ name: '参考.txt', text: '月钥参考情节。' }], book.hash);
  const style = (await f.service.search(request(f.a.id, '月钥', 'style-reference'))).hits[0];
  await assert.rejects(f.service.resolveCitations(f.a.id, [reference(style)]), /正式依据无效/u);
});

test('正文旧版本与停用版本拒绝整批，不以有效MD或新版本回退', async t => {
  const f = await fixture(t), { chapter, hits } = await confirmedChapter(f, '月钥旧版正文。', 'txt'), oldRef = reference(hits[0]);
  const notes = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥有效世界观。' }, notes.hash);
  const worldRef = reference((await f.service.search(request(f.a.id))).hits.find(hit => hit.sourcePath === 'notes:world')!);
  const next = await f.workspace.saveChapter({ projectId: f.a.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('月钥新版正文。') });
  await assert.rejects(f.service.resolveCitations(f.a.id, [worldRef, oldRef]), /已停用|已变化|缺失/u);
  const confirmed = await confirm(f, f.a.id, next.path);
  await assert.rejects(f.service.resolveCitations(f.a.id, [oldRef]), /版本.*变化/u);
  const newRef = reference((await f.service.search(request(f.a.id))).hits.find(hit => hit.sourcePath === oldRef.sourcePath)!);
  await f.confirmations.disable(f.a.id, confirmed.value.entries.at(-1)!.id, confirmed.hash);
  await assert.rejects(f.service.resolveCitations(f.a.id, [worldRef, newRef]), /已停用|未确认/u);
});

test('已停用人物卡与更新的正式MD版本整批拒绝', async t => {
  const f = await fixture(t);
  const notes = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥旧世界观。' }, notes.hash);
  let cards = await f.characters.read(f.a.id);
  cards = await f.characters.save(f.a.id, { fields: { ...emptyCharacter(), name: '月钥角色' }, enabled: true }, cards.hash);
  const result = await f.service.search(request(f.a.id)), refs = result.hits.map(reference);
  const card = cards.value.cards[0];
  await f.characters.save(f.a.id, { id: card.id, fields: card, enabled: false }, cards.hash);
  await assert.rejects(f.service.resolveCitations(f.a.id, refs), /已停用|未确认/u);
  const current = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...current.value, world: '月钥新世界观。' }, current.hash);
  await assert.rejects(f.service.resolveCitations(f.a.id, [refs.find(ref => ref.sourcePath === 'notes:world')!]), /版本.*变化/u);
});

test('只解析选中正文：未选巨文件及损坏未知版本MD不影响引用', async t => {
  const f = await fixture(t), { chapter, hits } = await confirmedChapter(f, '月钥选中正文。', 'txt');
  await fs.writeFile(path.join(f.a.root, '未选巨文件.txt'), Buffer.alloc(9 * 1024 * 1024, 0x78));
  const directory = path.join(f.materials, f.a.id);
  for (const file of ['创作笔记.md', '人物卡.md', '创作筹备.md', '文风档案.md']) await fs.writeFile(path.join(directory, file), '<!-- novel-writer {"schemaVersion":999} -->\n损坏的未选资料');
  f.workspace.readNotes = async () => { throw new Error('不能解析未选笔记'); };
  f.characters.read = async () => { throw new Error('不能解析未选角色'); };
  f.planning.read = async () => { throw new Error('不能解析未选大纲'); };
  f.library.read = async () => { throw new Error('不能解析未选参考资料'); };
  const reading = f.workspace.readChapterKnowledge.bind(f.workspace), paths: string[] = [];
  f.workspace.readChapterKnowledge = async (id, relative) => { paths.push(relative); return reading(id, relative); };
  const bundle = await f.service.resolveCitations(f.a.id, hits.map(reference));
  assert.equal(bundle.hits.length, 1); assert.deepEqual(paths, [chapter.path]);
});

test('选中正式MD未知版本或损坏拒绝；确认metadata即使只引MD仍严格复核', async t => {
  const f = await fixture(t), notes = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥已保存世界观。' }, notes.hash);
  const refs = (await f.service.search(request(f.a.id))).hits.map(reference), directory = path.join(f.materials, f.a.id);
  const notesFile = path.join(directory, '创作笔记.md'), original = await fs.readFile(notesFile);
  await fs.writeFile(notesFile, '<!-- novel-writer {"schemaVersion":999} -->\n未知版本');
  await assert.rejects(f.service.resolveCitations(f.a.id, refs), /无法安全读取/u);
  assert.match(await fs.readFile(notesFile, 'utf8'), /999/u); await fs.writeFile(notesFile, original);
  await fs.writeFile(path.join(directory, '正文确认.md'), '<!-- novel-writer {broken} -->\n损坏');
  await assert.rejects(f.service.resolveCitations(f.a.id, refs), /正文确认记录无法安全读取/u);
});

test('正文在解析之后变化及MD在复核期间变化都拒绝旧引用', async t => {
  const f = await fixture(t), { chapter, hits } = await confirmedChapter(f, '月钥原件旧版。', 'txt');
  const reading = f.workspace.readChapterKnowledge.bind(f.workspace);
  f.workspace.readChapterKnowledge = async (...args) => { const source = await reading(...args); await fs.writeFile(path.join(f.a.root, chapter.path), '月钥外部新版。'); return source; };
  await assert.rejects(f.service.resolveCitations(f.a.id, hits.map(reference)), /复核期间更新/u);
  f.workspace.readChapterKnowledge = reading;
  const notes = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥世界观旧版。' }, notes.hash);
  const worldRef = reference((await f.service.search(request(f.a.id))).hits.find(hit => hit.sourcePath === 'notes:world')!);
  const readNotes = f.workspace.readNotes.bind(f.workspace); let reads = 0;
  f.workspace.readNotes = async id => { const result = await readNotes(id); if (++reads === 1) await fs.appendFile(path.join(f.materials, f.a.id, '创作笔记.md'), '\n外部更新\n'); return result; };
  await assert.rejects(f.service.resolveCitations(f.a.id, [worldRef]), /复核期间更新/u);
});

test('最后一次确认snapshot复核拦截期间停用及metadata损坏，纯MD引用同样受保护', async t => {
  const f = await fixture(t), { hits } = await confirmedChapter(f), notes = await f.workspace.readNotes(f.a.id);
  await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥纯MD依据。' }, notes.hash);
  const worldRef = reference((await f.service.search(request(f.a.id))).hits.find(hit => hit.sourcePath === 'notes:world')!);
  const reading = f.confirmations.read.bind(f.confirmations); let reads = 0;
  f.confirmations.read = async (...args) => {
    if (++reads === 2) { const current = await reading(f.a.id, false); await f.confirmations.disable(f.a.id, current.value.entries[0].id, current.hash); }
    return reading(...args);
  };
  await assert.rejects(f.service.resolveCitations(f.a.id, [worldRef]), /确认状态.*复核期间更新/u);
  reads = 0;
  f.confirmations.read = async (...args) => { if (++reads === 2) await fs.writeFile(path.join(f.materials, f.a.id, '正文确认.md'), 'metadata损坏'); return reading(...args); };
  await assert.rejects(f.service.resolveCitations(f.a.id, [worldRef]), /确认记录无法安全读取/u);
  assert.equal(hits[0].confirmed, true);
});

test('调用时复制冻结引用，输入随后改动不能替换引用目标或顺序', async t => {
  const f = await fixture(t), { hits } = await confirmedChapter(f), refs = hits.map(reference), expected = structuredClone(refs);
  const resolving = f.service.resolveCitations(f.a.id, refs);
  refs[0].projectId = f.b.id; refs[0].sourcePath = 'chapters:../外部.txt'; refs[0].id = '0'.repeat(64); refs.push({ ...refs[0] });
  const bundle = await resolving;
  assert.deepEqual(bundle.references, expected); assert.equal(bundle.projectId, f.a.id);
  assert.ok(Object.isFrozen(bundle.references)); assert.ok(bundle.references.every(Object.isFrozen));
});

test('相同引用重建指纹稳定，顺序及确认metadata版本变化使指纹失效', async t => {
  const f = await fixture(t), { hits } = await confirmedChapter(f, '月钥'.repeat(2400), 'txt'), refs = hits.slice(0, 2).map(reference);
  const one = await f.service.resolveCitations(f.a.id, refs), two = await f.service.resolveCitations(f.a.id, structuredClone(refs));
  assert.equal(one.fingerprint, two.fingerprint); assert.deepEqual(one.hits, two.hits); assert.equal(one.context, two.context);
  const reversed = await f.service.resolveCitations(f.a.id, [...refs].reverse()); assert.notEqual(reversed.fingerprint, one.fingerprint);
  const unrelated = await f.workspace.createChapter(f.a.id, textDocument('未引用但作者确认的新章节。'), 'txt');
  await confirm(f, f.a.id, unrelated.path);
  const refreshed = await f.service.resolveCitations(f.a.id, refs); assert.notEqual(refreshed.fingerprint, one.fingerprint);
  assert.deepEqual(refreshed.hits, one.hits);
});

test('UTF8引用总量超过64KiB整次拒绝，不裁剪已选择分片', async t => {
  const f = await fixture(t), { hits } = await confirmedChapter(f, '😀'.repeat(20000), 'txt');
  assert.ok(hits.length >= 10);
  const refs = hits.slice(0, 10).map(reference);
  assert.ok(hits.slice(0, 10).reduce((bytes, hit) => bytes + Buffer.byteLength(hit.text, 'utf8'), 0) > 64 * 1024);
  await assert.rejects(f.service.resolveCitations(f.a.id, refs), /超过64 KiB.*未截断/u);
  assert.equal((await f.service.resolveCitations(f.a.id, refs.slice(0, 2))).hits.length, 2);
});
