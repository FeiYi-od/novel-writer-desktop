import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { validateReplacementImage } from '../src/main/image-limits';

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function crc(bytes: Uint8Array) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++) result = result & 1 ? (result >>> 1) ^ 0xedb88320 : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}
function chunk(type: string, content: Uint8Array = new Uint8Array()) {
  const head = Buffer.alloc(8), checksum = Buffer.alloc(4); head.writeUInt32BE(content.length); head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), content]); checksum.writeUInt32BE(crc(body));
  return Buffer.concat([head, content, checksum]);
}
function ihdr(width = 1, height = 1, bitDepth = 8, color = 6, compression = 0, filter = 0, interlace = 0) {
  const content = Buffer.alloc(13); content.writeUInt32BE(width); content.writeUInt32BE(height, 4); content.set([bitDepth, color, compression, filter, interlace], 8);
  return chunk('IHDR', content);
}
const pixels = chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), end = chunk('IEND');
function png(width = 1, height = 1, bitDepth = 8, color = 6) { return Buffer.concat([signature, ihdr(width, height, bitDepth, color), ...(color === 3 ? [chunk('PLTE', Buffer.from([255, 0, 0]))] : []), pixels, end]); }
function segment(marker: number, content: Uint8Array = new Uint8Array()) { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(content.length + 2, 2); return Buffer.concat([head, content]); }
function sof(width = 1, height = 1, marker = 0xc0, count = 3, precision = 8) {
  const content = Buffer.alloc(6 + count * 3); content[0] = precision; content.writeUInt16BE(height, 1); content.writeUInt16BE(width, 3); content[5] = count;
  for (let index = 0; index < count; index++) content.set([index + 1, 0x11, 0], 6 + index * 3);
  return segment(marker, content);
}
function sos(count = 3, progressive = false) {
  const content = Buffer.alloc(4 + 2 * count); content[0] = count;
  for (let index = 0; index < count; index++) content.set([index + 1, 0], 1 + index * 2);
  content.set([0, progressive ? 0 : 63, 0], content.length - 3); return segment(0xda, content);
}
const soi = Buffer.from([0xff, 0xd8]), eoi = Buffer.from([0xff, 0xd9]), entropy = Buffer.from([12, 0xff, 0, 34, 0xff, 0xd0, 56]);
/** These JPEG fixtures exercise marker structure only, not a decoded pixel stream. */
function jpeg(width = 1, height = 1, marker = 0xc0, count = 3) { return Buffer.concat([soi, segment(0xe0, Buffer.from('JFIF\0')), sof(width, height, marker, count), sos(count, marker === 0xc2), entropy, eoi]); }

test('替换图预检：普通PNG/灰度/索引色与8/16位及常见JPEG SOF头获得真实尺寸', () => {
  for (const [depth, color] of [[8, 6], [16, 6], [1, 0], [2, 0], [4, 0], [8, 0], [16, 0], [8, 2], [16, 2], [1, 3], [2, 3], [4, 3], [8, 3], [8, 4], [16, 4]]) {
    assert.deepEqual(validateReplacementImage(png(123, 456, depth, color)), { format: 'png', width: 123, height: 456 });
  }
  for (const marker of [0xc0, 0xc1, 0xc2]) for (const count of [1, 3, 4]) assert.deepEqual(validateReplacementImage(jpeg(321, 654, marker, count)), { format: 'jpeg', width: 321, height: 654 });
  const padded = Buffer.concat([Buffer.from([1, 2, 3]), png(), Buffer.from([4, 5])]);
  assert.deepEqual(validateReplacementImage(padded.subarray(3, padded.length - 2)), { format: 'png', width: 1, height: 1 });
});

test('替换图预检：文件、单边和总像素的精确边界有界拒绝', () => {
  for (const make of [png, jpeg]) {
    assert.deepEqual(validateReplacementImage(make(16384, 1)), { format: make === png ? 'png' : 'jpeg', width: 16384, height: 1 });
    assert.deepEqual(validateReplacementImage(make(8000, 4000)), { format: make === png ? 'png' : 'jpeg', width: 8000, height: 4000 });
    assert.throws(() => validateReplacementImage(make(16385, 1)), /16384/u); assert.throws(() => validateReplacementImage(make(1, 16385)), /16384/u);
    assert.throws(() => validateReplacementImage(make(8001, 4000)), /3200 万/u); assert.throws(() => validateReplacementImage(make(0, 1)), /尺寸无效/u);
    assert.throws(() => validateReplacementImage(make(1, 0)), /尺寸无效/u);
  }
  assert.throws(() => validateReplacementImage(png(0xffffffff, 1)), /16384/u);
  assert.throws(() => validateReplacementImage(new Uint8Array(20 * 1024 * 1024 + 1)), /20 MiB/u);
  const target = 20 * 1024 * 1024, padding = target - (signature.length + ihdr().length + pixels.length + end.length + 12);
  assert.deepEqual(validateReplacementImage(Buffer.concat([signature, ihdr(), chunk('npAD', Buffer.alloc(padding)), pixels, end])), { format: 'png', width: 1, height: 1 });
});

test('替换图预检：真实签名必须为PNG或JPEG，不根据文件名/伪前缀接受其他格式', () => {
  for (const bytes of [new Uint8Array(), Buffer.from('GIF89a'), Buffer.from('RIFFxxxxWEBP'), Buffer.from('<svg/>'), Buffer.from('not an image.png'), signature.subarray(0, 7), Buffer.from([0xff, 0xd8]), null as never, {} as never]) {
    assert.throws(() => validateReplacementImage(bytes), /格式|签名|无效|为空/u);
  }
});

test('替换图预检：PNG首IHDR长度、位深/颜色和编码规则完整检查', () => {
  const invalidHeaders = [chunk('IHDR', new Uint8Array(12)), ihdr(1, 1, 4, 2), ihdr(1, 1, 16, 3), ihdr(1, 1, 8, 1), ihdr(1, 1, 8, 5), ihdr(1, 1, 8, 6, 1), ihdr(1, 1, 8, 6, 0, 1), ihdr(1, 1, 8, 6, 0, 0, 2)];
  for (const header of invalidHeaders) assert.throws(() => validateReplacementImage(Buffer.concat([signature, header, pixels, end])), /IHDR|尺寸区块|位深|颜色|编码/u);
  assert.throws(() => validateReplacementImage(Buffer.concat([signature, pixels, ihdr(), end])), /首区块/u);
  const corrupted = Buffer.from(png()); corrupted[29] ^= 1; assert.throws(() => validateReplacementImage(corrupted), /校验/u);
});

test('替换图预检：PNG截断、重复尺寸、多帧、未知关键区块和额外尾部拒绝', () => {
  const source = png();
  for (const length of [8, 9, 20, 32, source.length - 1]) assert.throws(() => validateReplacementImage(source.subarray(0, length)), /PNG|截断/u);
  const variants = [
    Buffer.concat([signature, ihdr(), ihdr(), pixels, end]), Buffer.concat([signature, ihdr(), chunk('acTL', Buffer.alloc(8)), pixels, end]),
    Buffer.concat([signature, ihdr(), chunk('fcTL'), pixels, end]), Buffer.concat([signature, ihdr(), chunk('fdAT'), pixels, end]),
    Buffer.concat([signature, ihdr(), chunk('ABCD'), pixels, end]), Buffer.concat([source, Buffer.from([0])]),
    Buffer.concat([signature, ihdr(), end]), Buffer.concat([signature, ihdr(), pixels, chunk('IEND', Buffer.from([0]))]),
    Buffer.concat([signature, ihdr(), pixels, chunk('tEXt'), pixels, end]), Buffer.concat([signature, ihdr(), chunk('abca'), pixels, end])
  ];
  for (const bytes of variants) assert.throws(() => validateReplacementImage(bytes), /PNG|APNG|多帧/u);
  const forged = Buffer.from(source); forged.writeUInt32BE(0xffffffff, 33); assert.throws(() => validateReplacementImage(forged), /长度越界/u);
});

test('替换图预检：PNG调色板的必要性、大小、顺序及重复检查', () => {
  for (const bytes of [
    Buffer.concat([signature, ihdr(1, 1, 1, 3), pixels, end]),
    Buffer.concat([signature, ihdr(1, 1, 1, 3), chunk('PLTE', Buffer.alloc(9)), pixels, end]),
    Buffer.concat([signature, ihdr(), chunk('PLTE', Buffer.alloc(4)), pixels, end]),
    Buffer.concat([signature, ihdr(1, 1, 8, 0), chunk('PLTE', Buffer.alloc(3)), pixels, end]),
    Buffer.concat([signature, ihdr(), chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3)), pixels, end]),
    Buffer.concat([signature, ihdr(), pixels, chunk('PLTE', Buffer.alloc(3)), end])
  ]) assert.throws(() => validateReplacementImage(bytes), /调色板/u);
});

test('替换图预检：JPEG段长、SOF精度/分量/采样及重复尺寸拒绝', () => {
  const malformed = sof(); malformed.writeUInt16BE(7, 2);
  const sampling = sof(); sampling[11] = 0;
  const repeatedComponent = sof(); repeatedComponent[13] = 1;
  const variants = [sof(1, 1, 0xc0, 3, 12), sof(1, 1, 0xc0, 2), sof(1, 1, 0xc3), malformed, sampling, repeatedComponent];
  for (const frame of variants) assert.throws(() => validateReplacementImage(Buffer.concat([soi, frame, sos(), entropy, eoi])), /JPEG/u);
  assert.throws(() => validateReplacementImage(Buffer.concat([soi, sof(), sof(), sos(), entropy, eoi])), /重复|多帧/u);
  assert.throws(() => validateReplacementImage(Buffer.concat([soi, segment(0xe0, Buffer.alloc(1)).subarray(0, 4)])), /长度越界|截断/u);
  assert.throws(() => validateReplacementImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])), /段长度/u);
});

test('替换图预检：JPEG扫描标记有界，填充与重启标记支持，截断/多帧/MPO/DNL拒绝', () => {
  assert.deepEqual(validateReplacementImage(Buffer.concat([soi, Buffer.from([0xff]), sof(), sos(), entropy, eoi])), { format: 'jpeg', width: 1, height: 1 });
  const progressive = Buffer.concat([soi, sof(7, 8, 0xc2, 1), sos(1, true), entropy, segment(0xc4), sos(1, true), entropy, eoi]);
  assert.deepEqual(validateReplacementImage(progressive), { format: 'jpeg', width: 7, height: 8 });
  for (const bytes of [
    Buffer.concat([soi, sos(), entropy, eoi]), Buffer.concat([soi, sof(), sos(), entropy]), Buffer.concat([soi, sof(), sos(), entropy, Buffer.from([0xff])]),
    Buffer.concat([soi, sof(), sos(), entropy, soi, eoi]), Buffer.concat([jpeg(), jpeg()]),
    Buffer.concat([soi, segment(0xe2, Buffer.from('MPF\0')), sof(), sos(), entropy, eoi]),
    Buffer.concat([soi, sof(), sos(), entropy, segment(0xdc, Buffer.from([0, 1])), eoi]),
    Buffer.concat([soi, sof(), sos(), entropy, sof(), eoi]), Buffer.concat([soi, sof(), sos(), entropy, segment(0xde), eoi]),
    Buffer.concat([soi, sof(), Buffer.from([0xff, 0, 0]), sos(), entropy, eoi])
  ]) assert.throws(() => validateReplacementImage(bytes), /JPEG|MPO|多帧/u);
});

test('替换图预检：PNG区块/JPEG标记与扫描数量有界，避免海量微小段扫描', () => {
  const empty = chunk('IDAT');
  assert.deepEqual(validateReplacementImage(Buffer.concat([signature, ihdr(), pixels, ...Array.from({ length: 4093 }, () => empty), end])), { format: 'png', width: 1, height: 1 });
  assert.throws(() => validateReplacementImage(Buffer.concat([signature, ihdr(), pixels, ...Array.from({ length: 4094 }, () => empty), end])), /4096/u);
  assert.throws(() => validateReplacementImage(Buffer.concat([soi, ...Array.from({ length: 4096 }, () => segment(0xe0)), sof(), sos(), entropy, eoi])), /4096/u);
  assert.throws(() => validateReplacementImage(Buffer.concat([soi, sof(1, 1, 0xc2, 1), ...Array.from({ length: 1025 }, () => Buffer.concat([sos(1, true), entropy])), eoi])), /扫描.*超限/u);
});
