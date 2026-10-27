import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { z } from 'zod';
import { isSafeRelative } from './nas-backup';
import { readBoundedMaterialZip } from './material-history-zip';

const MiB = 1024 * 1024;
export const MATERIAL_DAG_LIMITS = Object.freeze({
  contentBytes: 64 * MiB, archiveBytes: 80 * MiB, manifestBytes: 8 * MiB,
  references: 10000, blobs: 10000, versions: 1000, fileBytes: 32 * MiB,
  rawManifestBytes: 8 * MiB, referencedBytes: 256 * MiB
});
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeSchema = z.string().refine(value => isSafeRelative(value) && value.split('/').length <= 31
  && value.split('/').every(part => !part.startsWith('.')), '完整历史资料路径不安全');
const entrySchema = z.object({ path: relativeSchema, bytes: z.number().int().min(0).max(MATERIAL_DAG_LIMITS.fileBytes), sha256: hashSchema }).strict();
const revisionSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), revisionId: z.uuid(), createdAt: z.iso.datetime(),
  parents: z.array(z.uuid()).max(MATERIAL_DAG_LIMITS.versions), entries: z.array(entrySchema).max(MATERIAL_DAG_LIMITS.references) }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('material-history-dag-archive'), projectId: z.uuid(),
  archiveId: z.uuid(), createdAt: z.iso.datetime(), fingerprint: hashSchema,
  transport: z.array(z.object({ id: z.uuid(), manifestSha256: hashSchema }).strict()).max(MATERIAL_DAG_LIMITS.versions),
  local: z.array(z.object({ id: z.uuid(), createdAt: z.iso.datetime(), entries: z.array(entrySchema).max(MATERIAL_DAG_LIMITS.references) }).strict()).max(MATERIAL_DAG_LIMITS.versions),
  leaves: z.array(z.uuid()).max(MATERIAL_DAG_LIMITS.versions),
  blobs: z.array(z.object({ sha256: hashSchema, bytes: z.number().int().min(0).max(MATERIAL_DAG_LIMITS.fileBytes) }).strict()).max(MATERIAL_DAG_LIMITS.blobs)
}).strict();
const completionSchema = manifestSchema.extend({ file: z.literal('完整资料历史.zip'),
  bytes: z.number().int().min(0).max(MATERIAL_DAG_LIMITS.contentBytes),
  archiveBytes: z.number().int().min(22).max(MATERIAL_DAG_LIMITS.archiveBytes), sha256: hashSchema }).strict();

export type MaterialDagManifest = z.infer<typeof manifestSchema>;
export interface MaterialDagContents {
  manifest: MaterialDagManifest;
  blobs: Map<string, Buffer>;
  bytes: number;
  archiveBytes: number;
  sha256: string;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));
const canonical = (value: string) => value.normalize('NFC').toLowerCase();
function json(bytes: Uint8Array) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw new Error('完整历史清单不是有效UTF-8 JSON'); }
}
function uniqueIds(ids: string[], label: string) {
  if (new Set(ids.map(canonical)).size !== ids.length) throw new Error(`完整历史${label}ID重复或大小写等价`);
}
function checkPaths(entries: z.infer<typeof entrySchema>[]) {
  const files = new Set<string>(), spellings = new Map<string, string>();
  for (const entry of entries) {
    const name = canonical(entry.path);
    if (files.has(name)) throw new Error('完整历史包含重复或Unicode等价资料路径');
    files.add(name); const parts = entry.path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/'), normalized = canonical(prefix);
      if (spellings.has(normalized) && spellings.get(normalized) !== prefix) throw new Error('完整历史目录名存在大小写或Unicode冲突');
      spellings.set(normalized, prefix);
    }
  }
  for (const entry of entries) {
    const parts = canonical(entry.path).split('/');
    for (let n = 1; n < parts.length; n++) if (files.has(parts.slice(0, n).join('/'))) throw new Error('完整历史文件和父目录重名');
  }
}

/** Validate the whole graph and every blob once, independently of how often a
 * historical snapshot references it. No disk extraction or canonical writes. */
function validate(input: MaterialDagManifest, supplied: Map<string, Buffer>) {
  const manifest = manifestSchema.parse(input);
  if (jsonBytes(manifest).length > MATERIAL_DAG_LIMITS.manifestBytes) throw new Error('完整历史清单超过8 MiB');
  if (!manifest.transport.length && !manifest.local.length) throw new Error('暂无可归档的完整历史');
  uniqueIds(manifest.transport.map(item => item.id), '传输版本');
  uniqueIds(manifest.local.map(item => item.id), '本机归档');
  uniqueIds(manifest.leaves, '叶子');
  if (!(supplied instanceof Map) || supplied.size !== manifest.blobs.length) throw new Error('完整历史blob数量不匹配');
  const blobs = new Map<string, Buffer>(), declared = new Set<string>(); let bytes = 0;
  // Enforce lengths/aggregate bounds before hashing or parsing a blob.
  for (const descriptor of manifest.blobs) {
    if (declared.has(descriptor.sha256)) throw new Error('完整历史blob清单重复');
    declared.add(descriptor.sha256); const content = supplied.get(descriptor.sha256);
    if (!Buffer.isBuffer(content) || content.length !== descriptor.bytes) throw new Error('完整历史缺少blob或字节长度不匹配');
    bytes += descriptor.bytes;
    if (bytes > MATERIAL_DAG_LIMITS.contentBytes) throw new Error('完整历史去重内容超过64 MiB');
    blobs.set(descriptor.sha256, content);
  }
  for (const [key, content] of blobs) if (hash(content) !== key) throw new Error('完整历史blob哈希不匹配');
  const referenced = new Set<string>(); let references = 0, referencedBytes = 0, rawManifestBytes = 0;
  const reference = (key: string, expectedBytes?: number) => {
    const content = blobs.get(key);
    if (!content || (expectedBytes !== undefined && expectedBytes !== content.length)) throw new Error('完整历史引用缺少blob或长度不匹配');
    if (++references > MATERIAL_DAG_LIMITS.references) throw new Error('完整历史引用超过10000个');
    referencedBytes += content.length;
    if (referencedBytes > MATERIAL_DAG_LIMITS.referencedBytes) throw new Error('完整历史引用总量超过256 MiB');
    referenced.add(key); return content;
  };
  const revisions = new Map<string, z.infer<typeof revisionSchema>>();
  for (const item of manifest.transport) {
    const raw = reference(item.manifestSha256); rawManifestBytes += raw.length;
    if (raw.length > 2 * MiB || rawManifestBytes > MATERIAL_DAG_LIMITS.rawManifestBytes) throw new Error('完整历史传输清单单份超过2 MiB或累计超过8 MiB');
    const revision = revisionSchema.parse(json(raw));
    if (revision.projectId !== manifest.projectId || revision.revisionId !== item.id) throw new Error('完整历史传输清单属于另一部小说或版本ID不符');
    uniqueIds(revision.parents, '父版本');
    if (revision.parents.includes(item.id)) throw new Error('完整历史父关系成环');
    checkPaths(revision.entries);
    for (const entry of revision.entries) reference(entry.sha256, entry.bytes);
    revisions.set(item.id, revision);
  }
  for (const local of manifest.local) {
    checkPaths(local.entries);
    for (const entry of local.entries) reference(entry.sha256, entry.bytes);
  }
  if (referenced.size !== blobs.size) throw new Error('完整历史含未引用的额外blob');
  const parents = new Set<string>(), seen = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('完整历史父关系成环');
    if (seen.has(id)) return;
    const revision = revisions.get(id); if (!revision) throw new Error('完整历史缺少父版本');
    visiting.add(id);
    for (const parent of revision.parents) { parents.add(parent); visit(parent); }
    visiting.delete(id); seen.add(id);
  };
  for (const id of revisions.keys()) visit(id);
  const leaves = [...revisions.keys()].filter(id => !parents.has(id)).sort();
  if (JSON.stringify(leaves) !== JSON.stringify([...manifest.leaves].sort())) throw new Error('完整历史叶子分支清单不完整或多余');
  return { manifest, blobs, bytes };
}

export function parseMaterialHistoryDag(archive: Uint8Array, completionBytes: Uint8Array, projectId: string): MaterialDagContents {
  z.uuid().parse(projectId);
  if (!(completionBytes instanceof Uint8Array) || !completionBytes.byteLength || completionBytes.byteLength > MATERIAL_DAG_LIMITS.manifestBytes)
    throw new Error('完整历史缺少完成清单或清单超过8 MiB');
  const completion = completionSchema.parse(json(completionBytes));
  if (completion.projectId !== projectId) throw new Error('完整历史完成清单属于另一部小说');
  if (!(archive instanceof Uint8Array) || archive.byteLength > MATERIAL_DAG_LIMITS.archiveBytes) throw new Error('完整历史ZIP无效或超过80 MiB');
  const sha256 = hash(archive);
  if (archive.byteLength !== completion.archiveBytes || sha256 !== completion.sha256) throw new Error('完整历史ZIP长度或哈希与完成清单不匹配');
  const entries = readBoundedMaterialZip(archive), raw = entries.get('manifest.json');
  if (!raw) throw new Error('完整历史ZIP缺少内部清单');
  const manifest = manifestSchema.parse(json(raw));
  const { file: _file, bytes: declaredBytes, archiveBytes: _archiveBytes, sha256: _sha256, ...completedManifest } = completion;
  if (JSON.stringify(manifest) !== JSON.stringify(completedManifest)) throw new Error('完整历史内部清单与完成清单不一致');
  const expected = new Set(['manifest.json']), blobs = new Map<string, Buffer>();
  if (manifest.blobs.length) expected.add('files/');
  for (const descriptor of manifest.blobs) {
    const name = `files/${descriptor.sha256}`; expected.add(name);
    const content = entries.get(name); if (!content) throw new Error('完整历史ZIP缺少blob');
    blobs.set(descriptor.sha256, content);
  }
  if (entries.size !== expected.size || [...expected].some(name => !entries.has(name))) throw new Error('完整历史ZIP含额外条目、缺少目录或重复blob');
  const result = validate(manifest, blobs);
  if (result.bytes !== declaredBytes) throw new Error('完整历史去重字节与完成清单不一致');
  return { ...result, archiveBytes: archive.byteLength, sha256 };
}

export async function encodeMaterialHistoryDag(input: MaterialDagManifest, supplied: Map<string, Buffer>): Promise<{ archive: Buffer; completion: Buffer }> {
  const prepared = validate(input, supplied);
  // Snapshot caller-owned bytes before the first await; the output cannot follow a
  // later mutation of the Map or any Buffer during compression.
  const blobs = new Map([...prepared.blobs].map(([key, value]) => [key, Buffer.from(value)]));
  const manifestBytes = jsonBytes(prepared.manifest);
  const preliminary = { ...prepared.manifest, file: '完整资料历史.zip', bytes: prepared.bytes,
    archiveBytes: MATERIAL_DAG_LIMITS.archiveBytes, sha256: '0'.repeat(64) };
  if (jsonBytes(preliminary).length > MATERIAL_DAG_LIMITS.manifestBytes) throw new Error('完整历史完成清单超过8 MiB');
  const zip = new JSZip();
  for (const [key, content] of blobs) zip.file(`files/${key}`, content);
  zip.file('manifest.json', manifestBytes);
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (archive.length > MATERIAL_DAG_LIMITS.archiveBytes) throw new Error('完整历史ZIP超过80 MiB');
  const completion = jsonBytes({ ...prepared.manifest, file: '完整资料历史.zip', bytes: prepared.bytes, archiveBytes: archive.length, sha256: hash(archive) });
  parseMaterialHistoryDag(archive, completion, prepared.manifest.projectId);
  return { archive, completion };
}
