import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/main/workspace';
import { MacroStore } from '../src/main/macros';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-macros-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store: new MacroStore(workspace) };
}

test('正则脚本：导入 SillyTavern 导出格式并在预览时套用', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.read(f.project.id), []);
  const imported = await f.store.import(f.project.id, [
    { findRegex: '\\((.*?)\\)', replaceString: '（$1）', trimStrings: ['~~'] },
    { findRegex: '嗯', replaceString: '唔', disabled: true }
  ]);
  assert.equal(imported.length, 2);
  const preview = await f.store.preview(f.project.id, '{{char}}说(小声)嗯~~', { characterName: '林夏' });
  assert.equal(preview.expanded, '林夏说(小声)嗯~~', '宏先展开');
  assert.equal(preview.applied, '林夏说（小声）嗯~~', '再套正则，禁用脚本与捕获组外原文保留');
  assert.deepEqual(await f.store.read(f.project.id), imported, '读回应与写入一致');
});

test('正则脚本：非法输入被拒绝，缺 findRegex 指明第几条', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.import(f.project.id, { foo: 1 }), /应为数组/u);
  await assert.rejects(f.store.import(f.project.id, [{ replaceString: 'x' }]), /第 1 条/u);
  await assert.rejects(f.store.import(f.project.id, []), /没有正则脚本/u);
});

test('宏预览：lastMessage 与 user 可用，未知宏保留', async t => {
  const f = await fixture(t);
  const preview = await f.store.preview(f.project.id, '{{user}}看到：{{lastMessage}}｜{{unknown}}', { userName: '作者甲', lastMessage: '你来了。' });
  assert.equal(preview.expanded, '作者甲看到：你来了。｜{{unknown}}');
  assert.equal(preview.applied, preview.expanded, '没有脚本时不改动文本');
});

test('正则导入：保留空/非法显式flags，非法脚本不会退回默认改写', async t => {
  const f = await fixture(t);
  const scripts = await f.store.import(f.project.id, [
    { findRegex: 'cat', replaceString: '错误', flags: 'x' },
    { findRegex: 'cat', replaceString: '猫', flags: '' }
  ]);
  assert.equal(scripts[0]?.flags, 'x');
  assert.equal(scripts[1]?.flags, '');
  assert.equal((await f.store.preview(f.project.id, 'cat cat')).applied, '猫 cat');
});

test('正则预览：替换模板与trimStrings采用同一本书的宏上下文', async t => {
  const f = await fixture(t);
  await f.store.import(f.project.id, [{ findRegex: '/\\((.*?)\\)/g', replaceString: '{{char}}:$1:{{unknown}}', trimStrings: ['{{char}}'] }]);
  const preview = await f.store.preview(f.project.id, '(林岚甲) 林岚', { characterName: '林岚' });
  assert.equal(preview.applied, '林岚:甲:{{unknown}} 林岚');
});

test('正则文件：新格式带schemaVersion，未知版本不会覆盖', async t => {
  const f = await fixture(t), file = path.join(f.project.root, '小说资料', '正则脚本.json');
  await f.store.import(f.project.id, [{ findRegex: 'cat', replaceString: '猫' }]);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).schemaVersion, 1);
  const future = JSON.stringify({ schemaVersion: 99, scripts: [{ findRegex: 'cat', replaceString: '新格式' }] });
  await fs.writeFile(file, future);
  await assert.rejects(f.store.read(f.project.id), /版本/u);
  await assert.rejects(f.store.import(f.project.id, JSON.parse(future)), /版本/u);
  assert.equal(await fs.readFile(file, 'utf8'), future);
});

test('正则预览：等待期间上下文冻结且另一书脚本隔离', async t => {
  const f = await fixture(t), secondRoot = path.join(f.root, '乙');
  await fs.mkdir(secondRoot);
  const workspace = (f.store as unknown as { workspace: Workspace }).workspace;
  const second = await workspace.attach(secondRoot);
  await f.store.import(f.project.id, [{ findRegex: '/甲/g', replaceString: '一' }]);
  await f.store.import(second.id, [{ findRegex: '/甲/g', replaceString: '二' }]);
  const readNotes = workspace.readNotes.bind(workspace);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  workspace.readNotes = async id => { await gate; return readNotes(id); };
  const context = { characterName: '林岚' };
  const firstRequest = f.store.preview(f.project.id, '{{char}}甲', context);
  context.characterName = '另一本角色';
  resume();
  assert.equal((await firstRequest).applied, '林岚一');
  assert.equal((await f.store.preview(second.id, '甲')).applied, '二');
});
