import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildCardV2 } from '../src/core/st-cards';
import { charxZipStart, isCharx, readCharx } from '../src/core/charx';

const fields = {
  name: '林夏', description: '雨夜的旅人', personality: '', scenario: '', firstMessage: '', exampleDialogue: '',
  creatorNotes: '', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], tags: [], creator: '', characterVersion: '1.0', extensions: {}
};
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function buildCharx(card: Record<string, unknown>, files: Record<string, Uint8Array | string> = {}) {
  const zip = new JSZip();
  zip.file('card.json', JSON.stringify(card));
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

test('CHARX：读取 card.json、识别图标与资源列表', async () => {
  const card = buildCardV2(fields);
  const bytes = await buildCharx({ ...card, data: { ...(card as { data: object }).data, assets: [
    { type: 'icon', name: 'main', uri: 'embeded://assets/icon/main.png', ext: 'png' },
    { type: 'emotion', name: 'smile', uri: 'embeded://assets/emotion/smile.png' },
    { type: 'background', name: 'rain', uri: 'embedded://assets/bg/rain.png' },
    { type: 'emotion', name: 'ignored', uri: 'https://example.com/x.png' }
  ] } }, { 'assets/icon/main.png': png, 'assets/emotion/smile.png': png, 'assets/bg/rain.png': png });
  assert.equal(isCharx(bytes), true);
  const result = await readCharx(bytes);
  assert.equal(result.card.specVersion, 2);
  assert.equal(result.card.data.name, '林夏');
  assert.equal(result.assets.length, 3, '只统计包内资源，外部 URL 忽略');
  assert.equal(result.assets.find(asset => asset.type === 'emotion')?.ext, 'png', '缺少 ext 时从路径推断');
  assert.deepEqual(result.icon, png, '图标应取 main');
});

test('CHARX：缺少 card.json、spec 或不是 ZIP 时报错', async () => {
  const empty = new JSZip(); empty.file('README.txt', 'no card here');
  const noCard = new Uint8Array(await empty.generateAsync({ type: 'uint8array' }));
  await assert.rejects(readCharx(noCard), /没有 card\.json/u);
  await assert.rejects(readCharx(new Uint8Array([1, 2, 3])), /不是 CHARX/u);
  const badSpec = await buildCharx({ spec: 'chara_card_v2', spec_version: '2.0' });
  await assert.rejects(readCharx(badSpec), /缺少 data/u);
});

test('CHARX：允许 ZIP 前带自解压前缀', async () => {
  const bytes = await buildCharx(buildCardV2(fields));
  const prefixed = new Uint8Array(bytes.length + 16);
  prefixed.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  prefixed.set(bytes, 16);
  assert.equal(charxZipStart(prefixed), 16);
  assert.equal((await readCharx(prefixed)).card.data.name, '林夏');
});
