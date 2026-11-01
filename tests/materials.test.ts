import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { CharacterStore } from '../src/main/characters';
import { LibraryStore } from '../src/main/library';
import { charactersMarkdown, parseCharactersMarkdown, parseNotesMarkdown } from '../src/main/markdown-materials';
import { emptyCharacter } from '../src/core/characters';
import { materialTemplate, parseMaterial } from '../src/core/material-conversion';
import { copyableText } from '../src/core/typography';
import { textDocument } from '../src/main/text-import';
import { encodeDocx } from '../src/main/docx';
import { cardPng, v2 } from './card-fixtures';

test('固定目录 Markdown：迁移旧资料/头像/扩展，外部编辑可读，冲突与未来版本不覆盖', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-md-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = path.join(root, 'local'), materials = path.join(root, '应用', '创作资料');
  const old = new Workspace(local); await old.initialize(); const folder = path.join(root, '小说'); await fs.mkdir(folder); const project = await old.attach(folder);
  const note = await old.readNotes(project.id); await old.saveNotes(project.id, { ...note.value, world: '旧世界观', characters: '旧人物笔记' }, note.hash);
  const oldCards = new CharacterStore(id => old.getProject(id));
  const preview = oldCards.prepare(project.id, '旧卡.png', cardPng([{ key: 'chara', value: v2 }]), cardPng());
  const legacy = await oldCards.save(project.id, { fields: preview.fields, enabled: true, importToken: preview.token }, '');
  const oldRaw = await fs.readFile(path.join(folder, '小说资料', 'characters.json'));
  const workspace = new Workspace(local, materials); await workspace.initialize();
  const cards = new CharacterStore(id => workspace.getProject(id), materials);
  let snapshot = await cards.read(project.id); assert.deepEqual(snapshot.value, legacy.value);
  const cardFile = path.join(materials, project.id, '人物卡.md'), noteFile = path.join(materials, project.id, '创作笔记.md');
  assert.deepEqual(parseCharactersMarkdown(await fs.readFile(cardFile, 'utf8'), project.id), snapshot.value);
  assert.equal((await workspace.readNotes(project.id)).value.world, '旧世界观');
  assert.equal(parseNotesMarkdown(await fs.readFile(noteFile, 'utf8'), project.id).characters, '旧人物笔记');
  assert.deepEqual(await fs.readFile(path.join(folder, '小说资料', 'characters.json')), oldRaw);
  assert.deepEqual(await fs.readFile(path.join(materials, project.id, 'character-originals', legacy.value.cards[0].source.original)), cardPng([{ key: 'chara', value: v2 }]));
  const before = snapshot.hash;
  const changed = { ...snapshot.value, cards: snapshot.value.cards.map(c => ({ ...c, personality: '外部编辑的性格\n## 可保留小标题\n' })) };
  await fs.writeFile(cardFile, charactersMarkdown(changed));
  assert.match((await cards.read(project.id)).value.cards[0].personality, /外部编辑/);
  await assert.rejects(cards.save(project.id, { fields: { ...emptyCharacter(), name: '新角色' }, enabled: false }, before), /外部更新/);
  snapshot = await cards.read(project.id);
  snapshot = await cards.save(project.id, { fields: { ...emptyCharacter(), name: '新角色' }, enabled: false }, snapshot.hash);
  assert.ok((await fs.readdir(path.join(materials, project.id, 'history'))).some(name => name.endsWith('.md')));
  const future = (await fs.readFile(cardFile, 'utf8')).replace('"schemaVersion":1', '"schemaVersion":99'); await fs.writeFile(cardFile, future);
  await assert.rejects(cards.read(project.id), /版本/);
  assert.equal(await fs.readFile(cardFile, 'utf8'), future);
  const second = path.join(root, '乙'); await fs.mkdir(second); const b = await workspace.attach(second);
  assert.equal((await cards.read(b.id)).value.cards.length, 0); assert.equal((await workspace.readNotes(b.id)).value.world, '');
});

test('DOCX/TXT 参考原件与 Markdown 文风读写，外部修改触发冲突', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-style-md-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize(); const folder = path.join(root, 'book'); await fs.mkdir(folder); const project = await workspace.attach(folder);
  const materials = path.join(root, 'materials'); const store = new LibraryStore(id => workspace.getProject(id), materials);
  let book = await store.read(project.id); const text = '他走进教室，看见窗外正在下雨。“你来啦？”同桌说。\n'.repeat(20);
  const original = await encodeDocx(textDocument(text));
  book = await store.addSources(project.id, [{ name: '参考.docx', text, original }, { name: '另一段.txt', text: text + '改变' }], book.hash);
  assert.deepEqual(await fs.readFile(path.join(folder, '小说资料', 'style-sources', `${book.value.sources[0].id}.docx`)), original);
  assert.equal(book.value.sources[1].format, 'txt');
  book = await store.analyze(project.id, '样本文风', [book.value.sources[0].id], book.hash);
  const file = path.join(materials, project.id, '文风档案.md'); assert.match(await fs.readFile(file, 'utf8'), /样本文风/);
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('样本文风', '外部文风'));
  assert.equal((await store.read(project.id)).value.styles[0].name, '外部文风');
  await assert.rejects(store.save(project.id, book.value, book.hash), /已更新/);
});

test('TXT 正文读写、外部冲突与非 UTF-8 原件保护，默认新建仍为 DOCX', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-txt-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(path.join(root, 'local')); await workspace.initialize(); const folder = path.join(root, 'book'); await fs.mkdir(folder); const project = await workspace.attach(folder);
  assert.match((await workspace.createChapter(project.id)).path, /\.docx$/);
  const doc = await workspace.createChapter(project.id, textDocument('第一段\n第二段'), 'txt');
  // TXT 落盘使用单换行分隔（txtText 策略；空段在 061 轮由 txt-roundtrip-061.test.ts 覆盖）。
  assert.equal(await fs.readFile(path.join(folder, doc.path), 'utf8'), '　　第一段\n　　第二段');
  const saved = await workspace.saveChapter({ projectId: project.id, path: doc.path, expectedHash: doc.hash, content: textDocument('修改的段落') });
  const read = await workspace.readChapter(project.id, saved.path); assert.equal(typeof read.content, 'object');
  if (typeof read.content !== 'string') assert.equal(copyableText(read.content), '　　修改的段落');
  await fs.writeFile(path.join(folder, doc.path), '外部变化');
  await assert.rejects(workspace.saveChapter({ projectId: project.id, path: doc.path, expectedHash: saved.hash, content: textDocument('不要覆盖') }), /其他程序/);
  assert.equal(await fs.readFile(path.join(folder, doc.path), 'utf8'), '外部变化');
  await fs.writeFile(path.join(folder, '旧编码.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('原始文本', 'utf16le')]));
  const legacy = await workspace.readChapter(project.id, '旧编码.txt'); assert.equal(legacy.managed, false);
  await assert.rejects(workspace.saveChapter({ projectId: project.id, path: legacy.path, expectedHash: legacy.hash, content: textDocument('新文本') }), /非 UTF-8/);
  assert.ok((await workspace.chapters(project.id)).some(chapter => chapter.path === '旧编码.txt'));
});

test('人物卡/世界观固定模板可以编辑与验证，缺字段和重复标题不伪装成功', () => {
  const markdown = materialTemplate('character', '她是一位学生。', '林夏');
  const card = parseMaterial('character', markdown); assert.equal(typeof card, 'object'); if (typeof card !== 'string') assert.equal(card.name, '林夏');
  assert.match(parseMaterial('world', materialTemplate('world', '这里没有魔法。')) as string, /没有魔法/);
  assert.throws(() => parseMaterial('character', '林夏是学生'), /标题/);
  assert.throws(() => parseMaterial('character', markdown + '\n\n## 姓名\n另一个'), /标题/);
});
