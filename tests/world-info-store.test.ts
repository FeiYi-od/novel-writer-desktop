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
  await f.store.remove(f.project.id, '甲书');
  assert.deepEqual((await f.store.list(f.project.id)).map(book => book.name), ['损坏']);
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
