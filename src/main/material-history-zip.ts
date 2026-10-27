import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { isSafeRelative } from './nas-backup';

const MiB = 1024 * 1024;
const MAX_ARCHIVE = 80 * MiB, MAX_FILE = 32 * MiB, MAX_CONTENT = 64 * MiB, MAX_MANIFEST = 8 * MiB;
const MAX_ENTRIES = 10002;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeSchema = z.string().refine(value => isSafeRelative(value) && value.split('/').length <= 31
  && value.split('/').every(part => !part.startsWith('.')), '历史ZIP资料路径不安全');
const entrySchema = z.object({ path: relativeSchema, bytes: z.number().int().min(0).max(MAX_FILE), sha256: hashSchema }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('material-history-archive'), projectId: z.uuid(),
  source: z.enum(['local', 'transport']), id: z.uuid(), archiveId: z.uuid(), createdAt: z.iso.datetime(), entries: z.array(entrySchema).max(10000) }).strict();
const completionSchema = manifestSchema.extend({ file: z.literal('历史资料.zip'), bytes: z.number().int().min(0).max(MAX_CONTENT),
  archiveBytes: z.number().int().min(22).max(MAX_ARCHIVE), sha256: hashSchema }).strict();

export type MaterialHistoryArchiveManifest = z.infer<typeof manifestSchema>;
export interface MaterialHistoryArchiveContents {
  manifest: MaterialHistoryArchiveManifest;
  data: Map<string, Buffer>;
  sha256: string;
  archiveBytes: number;
  bytes: number;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (name: string) => name.normalize('NFC').toLowerCase();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function utf8(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('历史ZIP包含无效UTF-8文字'); }
}
function json(bytes: Uint8Array) {
  try { return JSON.parse(utf8(bytes)); }
  catch { throw new Error('历史ZIP清单不是有效UTF-8 JSON'); }
}

/** Only the Unicode path extra emitted by our JSZip writer is accepted. It must
 * describe exactly the already-validated UTF-8 name, rather than rename it. */
function checkExtra(bytes: Buffer, rawName: Buffer, name: string) {
  let offset = 0; const seen = new Set<number>();
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('历史ZIP扩展字段损坏');
    const id = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2); offset += 4;
    if (seen.has(id) || offset + length > bytes.length || id !== 0x7075) throw new Error('历史ZIP含重复或不支持的扩展字段');
    seen.add(id); const value = bytes.subarray(offset, offset + length);
    if (value.length < 5 || value[0] !== 1 || value.readUInt32LE(1) !== crc32(rawName) || utf8(value.subarray(5)) !== name)
      throw new Error('历史ZIP Unicode名称与原目录不一致');
    offset += length;
  }
}

interface ZipEntry { name: string; directory: boolean; method: number; local: number; start: number; end: number; expanded: number; crc: number }

/** Parse the narrow, non-streaming format produced by archiveHistory. Every
 * deflate stream is bounded before allocation; no JSZip decompression or disk
 * extraction is used. Unknown ZIP features require a future explicit version. */
function zipEntries(input: Uint8Array) {
  if (!(input instanceof Uint8Array) || input.byteLength < 22 || input.byteLength > MAX_ARCHIVE)
    throw new Error('历史ZIP无效或超过80 MiB');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength), end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) throw new Error('历史ZIP压缩目录损坏或含不支持的尾部数据');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), directory = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count < 1
    || count > MAX_ENTRIES || directory === 0xffffffff || directory + size !== end)
    throw new Error('历史ZIP条目过多，或使用分卷/ZIP64目录');
  const entries: ZipEntry[] = [], names = new Set<string>(), spellings = new Map<string, string>();
  let cursor = directory, contentBytes = 0, expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('历史ZIP中央目录损坏');
    const madeBy = bytes.readUInt16LE(cursor + 4), needed = bytes.readUInt16LE(cursor + 6), flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || ![10, 20].includes(needed) || (flags & ~0x0800) || ![0, 8].includes(method) || commentLength
      || bytes.readUInt16LE(cursor + 34) || compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff || local + 30 > directory)
      throw new Error('历史ZIP使用不支持的加密、流式或压缩结构');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = utf8(rawName), isDirectory = name.endsWith('/');
    const relative = isDirectory ? name.slice(0, -1) : name;
    if (relative !== 'files' && relative !== 'manifest.json') {
      if (!relative.startsWith('files/')) throw new Error('历史ZIP包含未知文件分区');
      relativeSchema.parse(relative.slice(6));
    }
    if ((relative === 'files' && !isDirectory) || (relative === 'manifest.json' && isDirectory)) throw new Error('历史ZIP控制路径类型无效');
    if (isDirectory && relative.split('/').length > 31) throw new Error('历史ZIP目录层级过深');
    const normalized = canonical(relative);
    if (names.has(normalized)) throw new Error('历史ZIP存在重复或Unicode等价路径');
    names.add(normalized);
    const parts = relative.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/'), key = canonical(prefix);
      if (spellings.has(key) && spellings.get(key) !== prefix) throw new Error('历史ZIP目录名大小写或Unicode冲突');
      spellings.set(key, prefix);
    }
    const platform = madeBy >>> 8, unixMode = external >>> 16, unixType = unixMode & 0xf000;
    if (![0, 3].includes(platform) || (platform === 3 && unixType !== 0 && unixType !== (isDirectory ? 0x4000 : 0x8000))
      || ((external & 0x10) !== 0) !== isDirectory || (external & 0x08)) throw new Error('历史ZIP包含链接、设备或类型异常条目');
    if (isDirectory ? expanded !== 0 || compressed !== 0 || method !== 0 : expanded > (name === 'manifest.json' ? MAX_MANIFEST : MAX_FILE))
      throw new Error('历史ZIP目录带数据或单文件超限');
    if (!isDirectory && name !== 'manifest.json') contentBytes += expanded;
    expandedTotal += expanded;
    if (contentBytes > MAX_CONTENT || expandedTotal > MAX_CONTENT + MAX_MANIFEST) throw new Error('历史ZIP展开内容超过安全上限');
    checkExtra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), rawName, name);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== needed || bytes.readUInt16LE(local + 6) !== flags
      || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed
      || bytes.readUInt32LE(local + 22) !== expanded || bytes.readUInt32LE(local + 10) !== bytes.readUInt32LE(cursor + 12))
      throw new Error('历史ZIP本地头与中央目录不一致');
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localName + localExtra, dataEnd = start + compressed;
    if (localName !== nameLength || start > directory || dataEnd > directory || !bytes.subarray(local + 30, local + 30 + localName).equals(rawName))
      throw new Error('历史ZIP内容超出压缩边界或名称不一致');
    checkExtra(bytes.subarray(local + 30 + localName, start), rawName, name);
    entries.push({ name, directory: isDirectory, method, local, start, end: dataEnd, expanded, crc }); cursor = next;
  }
  if (cursor !== end) throw new Error('历史ZIP条目数量或中央目录长度不一致');
  const ranges = [...entries].sort((a, b) => a.local - b.local);
  if (ranges[0]!.local !== 0 || ranges.at(-1)!.end !== directory || ranges.some((entry, index) => index > 0 && entry.local !== ranges[index - 1]!.end))
    throw new Error('历史ZIP条目重叠或包含未知前缀/间隔');
  const data = new Map<string, Buffer>();
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.start, entry.end); let actual: Buffer;
    try {
      if (entry.method === 0) actual = compressed;
      else {
        const result = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== compressed.length) throw new Error('deflate trailing data');
        actual = result.buffer;
      }
    } catch { throw new Error('历史ZIP解压失败或实际大小超过声明'); }
    if (actual.length !== entry.expanded || crc32(actual) !== entry.crc) throw new Error('历史ZIP实际大小或CRC与目录不符');
    data.set(entry.name, Buffer.from(actual));
  }
  return data;
}

export function parseMaterialHistoryArchive(bytes: Uint8Array, completionBytes: Uint8Array, projectId: string): MaterialHistoryArchiveContents {
  z.uuid().parse(projectId);
  if (!(completionBytes instanceof Uint8Array) || !completionBytes.byteLength || completionBytes.byteLength > MAX_MANIFEST)
    throw new Error('历史ZIP缺少有效完成清单或清单超过8 MiB');
  const completion = completionSchema.parse(json(completionBytes));
  if (completion.projectId !== projectId) throw new Error('历史ZIP完成清单属于另一部小说');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE) throw new Error('历史ZIP无效或超过80 MiB');
  const digest = sha256(bytes);
  if (completion.archiveBytes !== bytes.byteLength || completion.sha256 !== digest) throw new Error('历史ZIP哈希或长度与完成清单不符');
  const entries = zipEntries(bytes), rawManifest = entries.get('manifest.json');
  if (!rawManifest) throw new Error('历史ZIP缺少内部清单');
  const manifest = manifestSchema.parse(json(rawManifest));
  const { file: _file, bytes: declaredBytes, archiveBytes: _archiveBytes, sha256: _sha256, ...completedManifest } = completion;
  if (manifest.projectId !== projectId || JSON.stringify(manifest) !== JSON.stringify(completedManifest)) throw new Error('历史ZIP内部清单与完成清单归属或内容不符');
  const expected = new Set(['manifest.json']), paths = new Set<string>(), spellings = new Map<string, string>(), data = new Map<string, Buffer>();
  let total = 0;
  for (const entry of manifest.entries) {
    const normalized = canonical(entry.path);
    if (paths.has(normalized)) throw new Error('历史ZIP清单含重复路径'); paths.add(normalized);
    const parts = entry.path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/'), key = canonical(prefix);
      if (spellings.has(key) && spellings.get(key) !== prefix) throw new Error('历史ZIP清单目录名冲突'); spellings.set(key, prefix);
      if (n < parts.length) expected.add(`files/${prefix}/`);
    }
    expected.add('files/'); expected.add(`files/${entry.path}`);
    const content = entries.get(`files/${entry.path}`);
    if (!content || content.length !== entry.bytes || sha256(content) !== entry.sha256) throw new Error('历史ZIP缺失文件或文件哈希与清单不符');
    total += entry.bytes; if (total > MAX_CONTENT) throw new Error('历史ZIP原文超过64 MiB');
    data.set(entry.path, content);
  }
  for (const relative of paths) {
    const parts = relative.split('/');
    for (let n = 1; n < parts.length; n++) if (paths.has(parts.slice(0, n).join('/'))) throw new Error('历史ZIP文件与父目录重名');
  }
  if (expected.size > MAX_ENTRIES || entries.size !== expected.size || [...expected].some(name => !entries.has(name)))
    throw new Error('历史ZIP包含额外条目、缺失目录或条目超限');
  if (total !== declaredBytes) throw new Error('历史ZIP总大小与完成清单不符');
  return { manifest, data, sha256: digest, archiveBytes: bytes.byteLength, bytes: total };
}

// The DAG archive uses the same narrow, bounded container with flat content hashes.
export { zipEntries as readBoundedMaterialZip };
