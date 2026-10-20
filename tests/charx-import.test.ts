import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { CharacterStore } from '../src/main/characters';
import { buildCardV2 } from '../src/core/st-cards';

const fields = {
  name: '林夏', description: '雨夜的旅人', personality: '寡言', scenario: '北门客栈', firstMessage: '你来了。', exampleDialogue: '',
  creatorNotes: '', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: ['雨很大。'], tags: ['奇幻'], creator: '作者', characterVersion: '1.0', extensions: {}
};
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
async function charxBytes() {
  const card = buildCardV2(fields, { name: '卡内书', extensions: {}, entries: [{
    id: '0', keys: ['北门'], secondaryKeys: [], content: '北门在雨夜关闭。', comment: '', selective: false, selectiveLogic: 'AND_ANY',
    constant: false, disabled: false, order: 5, position: 'after_char', depth: null, probability: 100, caseSensitive: false
  }] });
  const zip = new JSZip();
  zip.file('card.json', JSON.stringify({ ...card, data: { ...(card as { data: object }).data, assets: [{ type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' }, { type: 'emotion', name: 'smile', uri: 'embeded://assets/emotion/smile.png' }] } }));
  zip.file('assets/icon/main.png', png);
  zip.file('assets/emotion/smile.png', png);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-charx-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials'));
  await workspace.initialize();
  const book = path.join(root, '甲'); await fs.mkdir(book);
  const project = await workspace.attach(book);
  const store = new CharacterStore(id => workspace.getProject(id), path.join(root, 'materials'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, store };
}

test('CHARX 导入：字段来自 card.json，图标作为头像，资源数写在提示里', async t => {
  const f = await fixture(t);
  const preview = await f.store.prepareCharx(f.project.id, '林夏.charx', await charxBytes(), null);
  assert.equal(preview.format, 'CHARX');
  assert.equal(preview.fields.name, '林夏');
  assert.equal(preview.fields.description, '雨夜的旅人');
  assert.deepEqual(preview.fields.alternateGreetings, ['雨很大。']);
  assert.equal(preview.loreEntries, 1, '内嵌世界书条目数应被识别');
  assert.match(preview.warnings.join(''), /另有 2 个资源/u, '图标与表情都算包内资源，只提示不导入');
  assert.match(preview.image, /^data:image\/png;base64,/u, '图标应作为头像预览');
  const saved = await f.store.save(f.project.id, { fields: preview.fields, enabled: true, importToken: preview.token }, (await f.store.read(f.project.id)).hash);
  const card = saved.value.cards[0];
  assert.equal(card.source.format, 'CHARX');
  assert.equal(card.portrait !== '', true, '保存后应带头像');
  assert.ok(card.raw && (card.raw as { data?: unknown }).data, '原始 card.json 应保留');
});

test('CHARX 导入：非 CHARX 内容被拒绝', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.prepareCharx(f.project.id, 'x.charx', Buffer.from('not a zip'), null), /不是 CHARX/u);
});
