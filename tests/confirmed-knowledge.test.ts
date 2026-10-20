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
import { textDocument } from '../src/main/text-import';
import type { KnowledgeSearchRequest, KnowledgeSourceCatalog } from '../src/shared/contracts';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-confirmed-knowledge-'));
  t.after(async () => {
    assert.match(path.relative(os.tmpdir(), root), /^novel-confirmed-knowledge-[^\\/]+$/);
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
const request = (projectId: string, corpus: KnowledgeSearchRequest['corpus'] = 'canon'): KnowledgeSearchRequest => ({
  projectId, requestId: randomUUID(), corpus, query: '月钥', topK: 100
});
const selected = (catalog: KnowledgeSourceCatalog, sourcePaths = catalog.sources.map(source => source.sourcePath)): KnowledgeSearchRequest => ({
  ...request(catalog.projectId, catalog.corpus), sourcePaths, catalogHash: catalog.hash
});
async function confirm(f: Awaited<ReturnType<typeof fixture>>, projectId: string, relative: string) {
  const preview = await f.confirmations.preview(projectId, relative);
  const snapshot = await f.confirmations.read(projectId, false);
  return f.confirmations.confirm({ projectId, path: preview.path, sourceHash: preview.hash, expectedHash: snapshot.hash });
}

test('正文默认不在正式目录；作者确认才加入，另存候选未自动确认，文稿和参考仍为false且两书隔离', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.a.id, textDocument('月钥作者正文。'));
  const candidate = await f.workspace.createChapter(f.a.id, textDocument('月钥未采纳的AI另存候选。'));
  await f.workspace.createChapter(f.b.id, textDocument('月钥乙书秘密。'));
  let book = await f.library.read(f.a.id);
  book = await f.library.addSources(f.a.id, [{ name: '参考.txt', text: '月钥参考作品表达。' }], book.hash);
  assert.equal((await f.service.listSources(f.a.id, 'canon')).sources.length, 0);
  assert.equal((await f.service.search(request(f.a.id))).hits.length, 0);
  await confirm(f, f.a.id, chapter.path);
  const bytes = await fs.readFile(path.join(f.a.root, chapter.path));
  const catalog = await f.service.listSources(f.a.id, 'canon');
  assert.deepEqual(catalog.sources, [{ sourcePath: `chapters:${chapter.path}`, label: `作者确认版本 · ${chapter.path}`, kind: 'chapter', volumeIds: [] }]);
  const result = await f.service.search(selected(catalog));
  assert.equal(result.sourceCount, 1); assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].confirmed, true); assert.equal(result.hits[0].sourceHash, chapter.hash);
  assert.equal(result.hits[0].sourceKind, 'chapter'); assert.match(result.hits[0].text, /作者正文/);
  assert.doesNotMatch(JSON.stringify(result), /未采纳|乙书秘密/);
  const manuscripts = await f.service.search(request(f.a.id, 'discussion'));
  assert.equal(manuscripts.hits.length, 2); assert.ok(manuscripts.hits.every(hit => !hit.confirmed));
  assert.ok(manuscripts.hits.some(hit => hit.sourcePath === `chapters:${candidate.path}`));
  assert.ok((await f.service.search(request(f.a.id, 'style-reference'))).hits.every(hit => !hit.confirmed));
  assert.equal((await f.service.search(request(f.b.id))).hits.length, 0);
  await assert.rejects(f.service.search({ ...selected(catalog), projectId: f.b.id }), /目录|来源/);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, chapter.path)), bytes);
});

test('外部正文改变不改目录结构哈希，旧确认明确排除；二次确认新版保留停用历史且旧选择失效', async t => {
  const f = await fixture(t); const relative = '第一章.txt';
  await fs.writeFile(path.join(f.a.root, relative), '月钥旧版作者正文。');
  const first = await confirm(f, f.a.id, relative), catalog = await f.service.listSources(f.a.id, 'canon');
  await fs.writeFile(path.join(f.a.root, relative), '月钥新版作者正文。');
  assert.equal((await f.service.listSources(f.a.id, 'canon')).hash, catalog.hash);
  const excluded = await f.service.search(selected(catalog));
  assert.equal(excluded.sourceCount, 0); assert.equal(excluded.chunkCount, 0); assert.equal(excluded.hits.length, 0);
  assert.ok(excluded.warnings.some(warning => /旧确认已失效/.test(warning) && /未覆盖当前正文/.test(warning)));
  const second = await confirm(f, f.a.id, relative);
  assert.equal(second.value.entries.length, 2);
  assert.equal(second.value.entries.find(entry => entry.id === first.value.entries[0].id)!.enabled, false);
  assert.equal(second.value.entries.filter(entry => entry.enabled).length, 1);
  assert.notEqual((await f.service.listSources(f.a.id, 'canon')).hash, catalog.hash);
  await assert.rejects(f.service.search(selected(catalog)), /目录已更新/);
  const fresh = await f.service.search(selected(await f.service.listSources(f.a.id, 'canon')));
  assert.equal(fresh.hits.length, 1); assert.match(fresh.hits[0].text, /新版作者正文/);
  assert.equal(fresh.hits[0].sourceHash, digest('月钥新版作者正文。'));
});

test('停用前后的目录与legacy正式检索都尊重作者状态；新确认使既有世界观子集选择过期', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥确认正文。');
  let notes = await f.workspace.readNotes(f.a.id);
  notes = await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥世界观。' }, notes.hash);
  const before = await f.service.listSources(f.a.id, 'canon');
  const snapshot = await confirm(f, f.a.id, '第一章.txt');
  await assert.rejects(f.service.search(selected(before, ['notes:world'])), /目录已更新/);
  const catalog = await f.service.listSources(f.a.id, 'canon');
  await f.confirmations.disable(f.a.id, snapshot.value.entries[0].id, snapshot.hash);
  await assert.rejects(f.service.search(selected(catalog)), /目录已更新/);
  const result = await f.service.search(request(f.a.id));
  assert.equal(result.sourceCount, 1); assert.equal(result.hits[0].sourceKind, 'world');
  assert.ok(!result.hits.some(hit => hit.sourceKind === 'chapter'));
});

test('提取或末次原件复核期间停用确认时，选中与legacy搜索均拒绝交付旧正史', async t => {
  for (const stage of ['extract', 'final-hash'] as const) for (const mode of ['selected', 'legacy'] as const) {
    await t.test(`${stage} / ${mode}`, async child => {
      const f = await fixture(child); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥确认正文。');
      const snapshot = await confirm(f, f.a.id, '第一章.txt'), catalog = await f.service.listSources(f.a.id, 'canon');
      let changed = false;
      const disable = async () => {
        if (changed) return; changed = true;
        await f.confirmations.disable(f.a.id, snapshot.value.entries[0].id, snapshot.hash);
      };
      if (stage === 'extract') {
        const read = f.workspace.readChapterKnowledge.bind(f.workspace);
        f.workspace.readChapterKnowledge = async (...args) => { const result = await read(...args); await disable(); return result; };
      } else {
        const hash = f.workspace.chapterHash.bind(f.workspace);
        f.workspace.chapterHash = async (...args) => { const result = await hash(...args); await disable(); return result; };
      }
      await assert.rejects(f.service.search(mode === 'selected' ? selected(catalog) : request(f.a.id)), /目录在检索期间更新|确认状态在检索期间更新/);
      assert.equal(changed, true);
    });
  }
});

test('末次确认状态复核覆盖未选正文的legacy正式检索；搜索中新增确认也拒绝旧结果', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥初稿。');
  let notes = await f.workspace.readNotes(f.a.id);
  notes = await f.workspace.saveNotes(f.a.id, { ...notes.value, world: '月钥世界。' }, notes.hash);
  const readNotes = f.workspace.readNotes.bind(f.workspace); let changed = false;
  f.workspace.readNotes = async id => {
    const result = await readNotes(id);
    if (!changed) { changed = true; await confirm(f, f.a.id, '第一章.txt'); }
    return result;
  };
  await assert.rejects(f.service.search(request(f.a.id)), /确认状态在检索期间更新/);
  f.workspace.readNotes = readNotes;
  assert.equal((await f.service.search(request(f.a.id))).sourceCount, 2);
});

test('确认目录只读元数据，选择子集不读取未选超大/损坏正文；选中才执行原件读取上限', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.a.root, '小章.txt'), '月钥小章。');
  await fs.writeFile(path.join(f.a.root, '大章.txt'), '月钥原先正常。');
  const docx = await f.workspace.createChapter(f.a.id, textDocument('月钥原先正常DOCX。'));
  for (const relative of ['小章.txt', '大章.txt', docx.path]) await confirm(f, f.a.id, relative);
  await fs.writeFile(path.join(f.a.root, '大章.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  await fs.writeFile(path.join(f.a.root, docx.path), '损坏压缩包');
  const reads: string[] = [], hashes: string[] = [];
  const read = f.workspace.readChapterKnowledge.bind(f.workspace), hash = f.workspace.chapterHash.bind(f.workspace);
  f.workspace.readChapterKnowledge = async (id, relative) => { reads.push(relative); return read(id, relative); };
  f.workspace.chapterHash = async (id, relative) => { hashes.push(relative); return hash(id, relative); };
  const catalog = await f.service.listSources(f.a.id, 'canon');
  assert.equal(catalog.sources.length, 3); assert.deepEqual(reads, []); assert.deepEqual(hashes, []);
  const result = await f.service.search(selected(catalog, ['chapters:小章.txt']));
  assert.equal(result.sourceCount, 1); assert.deepEqual(reads, ['小章.txt']); assert.deepEqual(hashes, ['小章.txt']);
  assert.ok(!result.warnings.some(warning => /大章|损坏/.test(warning)));
  await assert.rejects(f.service.search(selected(catalog, ['chapters:大章.txt'])), /超过读取限制/);
});

test('安全章节重命名投影确认路径并保留来源字节，旧目录过期，新路径正式检索有效', async t => {
  const f = await fixture(t); const relative = '第一章.txt', text = '月钥安全改名。';
  await fs.writeFile(path.join(f.a.root, relative), text);
  const snapshot = await confirm(f, f.a.id, relative), catalog = await f.service.listSources(f.a.id, 'canon');
  const renamed = await f.workspace.renameChapter({ projectId: f.a.id, path: relative, expectedHash: digest(text), name: '作者新章名' });
  await assert.rejects(f.service.search(selected(catalog)), /目录已更新/);
  const projected = await f.confirmations.read(f.a.id, false), refreshed = await f.service.listSources(f.a.id, 'canon');
  assert.equal(projected.value.entries[0].id, snapshot.value.entries[0].id);
  assert.equal(projected.value.entries[0].sourcePath, renamed.path);
  assert.equal(projected.value.entries[0].sourceHash, digest(text));
  assert.ok(refreshed.sources.some(source => source.sourcePath === `chapters:${renamed.path}`));
  const result = await f.service.search(selected(refreshed));
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].confirmed, true);
  assert.equal(result.hits[0].sourcePath, `chapters:${renamed.path}`);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, renamed.path)), Buffer.from(text));
});

test('已确认DOCX仍提取原件，同哈希结构缓存篡改不能伪造正式内容', async t => {
  const f = await fixture(t);
  const chapter = await f.workspace.createChapter(f.a.id, textDocument('月钥真实原件DOCX。'));
  await confirm(f, f.a.id, chapter.path);
  const file = path.join(f.a.root, chapter.path), bytes = await fs.readFile(file);
  const stateFile = path.join(f.a.root, '小说资料', 'documents', `${chapter.hash}.json`);
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  state.content = textDocument('月钥伪造缓存正式内容。');
  await fs.writeFile(stateFile, JSON.stringify(state));
  const result = await f.service.search(request(f.a.id));
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].confirmed, true);
  assert.match(result.hits[0].text, /真实原件DOCX/); assert.doesNotMatch(result.hits[0].text, /伪造缓存/);
  assert.equal(result.hits[0].sourceHash, digest(bytes)); assert.deepEqual(await fs.readFile(file), bytes);
});

test('原件末次变化使旧确认结果排除并明确未覆盖，无法以旧哈希交付正式正文', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥确认初版。');
  await confirm(f, f.a.id, '第一章.txt');
  const read = f.workspace.readChapterKnowledge.bind(f.workspace); let changed = false;
  f.workspace.readChapterKnowledge = async (...args) => {
    const result = await read(...args);
    if (!changed) { changed = true; await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥外部新版。'); }
    return result;
  };
  const result = await f.service.search(request(f.a.id));
  assert.equal(result.sourceCount, 0); assert.equal(result.hits.length, 0);
  assert.ok(result.warnings.some(warning => /旧确认已失效/.test(warning) && /未覆盖当前正文/.test(warning)));
});

test('串书确认快照和实际损坏/未知版本确认MD导致正式检索失败；文稿普通用途仍为false', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥确认正文。');
  await confirm(f, f.a.id, '第一章.txt');
  const read = f.confirmations.read.bind(f.confirmations);
  f.confirmations.read = async (_, validateSources) => read(f.b.id, validateSources);
  await assert.rejects(f.service.listSources(f.a.id, 'canon'), /另一部小说/);
  await assert.rejects(f.service.search(request(f.a.id)), /另一部小说/);
  f.confirmations.read = read;
  const recordFile = path.join(f.materials, f.a.id, '正文确认.md'), original = await fs.readFile(recordFile, 'utf8');
  const damaged = ['损坏的确认记录', original.replace('"schemaVersion":1', '"schemaVersion":99')];
  assert.notEqual(damaged[1], original);
  for (const raw of damaged) {
    await fs.writeFile(recordFile, raw);
    await assert.rejects(f.service.listSources(f.a.id, 'canon'), /确认记录无法安全读取/);
    await assert.rejects(f.service.search(request(f.a.id)), /确认记录无法安全读取/);
    assert.equal(await fs.readFile(recordFile, 'utf8'), raw);
  }
  assert.ok((await f.service.search(request(f.a.id, 'discussion'))).hits.every(hit => !hit.confirmed));
});

test('末次原件核对后确认MD损坏仍整次失败，选中与legacy均不能交付已有正式命中', async t => {
  for (const mode of ['selected', 'legacy'] as const) await t.test(mode, async child => {
    const f = await fixture(child); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥已确认正文。');
    await confirm(f, f.a.id, '第一章.txt');
    const catalog = await f.service.listSources(f.a.id, 'canon'), hash = f.workspace.chapterHash.bind(f.workspace);
    f.workspace.chapterHash = async (...args) => {
      const result = await hash(...args);
      await fs.writeFile(path.join(f.materials, f.a.id, '正文确认.md'), '外部损坏的确认记录');
      return result;
    };
    await assert.rejects(f.service.search(mode === 'selected' ? selected(catalog) : request(f.a.id)), /确认记录无法安全读取/);
  });
});

test('正文确认准备阶段的检索可以停止，错误请求ID不会取消且恢复后可重新搜索', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.a.root, '第一章.txt'), '月钥确认正文。');
  await confirm(f, f.a.id, '第一章.txt');
  const read = f.confirmations.read.bind(f.confirmations);
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => enter = resolve), blocked = new Promise<void>(resolve => release = resolve);
  f.confirmations.read = async (...args) => { enter(); await blocked; return read(...args); };
  const input = request(f.a.id), pending = f.service.search(input); await ready;
  f.service.cancel(f.b.id, input.requestId); f.service.cancel(f.a.id, randomUUID());
  await assert.rejects(f.service.search(request(f.a.id)), /已有检索/);
  f.service.cancel(f.a.id, input.requestId); release();
  await assert.rejects(pending, /检索已停止/);
  f.confirmations.read = read;
  assert.equal((await f.service.search(request(f.a.id))).hits.length, 1);
});

