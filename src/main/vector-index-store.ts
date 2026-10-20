import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IndexScope, KnowledgeChunk } from '../core/knowledge';
import { diffIndex } from '../core/vector-index';
import type { Workspace } from './workspace';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({ id: z.string().min(1).max(300), sourcePath: z.string().min(1).max(2000), sourceHash: hash,
  startParagraph: z.number().int().min(0).max(99999), endParagraph: z.number().int().min(0).max(99999),
  text: z.string().min(1).max(20000), vector: z.array(z.number().finite()).min(1).max(8192) });
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), corpus: z.enum(['canon', 'style-reference', 'discussion']),
  fingerprint: z.string().min(1).max(200), dimensions: z.number().int().min(1).max(8192), updatedAt: z.string(),
  sources: z.array(z.object({ path: z.string().min(1).max(2000), hash })).max(5000),
  entries: z.array(entrySchema).max(20000) });
export type VectorIndexSnapshot = z.infer<typeof schema>;
export interface VectorIndexStatus {
  exists: boolean; entries: number; dimensions: number; updatedAt: string;
  staleSources: string[]; removedSources: string[]; outdated: boolean;
}
const MAX_BYTES = 96 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };

/** One file per (project, corpus, embedding fingerprint). A changed model/dimension/chunking
 * policy therefore lands in a different file instead of silently reusing another vector space.
 * The index is a rebuildable cache: it may be deleted at any time and never becomes a source. */
export class VectorIndexStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private workspace: Workspace) {}
  private async folder(scope: IndexScope) {
    this.workspace.getProject(z.uuid().parse(scope.projectId));
    const base = await fs.realpath(this.directory).catch(async error => {
      if (!missing(error)) throw error;
      await fs.mkdir(this.directory, { recursive: true });
      return fs.realpath(this.directory);
    });
    const target = path.join(base, 'vector-index', scope.projectId);
    await fs.mkdir(target, { recursive: true });
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(base, await fs.realpath(target))) throw new Error('向量索引目录或链接异常，拒绝使用');
    return target;
  }
  private async file(scope: IndexScope) {
    const folder = await this.folder(scope);
    return path.join(folder, `${scope.corpus}-${scope.embeddingFingerprint.replace(/[^a-z0-9]/gi, '').slice(0, 64)}.json`);
  }
  async read(scope: IndexScope): Promise<VectorIndexSnapshot | null> {
    const file = await this.file(scope);
    let raw: string;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('向量索引文件类型、链接或大小异常，原文件已保留');
      raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('向量索引超过本机上限，原文件已保留');
    } catch (error) { if (missing(error)) return null; throw error; }
    let value: VectorIndexSnapshot;
    try { value = schema.parse(JSON.parse(raw)); }
    catch { throw new Error('向量索引损坏或版本不受支持，原文件已保留'); }
    if (value.projectId !== scope.projectId || value.corpus !== scope.corpus || value.fingerprint !== scope.embeddingFingerprint)
      throw new Error('向量索引与本书、用途或嵌入指纹不匹配，原文件已保留');
    if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) throw new Error('向量索引条目重复，原文件已保留');
    if (value.entries.some(entry => entry.vector.length !== value.dimensions)) throw new Error('向量索引维度不一致，原文件已保留');
    return value;
  }
  /** Atomic publish with a previous-version backup, so a failed write never truncates a usable index. */
  write(scope: IndexScope, value: Omit<VectorIndexSnapshot, 'schemaVersion' | 'projectId' | 'corpus' | 'fingerprint' | 'updatedAt'>) {
    return this.serial(async () => {
      const next = schema.parse({ schemaVersion: 1, projectId: scope.projectId, corpus: scope.corpus, fingerprint: scope.embeddingFingerprint, updatedAt: new Date().toISOString(), ...value });
      const file = await this.file(scope);
      const previous = await fs.readFile(file, 'utf8').catch(error => { if (missing(error)) return null; throw error; });
      const raw = JSON.stringify(next);
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('向量索引超过本机上限，请减少来源后重建');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, raw, { flag: 'wx' });
        if (previous !== null) {
          const history = path.join(path.dirname(file), 'history'); await fs.mkdir(history, { recursive: true });
          const backup = path.join(history, `${path.basename(file, '.json')}-${randomUUID()}.json`);
          await fs.writeFile(backup, previous, { flag: 'wx' });
        }
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return next;
    });
  }
  /** Which chunks must be embedded again, and what the current on-disk index already covers. */
  plan(scope: IndexScope, chunks: KnowledgeChunk[]) {
    return this.serial(async () => {
      const snapshot = await this.read(scope);
      const previous = snapshot ? snapshot.entries.map(entry => ({ id: entry.id, sourcePath: entry.sourcePath, sourceHash: entry.sourceHash })) : [];
      const diff = diffIndex(previous, chunks);
      const keep = new Set(diff.keepIds);
      return { snapshot, diff, keepEntries: snapshot ? snapshot.entries.filter(entry => keep.has(entry.id)) : [] };
    });
  }
  async status(scope: IndexScope, currentHashes: Record<string, string>): Promise<VectorIndexStatus> {
    const snapshot = await this.read(scope);
    if (!snapshot) return { exists: false, entries: 0, dimensions: 0, updatedAt: '', staleSources: [], removedSources: [], outdated: true };
    const paths = new Set<string>();
    for (const entry of snapshot.entries) paths.add(entry.sourcePath);
    const staleSources = [...paths].filter(source => currentHashes[source] !== undefined && currentHashes[source] !== snapshot.entries.find(entry => entry.sourcePath === source)?.sourceHash);
    const removedSources = [...paths].filter(source => currentHashes[source] === undefined);
    return { exists: true, entries: snapshot.entries.length, dimensions: snapshot.dimensions, updatedAt: snapshot.updatedAt,
      staleSources, removedSources, outdated: staleSources.length > 0 || removedSources.length > 0 };
  }
  async clear(scope: IndexScope) {
    const file = await this.file(scope);
    await fs.rm(file, { force: true });
  }
  /** Small pointer to the index that currently serves a purpose for this book, so the search
   * path can embed a query with exactly the dimensions/space that was built. */
  private async pointerFile(projectId: string, corpus: IndexScope['corpus']) {
    this.workspace.getProject(z.uuid().parse(projectId));
    const folder = await this.folder({ projectId, corpus, embeddingFingerprint: 'pointer' });
    return path.join(folder, `active-${corpus}.json`);
  }
  async writeActive(projectId: string, corpus: IndexScope['corpus'], value: { fingerprint: string; dimensions: number }) {
    const parsed = z.object({ fingerprint: z.string().min(1).max(200), dimensions: z.number().int().min(1).max(8192) }).parse(value);
    const file = await this.pointerFile(projectId, corpus);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, corpus, ...parsed }), { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async readActive(projectId: string, corpus: IndexScope['corpus']): Promise<{ fingerprint: string; dimensions: number } | null> {
    const file = await this.pointerFile(projectId, corpus);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
    try {
      const value = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), corpus: z.enum(['canon', 'style-reference', 'discussion']), fingerprint: z.string().min(1).max(200), dimensions: z.number().int().min(1).max(8192) }).parse(JSON.parse(raw));
      if (value.projectId !== projectId || value.corpus !== corpus) throw new Error('索引指针归属不匹配');
      return { fingerprint: value.fingerprint, dimensions: value.dimensions };
    } catch { throw new Error('索引指针损坏或版本不受支持，原文件已保留'); }
  }
  async clearActive(projectId: string, corpus: IndexScope['corpus']) {
    await fs.rm(await this.pointerFile(projectId, corpus), { force: true });
  }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
}
