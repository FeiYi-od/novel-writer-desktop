import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { buildCardV2, buildCardV3, parseCard, type CardFields } from '../src/core/st-cards';
import { crc32, embedCard, encodeTextChunk, isPng, readCardJson, readChunks, readPngText, writeChunks, writePngText } from '../src/core/png-text';

const onePixelPng = () => {
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = new Uint8Array(deflateSync(Buffer.from([0x00, 0xff, 0x00, 0x00])));
  return writeChunks([{ type: 'IHDR', data: ihdr }, { type: 'IDAT', data: idat }, { type: 'IEND', data: new Uint8Array() }]);
};
const fields: CardFields = {
  name: '林夏', description: '雨夜的旅人', personality: '寡言', scenario: '北门客栈',
  firstMessage: '你来了。', exampleDialogue: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '',
  alternateGreetings: [], tags: ['奇幻'], creator: '作者', characterVersion: '1.0', extensions: {}
};

test('PNG：CRC32 与块结构可往返，写出的是合法 PNG', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'CRC32 标准校验值');
  const png = onePixelPng();
  assert.equal(isPng(png), true);
  const chunks = readChunks(png);
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(chunks[0].data[3], 1, '宽度应为 1');
});

test('角色卡 PNG：写入 chara/ccv3 后可读回，且 ccv3 优先', () => {
  const png = onePixelPng();
  const embedded = embedCard(png, buildCardV2(fields), buildCardV3(fields));
  const text = readPngText(embedded);
  assert.ok(text.has('chara') && text.has('ccv3'));
  const card = parseCard(readCardJson(embedded));
  assert.equal(card.specVersion, 3, '读取应优先 ccv3');
  assert.equal(card.data.name, '林夏');
  assert.deepEqual(readChunks(embedded).map(chunk => chunk.type), ['IHDR', 'IDAT', 'tEXt', 'tEXt', 'IEND'], '文本块应插在 IEND 之前');
});

test('角色卡 PNG：重复写入只保留一份 chara/ccv3，其他文本块不受影响', () => {
  const png = writePngText(onePixelPng(), [{ keyword: 'Software', text: 'Notepad' }]);
  const once = embedCard(png, buildCardV2(fields), buildCardV3(fields));
  const twice = embedCard(once, buildCardV2({ ...fields, name: '阿岚' }), buildCardV3({ ...fields, name: '阿岚' }));
  const texts = readChunks(twice).filter(chunk => chunk.type === 'tEXt');
  assert.equal(texts.length, 3, '一份 Software + chara + ccv3');
  assert.equal(readPngText(twice).get('software'), 'Notepad', '无关文本块要保留');
  assert.equal(parseCard(readCardJson(twice)).data.name, '阿岚');
  assert.throws(() => readCardJson(onePixelPng()), /没有角色卡数据/u);
});

test('PNG：关键字与损坏数据都被明确拒绝', () => {
  assert.throws(() => encodeTextChunk('', 'x'), /1–79/u);
  assert.throws(() => readChunks(new Uint8Array([1, 2, 3])), /不是 PNG/u);
  const truncated = onePixelPng().slice(0, 20);
  assert.throws(() => readChunks(truncated), /截断|不是 PNG/u);
});
