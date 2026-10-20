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
import type { KnowledgeSearchRequest, KnowledgeSourceCatalog } from '../src/shared/contracts';

const digest = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-knowledge-selection-'));
  t.after(async () => {
    assert.match(path.relative(os.tmpdir(), root), /^novel-knowledge-selection-[^\\/]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  const materials = path.join(root, 'materials');
  const workspace = new Workspace(path.join(root, 'local'), materials); await workspace.initialize();
  await Promise.all(['甲书', '乙书'].map(name => fs.mkdir(path.join(root, name))));
  const a = await workspace.attach(path.join(root, '甲书')), b = await workspace.attach(path.join(root, '乙书'));
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materials);
  const planning = new PlanningStore(id => workspace.getProject(id), materials);
  for (const id of [a.id, b.id]) { await workspace.readNotes(id); await characters.read(id); await library.read(id); await planning.read(id); }
  const service = new KnowledgeService(workspace, library, characters, planning);
  return { root, workspace, library, characters, planning, service, a, b };
}
const selected = (catalog: KnowledgeSourceCatalog, sourcePaths = catalog.sources.map(source => source.sourcePath)): KnowledgeSearchRequest => ({
  projectId: catalog.projectId, requestId: randomUUID(), corpus: catalog.corpus,
  query: '月钥', topK: 100, sourcePaths, catalogHash: catalog.hash
});

test('超过500章只列元数据，按卷选择两章只读取两份原件；未选巨大/损坏文件不阻碍且原稿字节不变', async t => {
  const f = await fixture(t);
  const names = Array.from({ length: 501 }, (_, i) => `章节-${i}.txt`);
  await Promise.all(names.map(name => fs.writeFile(path.join(f.a.root, name), `月钥虚构章节${name}。`)));
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61), corrupt = Buffer.from('损坏DOCX');
  await fs.writeFile(path.join(f.a.root, '超限未选.txt'), huge);
  await fs.writeFile(path.join(f.a.root, '损坏未选.docx'), corrupt);
  const first = names[0], last = names.at(-1)!;
  const bytes = await Promise.all([first, last].map(name => fs.readFile(path.join(f.a.root, name))));
  let book = await f.library.read(f.a.id);
  const volumeId = randomUUID();
  book = await f.library.save(f.a.id, { ...book.value, volumes: [{ id: volumeId, title: '第一集', introduction: '', cover: '', chapters: [first, last] }] }, book.hash);
  const bookRaw = await fs.readFile(path.join(f.a.root, '小说资料', 'book.json'));
  const reads: string[] = [], hashes: string[] = [];
  const read = f.workspace.readChapterKnowledge.bind(f.workspace), hash = f.workspace.chapterHash.bind(f.workspace);
  f.workspace.readChapterKnowledge = async (id, relative) => { reads.push(relative); return read(id, relative); };
  f.workspace.chapterHash = async (id, relative) => { hashes.push(relative); return hash(id, relative); };
  const catalog = await f.service.listSources(f.a.id, 'discussion');
  assert.equal(catalog.sources.length, 503); assert.equal(reads.length, 0); assert.equal(hashes.length, 0);
  assert.deepEqual(catalog.volumes, [{ id: volumeId, title: '第一集' }]);
  const paths = catalog.sources.filter(source => source.volumeIds.includes(volumeId)).map(source => source.sourcePath);
  assert.deepEqual(new Set(paths), new Set([`chapters:${first}`, `chapters:${last}`]));
  const result = await f.service.search(selected(catalog, paths));
  assert.equal(result.sourceCount, 2); assert.equal(result.hits.length, 2); assert.deepEqual(new Set(reads), new Set([first, last]));
  assert.equal(reads.length, 2); assert.deepEqual(new Set(hashes), new Set([first, last]));
  assert.ok(result.hits.every(hit => hit.corpus === 'discussion' && !hit.confirmed));
  assert.ok(!result.warnings.some(warning => /超限未选|损坏未选/.test(warning)));
  for (let i = 0; i < 2; i++) assert.deepEqual(await fs.readFile(path.join(f.a.root, [first, last][i])), bytes[i]);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, '超限未选.txt')), huge);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, '损坏未选.docx')), corrupt);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, '小说资料', 'book.json')), bookRaw);
  await assert.rejects(f.service.search({ projectId: f.a.id, requestId: randomUUID(), corpus: 'discussion', query: '月钥', topK: 10 }), /超过500/);
  await assert.rejects(f.service.search(selected(catalog, ['chapters:超限未选.txt'])), /超过读取限制/);
});

test('明确来源必须成对、非空、唯一、安全且属于本书用途，所有错误先于正文提取', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥甲书。');
  await fs.writeFile(path.join(f.b.root, '第一章.txt'), '月钥乙书秘密。');
  const catalog = await f.service.listSources(f.a.id, 'discussion'), good = selected(catalog);
  let reads = 0; const read = f.workspace.readChapterKnowledge.bind(f.workspace);
  f.workspace.readChapterKnowledge = async (...args) => { reads++; return read(...args); };
  const invalid = [
    { ...good, sourcePaths: [] }, { ...good, sourcePaths: Array(501).fill('chapters:第一章.txt') },
    { ...good, sourcePaths: ['chapters:第一章.txt', 'chapters:第一章.txt'] },
    { ...good, sourcePaths: ['chapters:../第一章.txt'] }, { ...good, sourcePaths: ['chapters:C:\\第一章.txt'] },
    { ...good, sourcePaths: ['chapters:首\n章.txt'] }, { ...good, sourcePaths: [`chapters:${'x'.repeat(2000)}.txt`] },
    { ...good, sourcePaths: ['chapters:不存在.txt'] }, { ...good, sourcePaths: ['notes:world'] },
    { ...good, sourcePaths: undefined }, { ...good, catalogHash: undefined }, { ...good, catalogHash: 'bad' },
    { ...good, projectId: f.b.id }
  ];
  for (const request of invalid) await assert.rejects(f.service.search(request), /无效|来源|目录/);
  assert.equal(reads, 0);
  const other = await f.service.listSources(f.b.id, 'discussion'); assert.notEqual(other.hash, catalog.hash);
  const result = await f.service.search(selected(other)); assert.equal(result.hits.length, 1);
  assert.match(result.hits[0].text, /乙书秘密/); assert.equal(result.hits[0].projectId, f.b.id);
  assert.equal(reads, 1);
});

test('目录哈希只绑定结构与书/用途，原件内容变化读取新版本；增删路径和分集名称/归属变化使旧选择失败', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥旧文本。');
  let book = await f.library.read(f.a.id); const volumeId = randomUUID();
  book = await f.library.save(f.a.id, { ...book.value, volumes: [{ id: volumeId, title: '初卷', introduction: '', cover: '', chapters: ['第一章.txt'] }] }, book.hash);
  let catalog = await f.service.listSources(f.a.id, 'discussion');
  await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥新版文本。');
  assert.equal((await f.service.listSources(f.a.id, 'discussion')).hash, catalog.hash);
  const fresh = await f.service.search(selected(catalog)); assert.match(fresh.hits[0].text, /新版文本/);
  assert.equal(fresh.hits[0].sourceHash, digest('月钥新版文本。'));
  await fs.writeFile(path.join(f.a.root, '第二章.txt'), '月钥新路径。');
  await assert.rejects(f.service.search(selected(catalog)), /目录已更新/);
  catalog = await f.service.listSources(f.a.id, 'discussion');
  book = await f.library.save(f.a.id, { ...book.value, volumes: [{ ...book.value.volumes[0], title: '更名卷' }] }, book.hash);
  await assert.rejects(f.service.search(selected(catalog, ['chapters:第一章.txt'])), /目录已更新/);
  catalog = await f.service.listSources(f.a.id, 'discussion');
  book = await f.library.save(f.a.id, { ...book.value, volumes: [{ ...book.value.volumes[0], chapters: ['第二章.txt'] }] }, book.hash);
  await assert.rejects(f.service.search(selected(catalog, ['chapters:第一章.txt'])), /目录已更新/);
  const reassigned = await f.service.listSources(f.a.id, 'discussion');
  assert.deepEqual(reassigned.sources.find(source => source.sourcePath === 'chapters:第一章.txt')!.volumeIds, []);
  assert.deepEqual(reassigned.sources.find(source => source.sourcePath === 'chapters:第二章.txt')!.volumeIds, [volumeId]);
  const renamed = await f.workspace.renameChapter({ projectId: f.a.id, path: '第二章.txt', expectedHash: digest('月钥新路径。'), name: '第二章改名' });
  await assert.rejects(f.service.search(selected(reassigned, ['chapters:第二章.txt'])), /目录已更新/);
  const projected = await f.service.listSources(f.a.id, 'discussion');
  assert.ok(!projected.sources.some(source => source.sourcePath === 'chapters:第二章.txt'));
  assert.deepEqual(projected.sources.find(source => source.sourcePath === `chapters:${renamed.path}`)!.volumeIds, [volumeId]);
  assert.equal((await f.service.search(selected(projected, [`chapters:${renamed.path}`]))).hits[0].sourceHash, renamed.hash);
  await fs.unlink(path.join(f.a.root, '第一章.txt'));
  await assert.rejects(f.service.search(selected(projected, [`chapters:${renamed.path}`])), /目录已更新/);
});

test('选中检索结束再次核对结构目录；期间原件文字变化仍排除旧哈希，而不是过期结果成功', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥首稿。');
  const catalog = await f.service.listSources(f.a.id, 'discussion');
  const read = f.workspace.readChapterKnowledge.bind(f.workspace); let mutate = true;
  f.workspace.readChapterKnowledge = async (...args) => {
    const snapshot = await read(...args);
    if (mutate) { mutate = false; await fs.writeFile(path.join(f.a.root, '新增.txt'), '月钥新增路径。'); }
    return snapshot;
  };
  await assert.rejects(f.service.search(selected(catalog)), /目录在检索期间更新/);
  const refreshed = await f.service.listSources(f.a.id, 'discussion');
  f.workspace.readChapterKnowledge = async (...args) => {
    const snapshot = await read(...args); await fs.writeFile(path.join(f.a.root, args[1]), '月钥外部更新。'); return snapshot;
  };
  const stale = await f.service.search(selected(refreshed, ['chapters:第一章.txt']));
  assert.equal(stale.sourceCount, 0); assert.equal(stale.hits.length, 0);
  assert.ok(stale.warnings.some(warning => warning.includes('旧版本结果已排除')));
});

test('参考目录仅已注册来源，不解析原件；未选超长参考不计入限制，参考更名要求重新选择', async t => {
  const f = await fixture(t); let book = await f.library.read(f.a.id);
  book = await f.library.addSources(f.a.id, [
    { name: '小参考.txt', text: '月钥虚构参考表达。' }, { name: '大参考.txt', text: '月'.repeat(200001) }
  ], book.hash);
  const short = book.value.sources.find(source => source.name === '小参考.txt')!;
  const reference = f.library.readStyleSources.bind(f.library), reads: string[] = [];
  f.library.readStyleSources = async (id, ids, mode) => { reads.push(...ids); return reference(id, ids, mode); };
  const catalog = await f.service.listSources(f.a.id, 'style-reference');
  assert.equal(reads.length, 0); assert.equal(catalog.sources.length, 2); assert.deepEqual(catalog.volumes, []);
  const result = await f.service.search(selected(catalog, [`reference:${short.id}`]));
  assert.equal(result.hits.length, 1); assert.ok(reads.every(id => id === short.id));
  assert.equal(result.hits[0].confirmed, false); assert.equal(result.hits[0].corpus, 'style-reference');
  await assert.rejects(f.service.search(selected(catalog, [`reference:${digest('未注册')}`])), /不属于/);
  book = await f.library.save(f.a.id, { ...book.value, sources: book.value.sources.map(source => source.id === short.id ? { ...source, name: '更名.txt' } : source) }, book.hash);
  await assert.rejects(f.service.search(selected(catalog, [`reference:${short.id}`])), /目录已更新/);
  const renamed = await f.service.listSources(f.a.id, 'style-reference');
  book = await f.library.save(f.a.id, { ...book.value, sources: book.value.sources.map(source => source.id === short.id ? { ...source, format: 'docx' } : source) }, book.hash);
  await assert.rejects(f.service.search(selected(renamed, [`reference:${short.id}`])), /目录已更新/);
});

test('正史目录只含已保存世界/人物笔记、启用角色和正式大纲；子集只检索选定世界观且停用角色使旧目录失效', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '正文.txt'), '月钥正文仍未确认。');
  let notes = await f.workspace.readNotes(f.a.id);
  notes = await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥保存世界。', characters: '月钥人物笔记。', preset: '月钥非正史预设。' }, notes.hash);
  let cards = await f.characters.read(f.a.id);
  cards = await f.characters.save(f.a.id, { fields: { ...emptyCharacter(), name: '月钥启用人物', description: '月钥角色定义。' }, enabled: true }, cards.hash);
  const enabledId = cards.value.cards[0].id;
  cards = await f.characters.save(f.a.id, { fields: { ...emptyCharacter(), name: '月钥停用人物' }, enabled: false }, cards.hash);
  let planning = await f.planning.read(f.a.id);
  planning = await f.planning.save(f.a.id, { ...planning.value, outline: '月钥正式大纲。', drafts: { ...planning.value.drafts, outline: '月钥筹备草稿。' } }, planning.hash);
  const catalog = await f.service.listSources(f.a.id, 'canon');
  assert.deepEqual(new Set(catalog.sources.map(source => source.sourcePath)), new Set(['notes:world', 'notes:characters', `characters:${enabledId}`, 'planning:outline']));
  const result = await f.service.search(selected(catalog, ['notes:world']));
  assert.equal(result.hits.length, 1); assert.equal(result.sourceCount, 1); assert.equal(result.hits[0].confirmed, true);
  assert.match(result.hits[0].text, /保存世界/); assert.doesNotMatch(JSON.stringify(result), /正文仍未确认|人物笔记|正式大纲|筹备草稿|非正史/);
  const fields = cards.value.cards[0];
  await f.characters.save(f.a.id, { id: fields.id, fields, enabled: false }, cards.hash);
  await assert.rejects(f.service.search(selected(catalog, ['notes:world'])), /目录已更新/);
});

test('来源目录最多5000条；边界仍不读取原件，非法书/用途与元数据串书拒绝', async t => {
  const f = await fixture(t); const chapters = f.workspace.chapters.bind(f.workspace);
  f.workspace.chapters = async () => Array.from({ length: 5001 }, (_, i) => ({ path: `${i}.txt`, name: `${i}.txt` }));
  await assert.rejects(f.service.listSources(f.a.id, 'discussion'), /超过5000/);
  f.workspace.chapters = async () => Array.from({ length: 5000 }, (_, i) => ({ path: `${i}.txt`, name: `${i}.txt` }));
  assert.equal((await f.service.listSources(f.a.id, 'discussion')).sources.length, 5000);
  await assert.rejects(f.service.listSources('invalid', 'discussion'), /请求无效/);
  await assert.rejects(f.service.listSources(f.a.id, 'invalid' as KnowledgeSearchRequest['corpus']), /请求无效/);
  const read = f.library.read.bind(f.library);
  f.library.read = async () => read(f.b.id);
  await assert.rejects(f.service.listSources(f.a.id, 'discussion'), /另一部小说/);
  f.workspace.chapters = chapters;
});

test('目录准备阶段仍可停止，错误书或请求ID无效，异步期间原始选择数组更改不会改写固定目标', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥固定目标。');
  await fs.writeFile(path.join(f.a.root, '第二章.txt'), '月钥不应替换目标。');
  const catalog = await f.service.listSources(f.a.id, 'discussion');
  const chapters = f.workspace.chapters.bind(f.workspace);
  let enter!: () => void, release!: () => void;
  const block = () => {
    const ready = new Promise<void>(resolve => enter = resolve), wait = new Promise<void>(resolve => release = resolve);
    f.workspace.chapters = async id => { enter(); await wait; return chapters(id); };
    return ready;
  };
  let ready = block(); const request = selected(catalog, ['chapters:第一章.txt']), pending = f.service.search(request); await ready;
  request.sourcePaths![0] = 'chapters:第二章.txt';
  f.service.cancel(f.b.id, request.requestId); f.service.cancel(f.a.id, randomUUID());
  await assert.rejects(f.service.search(selected(catalog)), /已有检索/); release();
  const result = await pending; assert.equal(result.hits.length, 1); assert.equal(result.hits[0].sourcePath, 'chapters:第一章.txt');
  ready = block(); const stopping = selected(catalog, ['chapters:第一章.txt']), cancelled = f.service.search(stopping); await ready;
  f.service.cancel(f.a.id, stopping.requestId); release(); await assert.rejects(cancelled, /检索已停止/);
  f.workspace.chapters = chapters;
  assert.equal((await f.service.search(selected(catalog, ['chapters:第一章.txt']))).hits.length, 1);
});
