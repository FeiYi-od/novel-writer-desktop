import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { WorldInfoStore } from '../src/main/world-info';
import { parseCardBook } from '../src/core/st-cards';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-world-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, workspace, store: new WorldInfoStore(workspace) };
}
const world = (entries: Record<string, unknown>) => ({ name: '北方', entries });

test('世界书存储：导入、列出、预览命中条目', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.list(f.project.id), []);
  const imported = await f.store.import(f.project.id, '北方世界', world({
    '0': { key: ['北门'], content: '北门在雨夜关闭。', order: 5 },
    '1': { key: ['月钥'], content: '月钥只认林夏。', order: 9 }
  }));
  assert.deepEqual(imported, { name: '北方世界', entries: 2 });
  const books = await f.store.list(f.project.id);
  assert.deepEqual(books.map(book => [book.name, book.entries, book.keys]), [['北方世界', 2, 2]]);
  const hits = await f.store.preview(f.project.id, ['北方世界'], '林夏走到北门。');
  assert.deepEqual(hits.map(hit => hit.content), ['北门在雨夜关闭。']);
  assert.equal(hits[0].book, '北方世界');
});

test('世界书存储：同名拒绝、损坏文件被跳过、可删除', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '甲书', world({ '0': { key: ['a'], content: 'A' } }));
  await assert.rejects(f.store.import(f.project.id, '甲书', world({ '0': { key: ['b'], content: 'B' } })), /同名世界书已存在/u);
  await assert.rejects(f.store.import(f.project.id, '空书', world({})), /没有任何条目/u);
  await assert.rejects(f.store.import(f.project.id, '坏书', { foo: 1 }), /缺少 entries/u);
  const directory = path.join(f.root, '甲', '小说资料', '世界书');
  await fs.writeFile(path.join(directory, '损坏.json'), '{ not json', 'utf8');
  const books = await f.store.list(f.project.id);
  assert.equal(books.length, 2);
  assert.equal(books.find(book => book.name === '损坏')?.error, '文件损坏，已跳过');
  const target = books.find(book => book.name === '甲书'); assert.ok(target?.hash);
  await f.store.remove(f.project.id, '甲书', target.hash);
  assert.deepEqual((await f.store.list(f.project.id)).map(book => book.name), ['损坏']);
});

test('世界书删除前核对列表版本并保留原始备份', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '甲书', world({ '0': { key: ['星港'], content: '初版设定' } }));
  const selected = (await f.store.list(f.project.id))[0]; assert.ok(selected.hash);
  const source = path.join(f.root, '甲', '小说资料', '世界书', '甲书.json');
  const changed = JSON.stringify(world({ '0': { key: ['星港'], content: '外部更新' } }));
  await fs.writeFile(source, changed);
  await assert.rejects(f.store.remove(f.project.id, '甲书', selected.hash), /变化|版本/u);
  assert.equal(await fs.readFile(source, 'utf8'), changed);
  const latest = (await f.store.list(f.project.id))[0]; assert.ok(latest.hash);
  await f.store.remove(f.project.id, '甲书', latest.hash);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  const backups = path.join(f.root, '甲', '小说资料', '世界书删除备份');
  const saved = await fs.readdir(backups); assert.equal(saved.length, 1);
  assert.equal(await fs.readFile(path.join(backups, saved[0]), 'utf8'), changed);
});

test('世界书删除备份目录为链接时拒绝删除并保留原文件', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '甲书', world({ '0': { key: ['星港'], content: '保留原件' } }));
  const selected = (await f.store.list(f.project.id))[0]; assert.ok(selected.hash);
  const outside = path.join(f.root, '其他目录'); await fs.mkdir(outside);
  const link = path.join(f.root, '甲', '小说资料', '世界书删除备份');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.remove(f.project.id, '甲书', selected.hash), /链接|目录|越界/u);
  assert.equal((await f.store.list(f.project.id))[0].name, '甲书');
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(link);
});

test('世界书拒绝目录链接与小说归属变更，不能读取或写入另一部小说', async t => {
  const f = await fixture(t);
  const otherFolder = path.join(f.root, '乙'); await fs.mkdir(otherFolder);
  const other = await f.workspace.attach(otherFolder);
  await f.store.import(other.id, '乙书', world({ '0': { key: ['星港'], content: '乙书私有内容' } }));
  const target = path.join(otherFolder, '小说资料', '世界书');
  const link = path.join(f.root, '甲', '小说资料', '世界书');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.list(f.project.id), /链接|目录|越界/u);
  await assert.rejects(f.store.import(f.project.id, '跨书', world({ '0': { key: ['星港'], content: '跨书' } })), /链接|目录|越界/u);
  assert.deepEqual((await f.store.list(other.id)).map(item => item.name), ['乙书']);
  await fs.unlink(link);
  const record = path.join(f.root, '甲', '小说资料', 'project.json');
  await fs.writeFile(record, JSON.stringify({ schemaVersion: 1, id: other.id, name: '虚构更改' }));
  await assert.rejects(f.store.list(f.project.id), /归属|小说/u);
  assert.deepEqual((await f.store.list(other.id)).map(item => item.name), ['乙书']);
});

test('世界书文件链接不得读取或移除目标', async t => {
  const f = await fixture(t);
  await f.store.list(f.project.id);
  const outside = path.join(f.root, '不可覆盖.json');
  const bytes = JSON.stringify(world({ '0': { key: ['星港'], content: '外部虚构资料' } }));
  await fs.writeFile(outside, bytes);
  const link = path.join(f.root, '甲', '小说资料', '世界书', '链接.json');
  try { await fs.symlink(outside, link, 'file'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('系统不允许创建文件符号链接'); return; } throw error; }
  await assert.rejects(f.store.read(f.project.id, '链接'), /链接|文件|越界/u);
  await assert.rejects(f.store.remove(f.project.id, '链接', '0'.repeat(64)), /链接|文件|越界/u);
  assert.equal(await fs.readFile(outside, 'utf8'), bytes);
});

test('世界书上下文：只注入命中条目，超长按上限截断', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '甲书', world({
    '0': { key: ['北门'], content: '北门在雨夜关闭。', order: 9 },
    '1': { key: ['不会出现'], content: '不该注入的内容。', order: 1 }
  }));
  const context = await f.store.context(f.project.id, '林夏走到北门。');
  assert.equal(context.entries, 1);
  assert.match(context.text, /世界书触发条目/u);
  assert.match(context.text, /北门在雨夜关闭/u);
  assert.doesNotMatch(context.text, /不该注入的内容/u);
  assert.deepEqual(context.books, ['甲书']);
  assert.deepEqual(await f.store.context(f.project.id, '无关的一句话。'), { text: '', entries: 0, books: [] }, '没有命中时不注入任何内容');
  const long = await f.store.import(f.project.id, '长书', world({ '0': { key: ['北门'], content: '很长的设定。'.repeat(400) } }));
  assert.equal(long.entries, 1);
  const limited = await f.store.context(f.project.id, '北门', undefined, { books: ['长书'], maxCharacters: 500 });
  assert.ok(limited.text.length <= 560, `应受上限约束，实际 ${limited.text.length}`);
});

test('未知酒馆标签映射时 AI 不注入标签受限条目，预览可手动指定标签 ID', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '标签测试', world({
    '0': { key: ['星港'], content: '普通设定', order: 10 },
    '1': { key: ['星港'], content: '标签限定设定', order: 9, characterFilter: { isExclude: false, names: [], tags: ['tag-alpha'] } },
    '2': { key: ['星港'], content: '排除标签设定', order: 8, characterFilter: { isExclude: true, names: [], tags: ['tag-beta'] } }
  }));
  const ai = await f.store.context(f.project.id, '星港', ['林夏']);
  assert.match(ai.text, /普通设定/u);
  assert.doesNotMatch(ai.text, /标签限定设定|排除标签设定/u);
  const hits = await f.store.preview(f.project.id, ['标签测试'], '星港', ['林夏'], ['tag-alpha']);
  assert.deepEqual(hits.map(hit => hit.content), ['普通设定', '标签限定设定', '排除标签设定']);
  const empty = await f.store.preview(f.project.id, ['标签测试'], '星港', ['林夏'], []);
  assert.deepEqual(empty.map(hit => hit.content), ['普通设定', '排除标签设定']);
});
test('角色卡内嵌世界书：与独立世界书一样参与触发', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '甲书', world({ '0': { key: ['北门'], content: '独立世界书条目。', order: 3 } }));
  const cardBook = parseCardBook({ name: '卡内书', entries: [{ id: 0, keys: ['月钥'], content: '卡内世界书条目。', insertion_order: 4, enabled: true }] });
  assert.equal(cardBook.entries.length, 1);
  const context = await f.store.context(f.project.id, '林夏在北门举起月钥。', undefined, { extraWorlds: [cardBook] });
  assert.equal(context.entries, 2);
  assert.match(context.text, /独立世界书条目/u);
  assert.match(context.text, /卡内世界书条目/u);
});

test('角色卡内嵌世界书：没有独立世界书时仍能触发，且不跨小说读取', async t => {
  const f = await fixture(t);
  const secondFolder = path.join(f.root, '乙'); await fs.mkdir(secondFolder);
  const second = await f.workspace.attach(secondFolder);
  const embedded = (content: string) => parseCardBook({ name: '同名卡内书', entries: [{
    id: 0, keys: ['月钥'], content, enabled: true, selective: true, secondary_keys: ['林夏', '北门'],
    extensions: { selectiveLogic: 3 }
  }] });
  assert.deepEqual(await f.store.list(f.project.id), []);
  const first = await f.store.context(f.project.id, '林夏在北门举起月钥。', undefined, { extraWorlds: [embedded('甲书独有设定')] });
  assert.equal(first.entries, 1); assert.match(first.text, /甲书独有设定/u);
  assert.deepEqual(first.books, ['同名卡内书']);
  assert.deepEqual(await f.store.context(f.project.id, '林夏举起月钥。', undefined, { extraWorlds: [embedded('甲书独有设定')] }),
    { text: '', entries: 0, books: [] }, '缺少第二个次词时不能误注入');
  assert.deepEqual(await f.store.context(second.id, '林夏在北门举起月钥。'), { text: '', entries: 0, books: [] });
  const other = await f.store.context(second.id, '林夏在北门举起月钥。', undefined, { extraWorlds: [embedded('乙书独有设定')] });
  assert.match(other.text, /乙书独有设定/u); assert.doesNotMatch(other.text, /甲书独有设定/u);
  await f.store.import(f.project.id, '只在甲书', world({ '0': { key: ['月钥'], content: '甲书独立世界书' } }));
  assert.deepEqual(await f.store.context(second.id, '月钥'), { text: '', entries: 0, books: [] });
});


test('空章节注入常驻设定，超长命中不阻挡后续完整短条目', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, '预算测试', world({
    '0': { key: [], constant: true, content: '巨'.repeat(600), order: 100 },
    '1': { key: [], constant: true, content: '常驻短设定', order: 10 },
    '2': { key: ['星港'], content: '非空触发', order: 1 }
  }));
  const result = await f.store.context(f.project.id, '', undefined, { books: ['预算测试'], maxCharacters: 500 });
  assert.equal(result.entries, 1); assert.match(result.text, /常驻短设定/u); assert.match(result.text, /1 条已命中设定/u);
  assert.doesNotMatch(result.text, /非空触发|巨巨巨/u); assert.ok(result.text.length <= 500);
});
