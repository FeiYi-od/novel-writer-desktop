export interface PngChunk { type: string; data: Uint8Array }
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((value, index) => bytes[index] === value);
}
export function readChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error('不是 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const start = offset + 8;
    if (start + length + 4 > bytes.length) throw new Error('PNG 数据被截断');
    chunks.push({ type, data: bytes.slice(start, start + length) });
    offset = start + length + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}
export function writeChunks(chunks: PngChunk[]): Uint8Array {
  const total = 8 + chunks.reduce((sum, chunk) => sum + 12 + chunk.data.length, 0);
  const out = new Uint8Array(total);
  out.set(SIGNATURE, 0);
  const view = new DataView(out.buffer);
  let offset = 8;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.length);
    const typeBytes = Uint8Array.from([...chunk.type].map(character => character.charCodeAt(0)));
    out.set(typeBytes, offset + 4);
    out.set(chunk.data, offset + 8);
    const crcInput = new Uint8Array(4 + chunk.data.length);
    crcInput.set(typeBytes, 0); crcInput.set(chunk.data, 4);
    view.setUint32(offset + 8 + chunk.data.length, crc32(crcInput));
    offset += 12 + chunk.data.length;
  }
  return out;
}
/** tEXt payload is `keyword\0text` with latin-1 bytes; character cards store base64 there. */
export function decodeTextChunk(data: Uint8Array): { keyword: string; text: string } | null {
  const zero = data.indexOf(0);
  if (zero <= 0) return null;
  const keyword = String.fromCharCode(...data.slice(0, zero));
  const text = new TextDecoder('latin1').decode(data.slice(zero + 1));
  return { keyword, text };
}
export function encodeTextChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = [...keyword].map(character => character.charCodeAt(0));
  if (!keywordBytes.length || keywordBytes.length > 79) throw new Error('PNG 文本块关键字长度需在 1–79 之间');
  const textBytes = new TextEncoder().encode(text);
  const out = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  out.set(keywordBytes, 0); out[keywordBytes.length] = 0; out.set(textBytes, keywordBytes.length + 1);
  return out;
}
/** Reads every tEXt chunk, keyed by lowercase keyword (SillyTavern compares keywords case-insensitively). */
export function readPngText(bytes: Uint8Array): Map<string, string> {
  const map = new Map<string, string>();
  for (const chunk of readChunks(bytes)) {
    if (chunk.type !== 'tEXt') continue;
    const decoded = decodeTextChunk(chunk.data);
    if (decoded) map.set(decoded.keyword.toLowerCase(), decoded.text);
  }
  return map;
}
/** Replaces `chara`/`ccv3` blocks and inserts them before IEND, exactly like SillyTavern's writer. */
export function writePngText(bytes: Uint8Array, entries: { keyword: string; text: string }[]): Uint8Array {
  const kept = readChunks(bytes).filter(chunk => {
    if (chunk.type !== 'tEXt') return true;
    const decoded = decodeTextChunk(chunk.data);
    if (!decoded) return true;
    const keyword = decoded.keyword.toLowerCase();
    return keyword !== 'chara' && keyword !== 'ccv3';
  });
  const insertAt = kept.findIndex(chunk => chunk.type === 'IEND');
  const added = entries.map(entry => ({ type: 'tEXt', data: encodeTextChunk(entry.keyword, entry.text) }));
  kept.splice(insertAt < 0 ? kept.length : insertAt, 0, ...added);
  return writeChunks(kept);
}
const toBase64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const fromBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};
/** Writes the V2 card into `chara` and the V3 card into `ccv3`, both base64 like SillyTavern does. */
export function embedCard(png: Uint8Array, cardV2: Record<string, unknown>, cardV3: Record<string, unknown>): Uint8Array {
  return writePngText(png, [
    { keyword: 'chara', text: toBase64(JSON.stringify(cardV2)) },
    { keyword: 'ccv3', text: toBase64(JSON.stringify(cardV3)) }
  ]);
}
/** Reads a card back: `ccv3` wins over `chara`, matching SillyTavern's reader. */
export function readCardJson(png: Uint8Array): unknown {
  const text = readPngText(png);
  const payload = text.get('ccv3') ?? text.get('chara');
  if (!payload) throw new Error('这张 PNG 里没有角色卡数据（缺 chara/ccv3 文本块）');
  return JSON.parse(fromBase64(payload));
}
