import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ChapterConfirmationStore } from '../src/main/chapter-confirmation';
import { Workspace } from '../src/main/workspace';
import { textDocument } from '../src/main/text-import';
import { safeJson } from '../src/main/markdown-materials';
import type { ChapterConfirmationSnapshot, ConfirmChapterVersionRequest } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-confirmation-test-'));
  t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-confirmation-test-[^\\/]+$/u); await fs.rm(root, { recursive: true, force: true }); });
  const local = path.join(root, 'local'), materials = path.join(root, 'materials'), folderA = path.join(root, '小说甲'), folderB = path.join(root, '小说乙');
  await fs.mkdir(folderA); await fs.mkdir(folderB);
  const workspace = new Workspace(local, materials); await workspace.initialize();
  const a = await workspace.attach(folderA), b = await workspace.attach(folderB);
  const confirmations = new ChapterConfirmationStore(workspace, materials);
  return { root, local, materials, folderA, folderB, workspace, a, b, confirmations, file: path.join(materials, a.id, '正文确认.md') };
}
const rawRecord = (value: unknown) => `<!-- novel-writer ${safeJson({ ...(value as object), kind: 'chapter-confirmations' })} -->\n# 正文确认\n`;
const request = (projectId: string, path: string, sourceHash: string, expectedHash = ''): ConfirmChapterVersionRequest => ({ projectId, path, sourceHash, expectedHash });
const noTemporaryRecords = async (directory: string) => assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.confirmation.tmp') || name.endsWith('.tmp')), false);

test('正文明确确认：默认空记录、原件预览、重复拒绝、新版停旧、显式停用与两书隔离', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('林夏找到了虚构车票。\n列车尚未抵达。'));
  const initial = await f.confirmations.read(f.a.id), original = await fs.readFile(path.join(f.folderA, chapter.path));
  assert.deepEqual(initial, { value: { schemaVersion: 1, projectId: f.a.id, entries: [] }, hash: '', staleIds: [] });
  await assert.rejects(fs.stat(f.file), /ENOENT/u);
  const preview = await f.confirmations.preview(f.a.id, chapter.path);
  assert.equal(preview.projectId, f.a.id); assert.equal(preview.path, chapter.path); assert.equal(preview.hash, chapter.hash);
  assert.match(preview.text, /车票/u); assert.ok(preview.text.includes('\u3000\u3000')); assert.equal(preview.characters, preview.text.length); assert.equal(preview.paragraphCount, 2); assert.ok(preview.warnings.length);
  let saved = await f.confirmations.confirm(request(f.a.id, preview.path, preview.hash, initial.hash));
  assert.equal(saved.value.entries.length, 1); assert.equal(saved.value.entries[0].enabled, true); assert.equal(saved.value.entries[0].sourceHash, chapter.hash); assert.deepEqual(saved.staleIds, []);
  assert.equal((await f.confirmations.read(f.b.id)).value.entries.length, 0);
  await assert.rejects(f.confirmations.confirm(request(f.a.id, preview.path, preview.hash, saved.hash)), /重复确认/u);
  await assert.rejects(f.confirmations.confirm(request(f.b.id, preview.path, preview.hash)), /ENOENT/u);
  assert.deepEqual(await fs.readFile(path.join(f.folderA, chapter.path)), original);
  const updated = await f.workspace.saveChapter({ projectId: f.a.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('林夏放下了车票。') });
  assert.deepEqual((await f.confirmations.read(f.a.id)).staleIds, [saved.value.entries[0].id]);
  await assert.rejects(f.confirmations.confirm(request(f.a.id, preview.path, preview.hash, saved.hash)), /原件已变化/u);
  saved = await f.confirmations.confirm(request(f.a.id, updated.path, updated.hash, saved.hash));
  assert.deepEqual(saved.value.entries.map(entry => entry.enabled), [false, true]); assert.deepEqual(saved.staleIds, []);
  const id = saved.value.entries[1].id, beforeDisable = await fs.readFile(path.join(f.folderA, chapter.path));
  const disabled = await f.confirmations.disable(f.a.id, id, saved.hash);
  assert.deepEqual(disabled.value.entries.map(entry => entry.enabled), [false, false]); assert.deepEqual(await fs.readFile(path.join(f.folderA, chapter.path)), beforeDisable);
  assert.equal((await fs.readdir(path.join(f.materials, f.a.id, 'history'))).filter(name => name.startsWith('正文确认-')).length, 2);
  const restarted = new Workspace(f.local, f.materials); await restarted.initialize();
  assert.deepEqual(await new ChapterConfirmationStore(restarted, f.materials).read(f.a.id), disabled);
  // Reconfirmation is an explicit new author decision; disabled history stays.
  const reconfirmed = await f.confirmations.confirm(request(f.a.id, updated.path, updated.hash, disabled.hash));
  assert.deepEqual(reconfirmed.value.entries.map(entry => entry.enabled), [false, false, true]);
});

test('来源变化、缺失、不可读只标enabled过期，停用无需解析真实原件', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('虚构正文。'), 'txt');
  const saved = await f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash)), original = await fs.readFile(f.file);
  await fs.writeFile(path.join(f.folderA, chapter.path), '原件已在外部改变');
  assert.deepEqual((await f.confirmations.read(f.a.id)).staleIds, [saved.value.entries[0].id]);
  await fs.unlink(path.join(f.folderA, chapter.path));
  assert.deepEqual((await f.confirmations.read(f.a.id)).staleIds, [saved.value.entries[0].id]);
  assert.deepEqual(await fs.readFile(f.file), original);
  const originalHash = f.workspace.chapterHash.bind(f.workspace), originalKnowledge = f.workspace.readChapterKnowledge.bind(f.workspace);
  let reads = 0; f.workspace.chapterHash = async () => { reads++; throw new Error('原件不可读'); }; f.workspace.readChapterKnowledge = async () => { throw new Error('不应解析正文'); };
  assert.deepEqual((await f.confirmations.read(f.a.id)).staleIds, [saved.value.entries[0].id]); assert.equal(reads, 1);
  reads = 0; const metadata = await f.confirmations.read(f.a.id, false); assert.equal(reads, 0); assert.deepEqual(metadata.staleIds, []); assert.equal(metadata.value.entries[0].enabled, true);
  const disabled = await f.confirmations.disable(f.a.id, saved.value.entries[0].id, metadata.hash); assert.equal(reads, 0); assert.equal(disabled.value.entries[0].enabled, false);
  await assert.rejects(f.confirmations.disable(f.b.id, saved.value.entries[0].id, ''), /本书未找到/u);
  await assert.rejects(f.confirmations.disable(f.a.id, randomUUID(), disabled.hash), /本书未找到/u);
  f.workspace.chapterHash = originalHash; f.workspace.readChapterKnowledge = originalKnowledge;
});

test('安全重命名投影继续同字节确认，旧资料hash/旧预览拒绝且历史文件保留', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('改名前的虚构正文。'));
  const saved = await f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash)), recordBefore = await fs.readFile(f.file), bytesBefore = await fs.readFile(path.join(f.folderA, chapter.path));
  const renamed = await f.workspace.renameChapter({ projectId: f.a.id, path: chapter.path, expectedHash: chapter.hash, name: '明确确认后的章' });
  const projected = await f.confirmations.read(f.a.id);
  assert.equal(projected.value.entries[0].sourcePath, renamed.path); assert.notEqual(projected.hash, saved.hash); assert.deepEqual(projected.staleIds, []);
  assert.deepEqual(await fs.readFile(f.file), recordBefore); assert.deepEqual(await fs.readFile(path.join(f.folderA, renamed.path)), bytesBefore);
  await assert.rejects(f.confirmations.disable(f.a.id, saved.value.entries[0].id, saved.hash), /已更新/u);
  await assert.rejects(f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash, projected.hash)), /重命名/u);
  const preview = await f.confirmations.preview(f.a.id, renamed.path); assert.equal(preview.path, renamed.path);
  await assert.rejects(f.confirmations.confirm(request(f.a.id, renamed.path, renamed.hash, projected.hash)), /重复确认/u);
  const disabled = await f.confirmations.disable(f.a.id, saved.value.entries[0].id, projected.hash); assert.equal(disabled.value.entries[0].sourcePath, renamed.path);
  const metadata = await f.confirmations.read(f.a.id, false); assert.deepEqual(metadata, disabled);
});

test('原件正文预览不信托管编辑缓存，空正文、超限文件和无效严格请求不能确认', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('原件拥有真实车票。'));
  const state = path.join(f.folderA, '小说资料', 'documents', chapter.hash + '.json'), original = await fs.readFile(path.join(f.folderA, chapter.path));
  const forged = JSON.stringify({ schemaVersion: 1, projectId: f.a.id, hash: chapter.hash, content: textDocument('伪造缓存的虚构钥匙。') }); await fs.writeFile(state, forged);
  const preview = await f.confirmations.preview(f.a.id, chapter.path); assert.match(preview.text, /真实车票/u); assert.doesNotMatch(preview.text, /伪造|钥匙/u);
  await f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash));
  assert.deepEqual(await fs.readFile(path.join(f.folderA, chapter.path)), original); assert.equal(await fs.readFile(state, 'utf8'), forged);
  await fs.writeFile(path.join(f.folderB, '空白.txt'), '\u3000\u3000\r\n \t');
  const emptyHash = await f.workspace.chapterHash(f.b.id, '空白.txt');
  await assert.rejects(f.confirmations.preview(f.b.id, '空白.txt'), /为空/u); await assert.rejects(f.confirmations.confirm(request(f.b.id, '空白.txt', emptyHash)), /为空/u);
  await fs.writeFile(path.join(f.folderB, '字符超限.txt'), '文'.repeat(200001)); await assert.rejects(f.confirmations.preview(f.b.id, '字符超限.txt'), /20万字符/u);
  const huge = await fs.open(path.join(f.folderB, '过大.txt'), 'w'); await huge.truncate(8 * 1024 * 1024 + 1); await huge.close(); await assert.rejects(f.confirmations.preview(f.b.id, '过大.txt'), /8MiB/u);
  for (const relative of ['../小说甲/原件.txt', '小说资料/资料.txt', 'E:\\原件.txt', '/原件.txt', '非法.md', '无效\u0000.txt']) await assert.rejects(f.confirmations.preview(f.a.id, relative));
  await assert.rejects(f.confirmations.confirm({ ...request(f.b.id, '空白.txt', emptyHash), authorConfirmed: true } as ConfirmChapterVersionRequest));
  await assert.rejects(f.confirmations.confirm(request(f.b.id, '空白.txt', 'wrong'))); await assert.rejects(f.confirmations.confirm(request(f.b.id, '空白.txt', emptyHash, 'wrong')));
  assert.equal((await f.confirmations.read(f.b.id)).value.entries.length, 0);
});

test('未知版本、串书、重复ID、非法路径、同章两个启用及历史别名冲突拒绝且原记录保留', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('记录边界测试。'), 'txt');
  const saved = await f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash)), original = await fs.readFile(f.file), entry = saved.value.entries[0];
  const bad = [
    { ...saved.value, schemaVersion: 99 }, { ...saved.value, projectId: f.b.id },
    { ...saved.value, entries: [{ ...entry, projectId: f.b.id }] }, { ...saved.value, entries: [entry, entry] },
    { ...saved.value, entries: [{ ...entry, sourcePath: '../小说乙/原稿.txt' }] }, { ...saved.value, entries: [{ ...entry, sourcePath: '小说资料/伪正文.txt' }] },
    { ...saved.value, entries: [{ ...entry, sourcePath: '不支持.md' }] }, { ...saved.value, entries: [entry, { ...entry, id: randomUUID() }] },
    { ...saved.value, entries: [{ ...entry, sourceHash: 'broken' }] }, { ...saved.value, entries: [{ ...entry, unexpected: true }] },
    { ...saved.value, entries: Array.from({ length: 1001 }, () => ({ ...entry, id: randomUUID(), enabled: false })) }
  ];
  for (const value of bad) {
    const raw = rawRecord(value); await fs.writeFile(f.file, raw);
    await assert.rejects(f.confirmations.read(f.a.id, false)); await assert.rejects(f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash, saved.hash))); assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  }
  await fs.writeFile(f.file, original);
  const renamed = await f.workspace.renameChapter({ projectId: f.a.id, path: chapter.path, expectedHash: chapter.hash, name: '历史绑定章' });
  const aliasConflict = rawRecord({ ...saved.value, entries: [entry, { ...entry, id: randomUUID(), sourcePath: renamed.path }] });
  await fs.writeFile(f.file, aliasConflict); await assert.rejects(f.confirmations.read(f.a.id, false), /同章/u); assert.equal(await fs.readFile(f.file, 'utf8'), aliasConflict);
});

test('准备期间原件与记录外部变化拒绝，首次独占发布保留抢先记录并清理暂存', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('竞态测试原件。'), 'txt');
  const hashing = f.workspace.chapterHash.bind(f.workspace); let hashes = 0;
  f.workspace.chapterHash = async (id, relative) => { if (++hashes === 3) await fs.writeFile(path.join(f.folderA, chapter.path), '准备期间外部改写'); return hashing(id, relative); };
  await assert.rejects(f.confirmations.confirm(request(f.a.id, chapter.path, chapter.hash)), /原件已变化/u); await assert.rejects(fs.stat(f.file), /ENOENT/u);
  assert.equal(await fs.readFile(path.join(f.folderA, chapter.path), 'utf8'), '准备期间外部改写'); await noTemporaryRecords(path.dirname(f.file));
  f.workspace.chapterHash = hashing;
  const hash = await hashing(f.a.id, chapter.path), resolving = f.workspace.resolveChapterPaths.bind(f.workspace); let loads = 0;
  const external = rawRecord({ schemaVersion: 1, projectId: f.a.id, entries: [] });
  f.workspace.resolveChapterPaths = async (id, paths) => { if (++loads === 3) await fs.writeFile(f.file, external, { flag: 'wx' }); return resolving(id, paths); };
  await assert.rejects(f.confirmations.confirm(request(f.a.id, chapter.path, hash)), /外部更新|变化|EEXIST/u); assert.equal(await fs.readFile(f.file, 'utf8'), external); await noTemporaryRecords(path.dirname(f.file));
  f.workspace.resolveChapterPaths = resolving;
  const fresh = await f.confirmations.read(f.a.id), saved = await f.confirmations.confirm(request(f.a.id, chapter.path, hash, fresh.hash));
  loads = 0;
  const changed = rawRecord({ ...saved.value, entries: saved.value.entries.map(entry => ({ ...entry, enabled: false })) });
  f.workspace.resolveChapterPaths = async (id, paths) => { if (++loads === 3) await fs.writeFile(f.file, changed); return resolving(id, paths); };
  await assert.rejects(f.confirmations.disable(f.a.id, saved.value.entries[0].id, saved.hash), /外部更新|变化/u); assert.equal(await fs.readFile(f.file, 'utf8'), changed); await noTemporaryRecords(path.dirname(f.file));
  f.workspace.resolveChapterPaths = resolving;
  await assert.rejects(f.confirmations.confirm(request(f.a.id, chapter.path, hash, saved.hash)), /已更新/u);
});

test('排队请求冻结project/path/hash，重复串行确认只能一次，预览期间重命名不得跟随', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('冻结确认请求。'), 'txt');
  const input = request(f.a.id, chapter.path, chapter.hash), frozenRequest = f.confirmations.confirm(input);
  input.projectId = f.b.id; input.path = '../越界.txt'; input.sourceHash = '0'.repeat(64); input.expectedHash = '1'.repeat(64);
  const saved = await frozenRequest; assert.equal(saved.value.entries[0].projectId, f.a.id); assert.equal(saved.value.entries[0].sourceHash, chapter.hash); assert.equal((await f.confirmations.read(f.b.id)).value.entries.length, 0);
  const candidate = await f.workspace.saveChapter({ projectId: f.a.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('第二版冻结请求。') });
  const outcomes = await Promise.allSettled([f.confirmations.confirm(request(f.a.id, candidate.path, candidate.hash, saved.hash)), f.confirmations.confirm(request(f.a.id, candidate.path, candidate.hash, saved.hash))]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1); assert.equal((await f.confirmations.read(f.a.id)).value.entries.length, 2);
  const reading = f.workspace.readChapterKnowledge.bind(f.workspace); let renamed = false;
  f.workspace.readChapterKnowledge = async (id, relative) => { const result = await reading(id, relative); if (!renamed) { renamed = true; await f.workspace.renameChapter({ projectId: id, path: relative, expectedHash: result.hash, name: '预览期间改名' }); } return result; };
  await assert.rejects(f.confirmations.preview(f.a.id, candidate.path), /重命名|路径已变化/u);
  f.workspace.readChapterKnowledge = reading;
});

test('1000条历史读取有界，满额追加拒绝但停用仍可保存', async t => {
  const f = await fixture(t), chapter = await f.workspace.createChapter(f.a.id, textDocument('历史上限原件。'), 'txt');
  const value: ChapterConfirmationSnapshot['value'] = { schemaVersion: 1, projectId: f.a.id, entries: Array.from({ length: 1000 }, (_, index) => ({ id: randomUUID(), projectId: f.a.id, sourcePath: chapter.path, sourceHash: chapter.hash, confirmedAt: new Date().toISOString(), enabled: index === 999 })) };
  await f.confirmations.read(f.a.id); await fs.writeFile(f.file, rawRecord(value));
  const current = await f.confirmations.read(f.a.id, false), latest = value.entries.at(-1)!;
  const next = await f.workspace.saveChapter({ projectId: f.a.id, path: chapter.path, expectedHash: chapter.hash, content: textDocument('新版本不得超过记录上限。') });
  const raw = await fs.readFile(f.file); await assert.rejects(f.confirmations.confirm(request(f.a.id, next.path, next.hash, current.hash)), /1000条/u); assert.deepEqual(await fs.readFile(f.file), raw);
  const disabled = await f.confirmations.disable(f.a.id, latest.id, current.hash); assert.equal(disabled.value.entries.length, 1000); assert.equal(disabled.value.entries.some(entry => entry.enabled), false);
});

test('合法U+2028/U+2029章节名确认和停用可重读，metadata转义保留原路径与原件字节', async t => {
  const f = await fixture(t), expectedPaths: string[] = [];
  const checkHeader = async () => {
    const header = (await fs.readFile(f.file, 'utf8')).split('\n')[0];
    assert.doesNotMatch(header, /[\u2028\u2029]/u);
    const match = /^<!-- novel-writer (.+) -->$/u.exec(header); assert.ok(match);
    const parsed = JSON.parse(match[1]);
    assert.deepEqual(parsed.entries.map((entry: { sourcePath: string }) => entry.sourcePath), expectedPaths);
    return header;
  };
  for (const separator of ['\u2028', '\u2029']) {
    const relative = `虚构${separator}章节.txt`, original = Buffer.from('　　特殊合法文件名的虚构正文。', 'utf8');
    await fs.writeFile(path.join(f.folderA, relative), original);
    const preview = await f.confirmations.preview(f.a.id, relative), current = await f.confirmations.read(f.a.id, false);
    assert.equal(preview.path, relative); assert.match(preview.text, /虚构正文/u);
    const saved = await f.confirmations.confirm(request(f.a.id, preview.path, preview.hash, current.hash));
    expectedPaths.push(relative); assert.equal(saved.value.entries.at(-1)!.sourcePath, relative);
    assert.deepEqual(await f.confirmations.read(f.a.id, false), saved); assert.deepEqual(await f.confirmations.read(f.a.id), saved);
    assert.match(await checkHeader(), separator === '\u2028' ? /\\u2028/u : /\\u2029/u);
    // Previously serialized headers remain valid JSON even with literal Unicode
    // separators. Reading them must preserve the record and its original paths.
    const serialized = await fs.readFile(f.file, 'utf8'), firstNewline = serialized.indexOf('\n');
    const legacyHeader = serialized.slice(0, firstNewline).replace(/\\u2028/gu, '\u2028').replace(/\\u2029/gu, '\u2029');
    const legacyRaw = legacyHeader + serialized.slice(firstNewline); await fs.writeFile(f.file, legacyRaw);
    const legacy = await f.confirmations.read(f.a.id, false);
    assert.deepEqual(legacy.value, saved.value); assert.notEqual(legacy.hash, saved.hash); assert.deepEqual(await f.confirmations.read(f.a.id), legacy);
    assert.equal(await fs.readFile(f.file, 'utf8'), legacyRaw);
    const disabled = await f.confirmations.disable(f.a.id, saved.value.entries.at(-1)!.id, legacy.hash);
    assert.equal(disabled.value.entries.at(-1)!.sourcePath, relative); assert.equal(disabled.value.entries.at(-1)!.enabled, false);
    assert.deepEqual(await f.confirmations.read(f.a.id, false), disabled); assert.deepEqual(await f.confirmations.read(f.a.id), disabled);
    await checkHeader(); assert.deepEqual(await fs.readFile(path.join(f.folderA, relative)), original);
  }
  assert.deepEqual((await f.confirmations.read(f.a.id)).value.entries.map(entry => entry.sourcePath), expectedPaths);
});
