/** Container/dimension preflight only. Pixel decoding must still be checked by
 * nativeImage afterwards; valid headers do not prove a valid pixel stream. */
export interface ReplacementImageInfo { format: 'png' | 'jpeg'; width: number; height: number }

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 16384;
const MAX_PIXELS = 32_000_000;
const MAX_PARTS = 4096;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bad = (detail: string): never => { throw new Error(`替换图片${detail}；请选择普通 PNG/JPEG 图片，原稿已保留`); };

function dimensions(format: ReplacementImageInfo['format'], width: number, height: number): ReplacementImageInfo {
  if (!width || !height) return bad('尺寸无效');
  if (width > MAX_SIDE || height > MAX_SIDE) return bad('单边超过 16384 像素');
  if (width * height > MAX_PIXELS) return bad('总像素超过 3200 万');
  return { format, width, height };
}
function uint16(bytes: Uint8Array, offset: number) { return bytes[offset] * 256 + bytes[offset + 1]; }
function uint32(bytes: Uint8Array, offset: number) { return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]; }

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array, start: number, end: number) {
  let value = 0xffffffff;
  for (let offset = start; offset < end; offset++) value = crcTable[(value ^ bytes[offset]) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function png(bytes: Uint8Array): ReplacementImageInfo {
  let offset = 8, parts = 0, info: ReplacementImageInfo | undefined, color = -1, bitDepth = 0;
  let palette = false, data = false, dataEnded = false;
  while (offset < bytes.length) {
    if (++parts > MAX_PARTS) return bad('PNG 区块超过 4096 个');
    if (bytes.length - offset < 12) return bad('PNG 区块被截断');
    const length = uint32(bytes, offset), end = offset + 12 + length;
    if (end > bytes.length) return bad('PNG 区块长度越界或被截断');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if ([...typeBytes].some(value => value < 65 || value > 90 && value < 97 || value > 122) || typeBytes[2] & 32) return bad('PNG 区块名称无效');
    const type = String.fromCharCode(...typeBytes), content = offset + 8;
    if (crc32(bytes, offset + 4, content + length) !== uint32(bytes, content + length)) return bad('PNG 区块校验失败');
    if (!info && type !== 'IHDR') return bad('PNG 首区块不是 IHDR');
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) return bad('是多帧 APNG，暂不支持');
    if (type === 'IHDR') {
      if (info || parts !== 1 || length !== 13) return bad('PNG 尺寸区块重复或长度无效');
      info = dimensions('png', uint32(bytes, content), uint32(bytes, content + 4));
      bitDepth = bytes[content + 8]; color = bytes[content + 9];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(bitDepth) || bytes[content + 10] !== 0 || bytes[content + 11] !== 0 || bytes[content + 12] > 1) return bad('PNG 位深、颜色或编码方式不受支持');
    } else if (type === 'PLTE') {
      if (palette || data || color === 0 || color === 4 || !length || length % 3 || length > 768 || color === 3 && length / 3 > 2 ** bitDepth) return bad('PNG 调色板无效或重复');
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || color === 3 && !palette) return bad('PNG 像素区块顺序或调色板无效');
      data = true;
    } else if (type === 'IEND') {
      if (length || !data || end !== bytes.length) return bad('PNG 结束区块无效、缺少像素区块或包含额外帧');
      return info!;
    } else {
      if (!(typeBytes[0] & 32)) return bad('包含未知 PNG 关键区块');
      if (data) dataEnded = true;
    }
    offset = end;
  }
  return bad('PNG 缺少结束区块或被截断');
}

function jpeg(bytes: Uint8Array): ReplacementImageInfo {
  let offset = 2, parts = 0, scans = 0, entropy = false, info: ReplacementImageInfo | undefined;
  let frameMarker = 0; const components = new Set<number>();
  while (offset < bytes.length) {
    if (entropy) {
      // Skip stuffed 0xff bytes and restart markers without decoding pixels.
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        const markerStart = offset - 1;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset === bytes.length) return bad('JPEG 熵编码末尾被截断');
        const marker = bytes[offset];
        if (marker === 0 || marker >= 0xd0 && marker <= 0xd7) { offset++; continue; }
        offset = markerStart; entropy = false; break;
      }
      if (entropy) return bad('JPEG 缺少结束标记或被截断');
    }
    if (++parts > MAX_PARTS) return bad('JPEG 标记超过 4096 个');
    if (bytes[offset++] !== 0xff) return bad('JPEG 标记结构损坏');
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return bad('JPEG 标记被截断');
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!info || !scans || offset !== bytes.length) return bad('JPEG 结束标记无效或包含额外帧');
      return info;
    }
    if (marker === 0xd8) return bad('包含重复 JPEG 图像或多帧结构');
    if (marker === 0 || marker === 1 || marker >= 0xd0 && marker <= 0xd7) return bad('JPEG 出现位置错误的独立标记');
    if (bytes.length - offset < 2) return bad('JPEG 段长度被截断');
    const length = uint16(bytes, offset), end = offset + length, content = offset + 2;
    if (length < 2 || end > bytes.length) return bad('JPEG 段长度越界或被截断');
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (sof) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) return bad('JPEG 帧编码方式不受支持');
      if (info || scans) return bad('JPEG 尺寸区块重复或包含多帧结构');
      if (length < 8) return bad('JPEG 尺寸区块被截断');
      const count = bytes[content + 5];
      if (bytes[content] !== 8 || ![1, 3, 4].includes(count) || length !== 8 + 3 * count) return bad('JPEG 位深、分量数或尺寸区块长度无效');
      info = dimensions('jpeg', uint16(bytes, content + 3), uint16(bytes, content + 1)); frameMarker = marker;
      let samples = 0;
      for (let index = 0; index < count; index++) {
        const start = content + 6 + index * 3, id = bytes[start], horizontal = bytes[start + 1] >>> 4, vertical = bytes[start + 1] & 15;
        if (components.has(id) || !horizontal || horizontal > 4 || !vertical || vertical > 4 || bytes[start + 2] > 3) return bad('JPEG 分量或采样结构无效');
        components.add(id); samples += horizontal * vertical;
      }
      if (samples > 10) return bad('JPEG 采样结构超限');
    } else if (marker === 0xda) {
      if (!info || ++scans > 1024 || length < 6) return bad('JPEG 扫描区块缺失尺寸或结构超限');
      const count = bytes[content];
      if (!count || count > components.size || length !== 6 + 2 * count) return bad('JPEG 扫描区块长度或分量数无效');
      const selected = new Set<number>();
      for (let index = 0; index < count; index++) {
        const id = bytes[content + 1 + index * 2], tables = bytes[content + 2 + index * 2];
        if (!components.has(id) || selected.has(id) || tables >>> 4 > 3 || (tables & 15) > 3) return bad('JPEG 扫描分量无效');
        selected.add(id);
      }
      const spectralStart = bytes[end - 3], spectralEnd = bytes[end - 2], approximation = bytes[end - 1];
      if (spectralStart > spectralEnd || spectralEnd > 63 || approximation >>> 4 > 13 || (approximation & 15) > 13
        || frameMarker !== 0xc2 && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0)
        || frameMarker === 0xc2 && (spectralStart === 0 ? spectralEnd !== 0 : count !== 1)) return bad('JPEG 扫描编码方式无效');
      entropy = true;
    } else if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xe2 && length >= 6 && bytes[content] === 0x4d && bytes[content + 1] === 0x50 && bytes[content + 2] === 0x46 && bytes[content + 3] === 0) return bad('是多图 MPO，暂不支持');
    } else if (![0xc4, 0xdb, 0xdd, 0xfe].includes(marker)) return bad('JPEG 标记或分层编码方式不受支持');
    else if (marker === 0xdd && length !== 4) return bad('JPEG 重启间隔区块长度无效');
    offset = end;
  }
  return bad('JPEG 缺少结束标记或被截断');
}

export function validateReplacementImage(bytes: Uint8Array): ReplacementImageInfo {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return bad('文件无效或为空');
  if (bytes.byteLength > MAX_BYTES) return bad('文件超过 20 MiB');
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return png(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
  return bad('格式不受支持或真实签名不是 PNG/JPEG');
}
