import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { z } from 'zod';
import { bodyParagraphTexts, editDocxStructure, listImages, listTables, replaceImage, rewriteDocxParagraphs, structureHeader, structureTables } from './docx-fidelity';
import type { Workspace } from './workspace';
import type { DocxStructureAction, DocxStructureEditResult, DocxStructureSnapshot } from '../shared/docx-structure';

const MAX_SOURCE = 20 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u, '请重新打开原稿并提供当前文件版本');
const paragraphSchema = z.string().max(100000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)
  && !Array.from(value).some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }), '段落含不支持的 XML 字符');
const paragraphsSchema = z.array(paragraphSchema).max(10000).refine(value => value.reduce((sum, paragraph) => sum + Buffer.byteLength(paragraph), 0) <= 8 * 1024 * 1024, '改写文字过大，请分批处理');
const indexSchema = z.number().int().min(0).max(9999);
const partSchema = z.string().regex(/^word\/(?:header|footer)\d{0,4}\.xml$/u, '只能改写文档已有的页眉或页脚');
const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('appendRow'), tableIndex: indexSchema }).strict(),
  z.object({ kind: z.literal('removeRow'), tableIndex: indexSchema, rowIndex: indexSchema }).strict(),
  z.object({ kind: z.literal('cell'), tableIndex: indexSchema, rowIndex: indexSchema, cellIndex: indexSchema, paragraphs: paragraphsSchema.refine(value => value.length >= 1 && value.length <= 200, '单元格需要1至200个段落') }).strict(),
  z.object({ kind: z.literal('header'), part: partSchema, paragraphs: paragraphsSchema }).strict()
]);
const batchSchema = z.array(actionSchema).min(1).max(100).refine(actions => actions.reduce((sum, action) => sum + ('paragraphs' in action ? action.paragraphs.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) : 0), 0) <= 8 * 1024 * 1024, '整批改写文字超过8 MiB，请分批处理');
export type DocxCopyAction = DocxStructureAction;

function sourceRequest(projectId: string, relative: string) {
  const id = z.uuid().parse(projectId), name = z.string().min(1).max(2000).parse(relative);
  const parts = name.split(/[\\/]/u);
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /[\u0000-\u001f\u007f:<>"|?*]/u.test(name)
    || parts.some(part => !part || part === '.' || part === '..') || parts[0].toLowerCase() === '小说资料' || !/\.docx$/iu.test(name))
    throw new Error('只能读取本书目录中的 DOCX 原稿，文件路径无效');
  return { projectId: id, path: parts.join('/') };
}

/** Inspect the ZIP directory before any JSZip decompression. Then check each
 * deflate stream with a hard output bound, so forged size metadata cannot turn
 * a small DOCX into an unbounded allocation. No ZIP entries are written to disk. */
function validateArchive(source: Uint8Array) {
  const bytes = Buffer.from(source);
  if (bytes.length < 22 || bytes.length > MAX_SOURCE) throw new Error('DOCX 文件无效或超过 20 MiB，请保留原稿并用 Word/WPS 处理');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('DOCX 压缩目录损坏，已取消读取');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), directory = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
    || count === 0xffff || count < 1 || count > MAX_ENTRIES || directory === 0xffffffff || directory + size !== end)
    throw new Error('DOCX 条目过多，或使用了不支持的分卷/ZIP64 压缩目录');
  let cursor = directory, total = 0;
  const names = new Set<string>(), ranges: { start: number; end: number }[] = [];
  const entries: { method: number; start: number; compressed: number; expanded: number; name: string }[] = [];
  for (let index = 0; index < count; index++) {
    if (cursor < 0 || cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX 条目目录损坏');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extra + comment;
    if (next > end || !nameLength || (flags & 0x41) || ![0, 8].includes(method) || compressed === 0xffffffff || expanded === 0xffffffff
      || bytes.readUInt16LE(cursor + 34) !== 0 || local === 0xffffffff || local + 30 > directory)
      throw new Error('DOCX 条目使用了不支持的加密或压缩结构');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(rawName), parts = name.replace(/\/$/u, '').split('/');
    if (/[\\\u0000-\u001f\u007f:]/u.test(name) || name.startsWith('/') || parts.some(part => !part || part === '.' || part === '..') || names.has(name.toLowerCase()))
      throw new Error('DOCX 条目路径越界、重复或格式无效');
    names.add(name.toLowerCase());
    total += expanded;
    if (total > MAX_EXPANDED) throw new Error('DOCX 解压后超过 64 MiB 安全上限，已保留原稿');
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method)
      throw new Error('DOCX 条目与目录记录不一致');
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra, dataEnd = start + compressed;
    if (localName !== nameLength || !bytes.subarray(local + 30, local + 30 + localName).equals(rawName) || start > directory || dataEnd > directory)
      throw new Error('DOCX 条目内容越过压缩边界');
    ranges.push({ start: local, end: dataEnd }); entries.push({ method, start, compressed, expanded, name }); cursor = next;
  }
  if (cursor !== end) throw new Error('DOCX 条目数量与目录记录不一致');
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) throw new Error('DOCX 条目内容互相重叠');
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.start, entry.start + entry.compressed);
    let actual: Buffer;
    try { actual = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded + 1) }); }
    catch { throw new Error('DOCX 条目解压失败或实际内容超过声明大小，已保留原稿'); }
    if (actual.length !== entry.expanded) throw new Error('DOCX 条目实际大小与目录不符，已保留原稿');
  }
  return entries.map(entry => entry.name);
}

async function checkedArchive(source: Uint8Array) {
  const names = validateArchive(source), zip = await JSZip.loadAsync(source);
  // Unicode path extras must not rename or synthesize entries after preflight.
  if (Object.keys(zip.files).length !== names.length || names.some(name => !zip.files[name])) throw new Error('DOCX 条目名称与预检目录不符');
  if (!zip.file('word/document.xml')) throw new Error('这不是可编辑的 DOCX（缺少 word/document.xml）');
  return zip;
}

/** All source reads and copy publication use Workspace's frozen project/path/hash guards. */
export class DocxCopyService {
  constructor(private readonly workspace: Workspace) {}
  private async original(request: { projectId: string; path: string }, expectedHash?: string) {
    const source = await this.workspace.readOriginalChapter(request.projectId, request.path, expectedHash);
    if (source.projectId !== request.projectId || !/\.docx$/iu.test(source.path)) throw new Error('DOCX 原稿归属或路径不匹配');
    await checkedArchive(source.bytes);
    return source;
  }
  async insight(projectId: string, relative: string) {
    const source = await this.original(sourceRequest(projectId, relative)), zip = await JSZip.loadAsync(source.bytes);
    return { tables: listTables(await zip.file('word/document.xml')!.async('string')), headers: Object.keys(zip.files).filter(name => /^word\/(?:header|footer)\d{0,4}\.xml$/u.test(name)).sort() };
  }
  async body(projectId: string, relative: string, expectedHash: string) {
    const source = await this.original(sourceRequest(projectId, relative), hashSchema.parse(expectedHash));
    const zip = await JSZip.loadAsync(source.bytes);
    const paragraphs = paragraphsSchema.parse(bodyParagraphTexts(await zip.file('word/document.xml')!.async('string')));
    return { projectId: source.projectId, path: source.path, hash: source.hash, paragraphs };
  }
  async structure(projectId: string, relative: string, expectedHash: string): Promise<DocxStructureSnapshot> {
    const request = sourceRequest(projectId, relative), hash = hashSchema.parse(expectedHash), source = await this.original(request, hash), zip = await checkedArchive(source.bytes);
    const read = async (name: string) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(await zip.file(name)!.async('uint8array')); } catch { throw new Error('DOCX XML 不是有效 UTF-8，已保留原稿，请用 Word/WPS 处理'); } };
    const tables = structureTables(await read('word/document.xml')), names = Object.keys(zip.files).filter(name => /^word\/(?:header|footer)\d{0,4}\.xml$/u.test(name)).sort();
    if (names.length > 100) throw new Error('页眉页脚部件超过100个，请用 Word/WPS 处理');
    const headers = [];
    for (const name of names) headers.push(structureHeader(await read(name), name));
    const paragraphs = [...tables.flatMap(table => table.rows.flatMap(row => row.cells.flatMap(cell => cell.paragraphs))), ...headers.flatMap(header => header.paragraphs)];
    if (tables.reduce((sum, table) => sum + table.rows.reduce((cells, row) => cells + row.cells.length, 0), 0) > 10000 || paragraphs.length > 10000
      || paragraphs.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 8 * 1024 * 1024) throw new Error('DOCX 结构或文字超过安全预览上限，请用 Word/WPS 处理');
    // Recheck the frozen source after all ZIP/XML work, before returning a UI baseline.
    await this.workspace.readOriginalChapter(request.projectId, source.path, source.hash);
    return { schemaVersion: 1, projectId: source.projectId, path: source.path, hash: source.hash, tables, headers };
  }
  async images(projectId: string, relative: string, expectedHash?: string) {
    const source = await this.original(sourceRequest(projectId, relative), expectedHash === undefined ? undefined : hashSchema.parse(expectedHash));
    return listImages(source.bytes);
  }
  async rewrite(projectId: string, relative: string, paragraphs: string[], expectedHash: string) {
    const request = sourceRequest(projectId, relative), hash = hashSchema.parse(expectedHash), frozen = paragraphsSchema.parse(paragraphs);
    const source = await this.original(request, hash), result = await rewriteDocxParagraphs(source.bytes, frozen, { structural: true });
    await checkedArchive(result.bytes);
    const output = await this.workspace.publishOriginalCopy(request.projectId, source.path, source.hash, result.bytes, '保真编辑');
    return { path: output.path, paragraphs: result.paragraphs, changed: result.changed };
  }
  async edit(projectId: string, relative: string, action: unknown, expectedHash: string) {
    const result = await this.batchEdit(projectId, relative, [action], expectedHash);
    return { path: result.path, changed: result.changed };
  }
  async batchEdit(projectId: string, relative: string, actions: unknown, expectedHash: string): Promise<DocxStructureEditResult> {
    const request = sourceRequest(projectId, relative), hash = hashSchema.parse(expectedHash), frozen = batchSchema.parse(structuredClone(actions));
    const source = await this.original(request, hash), result = await editDocxStructure(source.bytes, frozen);
    await checkedArchive(result.bytes);
    const output = await this.workspace.publishOriginalCopy(request.projectId, source.path, source.hash, result.bytes, '结构编辑');
    return { projectId: request.projectId, sourcePath: source.path, sourceHash: source.hash, path: output.path, changed: result.changed };
  }
  async replace(projectId: string, relative: string, mediaName: string, image: Uint8Array, expectedHash: string) {
    const request = sourceRequest(projectId, relative), hash = hashSchema.parse(expectedHash);
    const name = z.string().regex(/^word\/media\/[^/\\\u0000-\u001f:]+\.(?:png|jpe?g)$/iu, '只能替换已有 PNG/JPEG 图片部件').parse(mediaName);
    if (!(image instanceof Uint8Array) || image.byteLength > MAX_SOURCE) throw new Error('替换图片无效或超过 20 MiB');
    const frozen = Buffer.from(image);
    const png = frozen.length >= 8 && frozen.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = frozen.length >= 3 && frozen[0] === 0xff && frozen[1] === 0xd8 && frozen[2] === 0xff;
    if (/\.png$/iu.test(name) ? !png : !jpeg) throw new Error('图片实际类型与目标扩展名不一致，请使用相同格式的 PNG/JPEG');
    const source = await this.original(request, hash), result = await replaceImage(source.bytes, name, frozen);
    await checkedArchive(result.bytes);
    const output = await this.workspace.publishOriginalCopy(request.projectId, source.path, source.hash, result.bytes, '换图');
    return { path: output.path, name: result.name };
  }
}
