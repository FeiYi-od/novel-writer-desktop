import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../src/main/workspace';
import { UiDraftStore } from '../src/main/ui-drafts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-ui-draft-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  await fs.mkdir(path.join(root, '甲')); const a = await workspace.attach(path.join(root, '甲'));
  const store = new UiDraftStore(path.join(root, 'userdata'), workspace);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, store, a };
}

test('未保存草稿：按小说与页面隔离，读回原值并记录时间', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.read(f.a.id, 'planning'), null);
  const saved = await f.store.save(f.a.id, 'planning', { title: '第一卷 雨夜', notes: '月钥只能开启北门' });
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  const again = await f.store.read(f.a.id, 'planning');
  assert.deepEqual(again?.values, { title: '第一卷 雨夜', notes: '月钥只能开启北门' });
  assert.equal(await f.store.read(f.a.id, 'characters'), null, '其他页面不应读到这份草稿');
  const other = await (async () => { await fs.mkdir(path.join(f.root, '乙')); return f.workspace.attach(path.join(f.root, '乙')); })();
  assert.equal(await f.store.read(other.id, 'planning'), null, '其他小说不应读到这份草稿');
});

test('未保存草稿：空白内容不落盘，清空即删除，损坏文件明确报错不静默丢', async t => {
  const f = await fixture(t);
  await f.store.save(f.a.id, 'materials', { body: '   ', keep: '有效文字' });
  assert.deepEqual((await f.store.read(f.a.id, 'materials'))?.values, { keep: '有效文字' });
  await f.store.clear(f.a.id, 'materials');
  assert.equal(await f.store.read(f.a.id, 'materials'), null);
  const file = path.join(f.root, 'userdata', 'ui-drafts', f.a.id, 'style.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{ broken', 'utf8');
  await assert.rejects(f.store.read(f.a.id, 'style'), /损坏|保留/u);
  const huge: Record<string, string> = {};
  for (let index = 0; index < 12; index++) huge[`part${index}`] = 'x'.repeat(200_000);
  await assert.rejects(f.store.save(f.a.id, 'style', huge), /2 MiB/u);
});

test('长 JSON 草稿完整读回，超出总量时拒绝且保留先前版本', async t => {
  const f = await fixture(t);
  const value = JSON.stringify({ text: '虚'.repeat(90_000), image: 'a'.repeat(250_000) });
  await f.store.save(f.a.id, 'characters', { draft: value });
  const actual = await f.store.read(f.a.id, 'characters');
  assert.equal(actual?.values.draft, value);
  assert.deepEqual(JSON.parse(actual!.values.draft), JSON.parse(value));
  const tooLarge = JSON.stringify({ text: '虚'.repeat(800_000) });
  await assert.rejects(f.store.save(f.a.id, 'characters', { draft: tooLarge }), /2 MiB/u);
  assert.equal((await f.store.read(f.a.id, 'characters'))?.values.draft, value);
});

test('无效或过长字段名不被静默截断并覆盖已有草稿', async t => {
  const f = await fixture(t);
  await f.store.save(f.a.id, 'planning', { doc: '原草稿' });
  await assert.rejects(f.store.save(f.a.id, 'planning', { ['x'.repeat(101)]: '新稿' }), /不受支持/u);
  assert.equal((await f.store.read(f.a.id, 'planning'))?.values.doc, '原草稿');
});

test('同页面慢写入不能覆盖后续写入或清空，且失败后队列可继续', async t => {
  const f = await fixture(t);
  const native = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises');
  const original = native.writeFile;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let intercepted = false;
  (native as any).writeFile = async (...args: any[]) => {
    if (!intercepted && String(args[0]).includes('ui-drafts')) { intercepted = true; entered(); await blocked; }
    return (original as any)(...args);
  };
  try {
    const first = f.store.save(f.a.id, 'planning', { doc: '旧稿' });
    await waiting;
    const second = f.store.save(f.a.id, 'planning', { doc: '新稿' });
    const clear = f.store.clear(f.a.id, 'planning');
    release(); await Promise.all([first, second, clear]);
    assert.equal(await f.store.read(f.a.id, 'planning'), null);
    await assert.rejects(f.store.save(f.a.id, 'planning', { ['x'.repeat(101)]: '无效' }));
    await f.store.save(f.a.id, 'planning', { doc: '队列继续' });
    assert.equal((await f.store.read(f.a.id, 'planning'))?.values.doc, '队列继续');
  } finally { (native as any).writeFile = original; release(); }
});
