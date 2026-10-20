import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../src/main/workspace';
import { LibraryStore } from '../src/main/library';
import { StoryMemoryStore } from '../src/main/story-memory';
import { RecoveryStore } from '../src/main/recovery';
import { AIConnections, hashText } from '../src/main/ai-connections';
import { AIService } from '../src/main/ai-service';
import { CharacterStore } from '../src/main/characters';
import { encodeDocx } from '../src/main/docx';
import { textDocument } from '../src/main/text-import';
import type { AITask } from '../src/shared/contracts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-rename-test-')), local = path.join(root, 'local'), materials = path.join(root, 'materials');
  t.after(async () => { assert.match(path.relative(os.tmpdir(), root), /^novel-rename-test-[^\\/]+$/); await fs.rm(root, { recursive: true, force: true }); });
  const folderA = path.join(root, '小说甲'), folderB = path.join(root, '小说乙'); await fs.mkdir(folderA); await fs.mkdir(folderB);
  const workspace = new Workspace(local, materials); await workspace.initialize(); const a = await workspace.attach(folderA), b = await workspace.attach(folderB);
  const library = new LibraryStore(id => workspace.getProject(id), materials, (id, p) => workspace.resolveChapterPath(id, p)); const memory = new StoryMemoryStore(workspace, materials);
  return { root, local, materials, folderA, folderB, workspace, a, b, library, memory };
}
const journals = async (folder: string) => { const root = path.join(folder, '小说资料/chapter-renames'); return (await fs.readdir(root)).filter(id => /^[a-f0-9-]{36}$/i.test(id)).map(id => path.join(root, id)); };

test('章节重命名保留原件字节/格式和归档，旧路径禁止写入，目标/名称/跨书/外部变化拒绝', async t => {
  const f = await fixture(t); const nested = path.join(f.folderA, '正文'); await fs.mkdir(nested);
  const bytes = await encodeDocx(textDocument('外部原稿，字体和内容不得改写。')); const old = path.join('正文', '原稿.docx'); await fs.writeFile(path.join(f.folderA, old), bytes);
  const initial = await f.workspace.readChapter(f.a.id, old); assert.equal(initial.managed, false);
  const next = await f.workspace.renameChapter({ projectId: f.a.id, path: old, expectedHash: initial.hash, name: '第一章' });
  assert.equal(next.path, path.join('正文', '第一章.docx')); assert.equal(next.hash, initial.hash); assert.equal(next.managed, false);
  assert.deepEqual(await fs.readFile(path.join(f.folderA, next.path)), bytes); await assert.rejects(fs.stat(path.join(f.folderA, old)), /ENOENT/);
  const history = (await journals(f.folderA))[0]; assert.deepEqual(await fs.readFile(path.join(history, 'original.docx')), bytes); assert.deepEqual(await fs.readFile(path.join(history, 'snapshot.docx')), bytes);
  assert.equal((await f.workspace.readChapter(f.a.id, old)).path, next.path);
  await assert.rejects(f.workspace.saveChapter({ projectId: f.a.id, path: old, expectedHash: initial.hash, content: textDocument('旧路径异步写入不得发生') }), /旧路径不能写入/);
  for (const name of ['../坏路径', 'CON', '尾部.', '含:冒号', 'NUL.txt', '空格 ']) await assert.rejects(f.workspace.renameChapter({ projectId: f.a.id, path: next.path, expectedHash: next.hash, name }), /无效|保留字符/);
  await fs.writeFile(path.join(nested, '存在.docx'), bytes); await assert.rejects(f.workspace.renameChapter({ projectId: f.a.id, path: next.path, expectedHash: next.hash, name: '存在' }), /已存在/);
  await assert.rejects(f.workspace.renameChapter({ projectId: f.a.id, path: next.path, expectedHash: next.hash, name: '原稿' }), /历史章节/);
  await assert.rejects(f.workspace.renameChapter({ projectId: f.b.id, path: next.path, expectedHash: next.hash, name: '另一书' }));
  await assert.rejects(f.workspace.renameChapter({ projectId: f.a.id, path: '../小说乙/原稿.docx', expectedHash: next.hash, name: '越界' }), /越界/);
  const changed = await encodeDocx(textDocument('外部修改的新正文')); await fs.writeFile(path.join(f.folderA, next.path), changed);
  await assert.rejects(f.workspace.renameChapter({ projectId: f.a.id, path: next.path, expectedHash: next.hash, name: '新名称' }), /其他程序修改/); assert.deepEqual(await fs.readFile(path.join(f.folderA, next.path)), changed);
  const movedFolder = path.join(f.folderA, '正文外部改名'); assert.ok(!path.relative(f.folderA, movedFolder).startsWith('..')); await fs.rename(nested, movedFolder);
  assert.equal(await f.workspace.resolveChapterPath(f.a.id, old), next.path); await assert.rejects(f.workspace.chapterHash(f.a.id, next.path), /ENOENT/); assert.ok((await f.workspace.chapters(f.a.id)).some(chapter => chapter.path.startsWith('正文外部改名')));
  const legacy = '旧编码.txt', legacyBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('原编码保留', 'utf16le')]); await fs.writeFile(path.join(f.folderB, legacy), legacyBytes);
  const txt = await f.workspace.readChapter(f.b.id, legacy); const renamedTxt = await f.workspace.renameChapter({ projectId: f.b.id, path: legacy, expectedHash: txt.hash, name: '兼容文本' }); assert.equal(renamedTxt.managed, false); assert.deepEqual(await fs.readFile(path.join(f.folderB, renamedTxt.path)), legacyBytes);
});

test('分集与确认摘要通过本书历史路径继续定位，旧资料基准拒绝，原文改动失效且暂存来源保留', async t => {
  const f = await fixture(t); const doc = await f.workspace.createChapter(f.a.id, textDocument('林夏走进学园。'));
  const book = await f.library.read(f.a.id); const assigned = await f.library.save(f.a.id, { ...book.value, volumes: [{ id: randomUUID(), title: '第一集', introduction: '', cover: '', chapters: [doc.path] }] }, book.hash);
  const beforeBook = await fs.readFile(path.join(f.folderA, '小说资料/book.json'));
  const initial = await f.memory.read(f.a.id), entry = { id: randomUUID(), projectId: f.a.id, sourcePath: doc.path, sourceHash: doc.hash, content: '林夏已经进入学园。', taskId: randomUUID(), model: '模拟摘要', createdAt: new Date().toISOString(), enabled: true, important: false };
  const saved = await f.memory.add(f.a.id, entry, initial.hash); const beforeMemory = await fs.readFile(path.join(f.materials, f.a.id, '故事记忆.md'));
  const recovery = new RecoveryStore(path.join(f.local, 'recovery-checkpoints'), f.workspace), session = randomUUID(); await recovery.checkpoint({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, id: session, revision: 1, content: textDocument('重命名前暂存草稿。') });
  const renamed = await f.workspace.renameChapter({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, name: '第一章·入学' });
  const projectedBook = await f.library.read(f.a.id), projectedMemory = await f.memory.read(f.a.id);
  assert.equal(projectedBook.value.volumes[0].chapters[0], renamed.path); assert.notEqual(projectedBook.hash, assigned.hash);
  assert.equal(projectedMemory.value.entries[0].sourcePath, renamed.path); assert.equal(projectedMemory.staleIds.length, 0); assert.notEqual(projectedMemory.hash, saved.hash); assert.match(await f.memory.context(f.a.id), /第一章·入学/);
  // Projections change immediately without rewriting historical source files.
  assert.deepEqual(await fs.readFile(path.join(f.folderA, '小说资料/book.json')), beforeBook); assert.deepEqual(await fs.readFile(path.join(f.materials, f.a.id, '故事记忆.md')), beforeMemory);
  await assert.rejects(f.library.save(f.a.id, assigned.value, assigned.hash), /已更新/); await assert.rejects(f.memory.update(f.a.id, entry.id, true, true, saved.hash), /冲突|更新/);
  const fresh = await f.memory.update(f.a.id, entry.id, true, true, projectedMemory.hash); assert.equal(fresh.value.entries[0].sourcePath, renamed.path);
  assert.equal((await recovery.read(f.a.id, session)).sourcePath, doc.path); assert.match(JSON.stringify((await recovery.read(f.a.id, session)).content), /重命名前/);
  const second = await f.workspace.renameChapter({ projectId: f.a.id, path: renamed.path, expectedHash: renamed.hash, name: '第一章·雨的序幕' }); assert.equal((await f.workspace.readChapter(f.a.id, doc.path)).path, second.path); assert.equal((await f.library.read(f.a.id)).value.volumes[0].chapters[0], second.path);
  await f.workspace.saveChapter({ projectId: f.a.id, path: second.path, expectedHash: second.hash, content: textDocument('修改已采纳正文。') }); assert.deepEqual((await f.memory.read(f.a.id)).staleIds, [entry.id]);
  assert.equal((await f.memory.read(f.b.id)).value.entries.length, 0);
});

test('重命名中断可按归档证据恢复，未知版本/历史名被占用不静默覆盖', async t => {
  const f = await fixture(t), doc = await f.workspace.createChapter(f.a.id, textDocument('中断测试。'), 'txt');
  const next = await f.workspace.renameChapter({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, name: '恢复后的章' }), journal = (await journals(f.folderA))[0], file = path.join(journal, 'operation.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8')); await fs.writeFile(file, JSON.stringify({ ...record, status: 'prepared' })); await fs.writeFile(path.join(f.folderA, next.path), '重启前外部修改，必须保留');
  const restarted = new Workspace(f.local, f.materials); await restarted.initialize(); const restored = await restarted.readChapter(f.a.id, doc.path); assert.equal(restored.path, next.path); assert.match(JSON.stringify(restored.content), /必须保留/); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'committed');
  const source = '复制后中断.txt', target = '恢复复制.txt', bytes = Buffer.from('复制后中断'), id = randomUUID(), directory = path.join(f.folderA, '小说资料/chapter-renames', id); await fs.mkdir(directory);
  await fs.writeFile(path.join(f.folderA, source), bytes); await fs.writeFile(path.join(f.folderA, target), bytes); await fs.writeFile(path.join(directory, 'snapshot.txt'), bytes);
  await fs.writeFile(path.join(directory, 'operation.json'), JSON.stringify({ schemaVersion: 1, projectId: f.a.id, id, from: source, to: target, sourceHash: hashText(bytes.toString()), createdAt: new Date().toISOString(), status: 'prepared' }));
  assert.equal(await restarted.resolveChapterPath(f.a.id, source), target); await assert.rejects(fs.stat(path.join(f.folderA, source)), /ENOENT/); assert.deepEqual(await fs.readFile(path.join(directory, 'original.txt')), bytes);
  const unknown = JSON.stringify({ ...record, schemaVersion: 99 }); await fs.writeFile(file, unknown); await assert.rejects(restarted.chapters(f.a.id)); assert.equal(await fs.readFile(file, 'utf8'), unknown);
  await fs.writeFile(file, JSON.stringify(record)); await fs.writeFile(path.join(f.folderA, doc.path), '另一份同名原文'); await assert.rejects(restarted.chapterHash(f.a.id, doc.path), /重新占用/); assert.equal(await fs.readFile(path.join(f.folderA, doc.path), 'utf8'), '另一份同名原文');
});

test('旧AI候选历史保留旧名称，读取绑定同一章并校验版本，旧摘要确认转为新来源路径', async t => {
  const f = await fixture(t), doc = await f.workspace.createChapter(f.a.id, textDocument('原始正文。'));
  const connections = new AIConnections(f.local, { encrypt: s => Buffer.from(s), decrypt: b => b.toString() });
  const characters = new CharacterStore(id => f.workspace.getProject(id), f.materials); const service = new AIService(f.local, connections, f.workspace, f.library, characters, undefined, f.memory);
  const writer: AITask = { schemaVersion: 1, id: randomUUID(), projectId: f.a.id, mode: 'write', chapterPath: doc.path, sourceHash: doc.hash, instruction: '测试', connection: { id: randomUUID(), name: '模拟', model: 'mock', baseUrl: 'http://127.0.0.1:1/v1', adapter: 'generic', thinking: 'default', timeoutSeconds: 60, contextWindow: 32768, maxOutputTokens: 1000, tokenParameter: 'max_tokens' }, createdAt: new Date().toISOString(), status: 'complete', text: '候选正文。', error: '', finishReason: 'stop', contextHash: hashText(''), context: '', sourceText: '原始正文。' };
  const tasks = path.join(f.local, 'ai-tasks', f.a.id); await fs.mkdir(tasks, { recursive: true }); const taskFile = path.join(tasks, writer.id + '.json'), raw = JSON.stringify(writer); await fs.writeFile(taskFile, raw);
  const next = await f.workspace.renameChapter({ projectId: f.a.id, path: doc.path, expectedHash: doc.hash, name: '可追溯章' });
  const exported = await service.export(f.a.id, writer.id); assert.notEqual(exported.path, next.path); assert.equal((await service.list(f.a.id))[0].chapterPath, doc.path); assert.equal(await fs.readFile(taskFile, 'utf8'), raw);
  await assert.rejects(service.export(f.b.id, writer.id), /未找到/);
  const summary: AITask = { ...writer, id: randomUUID(), mode: 'summary', text: '正式摘要。' }; await fs.writeFile(path.join(tasks, summary.id + '.json'), JSON.stringify(summary)); const mem = await f.memory.read(f.a.id);
  const confirmed = await service.confirmSummary(f.a.id, summary.id, '作者确认摘要。', mem.hash); assert.equal(confirmed.value.entries[0].sourcePath, next.path); assert.equal(confirmed.staleIds.length, 0);
  await f.workspace.saveChapter({ projectId: f.a.id, path: next.path, expectedHash: next.hash, content: textDocument('已改变原文。') }); await assert.rejects(service.export(f.a.id, writer.id), /正文或设定已更新/); assert.equal(await fs.readFile(taskFile, 'utf8'), raw);
});
