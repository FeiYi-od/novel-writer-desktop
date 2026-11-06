import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import JSZip from 'jszip';
import type { MaterialHistoryArchiveResult, MaterialHistoryCapacity, MaterialHistoryCapacitySnapshot, MaterialHistoryCopyRequest, MaterialHistoryCopyResult, MaterialHistoryRestoreResult, MaterialHistoryFile, MaterialHistoryImportCopyRequest, MaterialHistoryImportPreview, MaterialHistoryImportRequest, MaterialHistoryImportResult, MaterialHistoryPreview, MaterialHistoryRequest, MaterialHistorySnapshot, MaterialHistoryVersion, MaterialSyncDifference, MaterialSyncRequest, MaterialSyncSnapshot } from '../shared/material-sync';
import { MATERIAL_HISTORY_LIMIT, MATERIAL_HISTORY_WARNING_AT } from '../shared/material-sync';
import type { Workspace } from './workspace';
import { isSafeRelative } from './nas-backup';
import { parseMaterialHistoryArchive } from './material-history-zip';
import { encodeMaterialHistoryDag, parseMaterialHistoryDag, MATERIAL_DAG_LIMITS, type MaterialDagManifest, type MaterialDagContents } from './material-history-dag';
import type { MaterialHistoryDagPreview, MaterialHistoryDagRequest, MaterialHistoryDagArchiveResult, MaterialHistoryDagImportPreview, MaterialHistoryDagImportRequest, MaterialHistoryDagImportResult } from '../shared/material-sync';
import type { MaterialHistoryRetainRequest, MaterialHistoryRetainResult, MaterialHistoryReclaimRequest, MaterialHistoryReclaimResult, MaterialHistoryTransportReclaimRequest } from '../shared/material-sync';

const META = '小说资料', TRANSPORT = '创作资料同步', VERSIONS = '版本';
const MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024, MAX_FILES = 10000, MAX_REVISIONS = MATERIAL_HISTORY_LIMIT;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeSchema = z.string().refine(value => isSafeRelative(value) && value.split('/').every(part => !part.startsWith('.')), '资料同步路径不安全');
const entrySchema = z.object({ path: relativeSchema, bytes: z.number().int().min(0).max(MAX_FILE), sha256: hashSchema }).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), revisionId: z.uuid(), createdAt: z.iso.datetime(),
  parents: z.array(z.uuid()).max(MAX_REVISIONS), entries: z.array(entrySchema).max(MAX_FILES) }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), enabled: z.boolean().nullable(),
  base: z.record(relativeSchema, hashSchema), lastRevision: z.uuid().nullable(), lastSyncedAt: z.iso.datetime().optional() }).strict();
const pendingSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), stage: z.string(), archive: z.uuid(), before: hashSchema, after: hashSchema }).strict();
const requestSchema = z.object({ projectId: z.uuid(), fingerprint: hashSchema.optional(), remoteRevision: z.uuid().optional(),
  resolutions: z.array(z.object({ path: relativeSchema, source: z.enum(['local', 'remote']) }).strict()).max(MAX_FILES).optional() }).strict();
const historyRequestSchema = z.object({ projectId: z.uuid(), source: z.enum(['local', 'transport']), id: z.uuid(), path: relativeSchema.optional(), fingerprint: hashSchema.optional() }).strict();
const historyCopySchema = z.object({ projectId: z.uuid(), source: z.enum(['local', 'transport']), id: z.uuid(), fingerprint: hashSchema }).strict();
const historyRetainSchema = z.object({ projectId: z.uuid(), id: z.uuid(), fingerprint: hashSchema }).strict();
const historyReclaimSchema = z.object({ projectId: z.uuid(), id: z.uuid(), fingerprint: hashSchema, confirm: z.literal('回收') }).strict();
const historyTransportReclaimSchema = historyReclaimSchema;
const reclaimRecordSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), id: z.uuid(), files: z.number().int().min(0), bytes: z.number().int().min(0),
  fingerprint: hashSchema, retainedIdentity: z.string(), bookIdentity: z.string(), reclaimedAt: z.iso.datetime() }).strict();
const retentionJournalSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('local-history-retention'),
  projectId: z.uuid(), id: z.uuid(), bookIdentity: hashSchema, treeFingerprint: hashSchema, createdAt: z.iso.datetime() }).strict();
const historyImportSchema = z.object({ projectId: z.uuid(), token: z.uuid(), fingerprint: hashSchema, path: relativeSchema.optional() }).strict();
const historyImportCopySchema = z.object({ projectId: z.uuid(), token: z.uuid(), fingerprint: hashSchema }).strict();
const MAX_IMPORT_ARCHIVE = 80 * 1024 * 1024, MAX_IMPORT_MANIFEST = 8 * 1024 * 1024;
const IMPORT_TICKET_LIFETIME = 15 * 60 * 1000, MAX_IMPORT_TICKETS = 8;
type Entry = z.infer<typeof entrySchema>;
type Manifest = z.infer<typeof manifestSchema>;
type State = z.infer<typeof stateSchema>;
interface Tree { entries: Entry[]; data: Map<string, Buffer>; fingerprint: string }
interface Revision { manifest: Manifest; folder: string }
interface HistoryContext { projectId: string; source: 'local' | 'transport'; id: string; book: string; bookIdentity: string;
  current: Tree; history: Tree; fingerprint: string; folder: string; contentRoot: string | null; canonical: string | null }
interface HistoryImportTicket { projectId: string; token: string; file: string; fingerprint: string; expiresAt: number; consumed: boolean }
interface HistoryImportContext { ticket: HistoryImportTicket; book: string; bookIdentity: string; current: Tree; history: Tree; fingerprint: string;
  archive: Awaited<ReturnType<typeof parseMaterialHistoryArchive>>; completionHash: string }
interface Inspection { snapshot: MaterialSyncSnapshot; state: State; stateRaw: string | null; local: Tree; remote: Tree;
  revisions: Revision[]; leaves: Revision[]; selected?: Revision; canonical: string; versions: string; book: string }
interface DagContext {
  snapshot: MaterialHistoryDagPreview; book: string; bookIdentity: string;
  transport: MaterialDagManifest['transport']; local: MaterialDagManifest['local']; leaves: string[]; blobs: Map<string, Buffer>;
}
interface DagImportPlan {
  directories: string[];
  files: { path: string; bytes: number; sha256: string; data: Buffer }[];
}
interface DagImportContext {
  ticket: HistoryImportTicket; book: string; bookIdentity: string; fingerprint: string;
  archive: MaterialDagContents; completionHash: string; plan: DagImportPlan; preview: MaterialHistoryDagImportPreview;
}
interface DagImportTargetIdentity {
  base: string; root: string; directories: Map<string, string>; files: Map<string, string>;
}
const MAX_DAG_IMPORT_DIRECTORIES = 10000, MAX_DAG_IMPORT_ENTRIES = 20000;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ordered = <T extends { path: string }>(entries: T[]) => entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const dagEntryMetadataBytes = (entry: Entry) => Buffer.byteLength(JSON.stringify(entry, null, 2)) + 80;
const key = (value: string) => value.normalize('NFC').toLowerCase();
const within = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const emptyTree = (): Tree => ({ entries: [], data: new Map(), fingerprint: hash('[]') });
const fromData = (data: Map<string, Buffer>): Tree => {
  const entries = ordered([...data].map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: hash(bytes) })));
  return { data, entries, fingerprint: hash(JSON.stringify(entries)) };
};
async function statOrNull(file: string) { try { return await fs.lstat(file); } catch (error) { if (absent(error)) return null; throw error; } }
async function checkedDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资料同步目录不是普通目录或包含链接，原资料已保留');
  return fs.realpath(directory);
}
/** Counts names only and stops at limit+1. No child, manifest, state or pending journal is read. */
async function historyCapacity(directory: string | null): Promise<MaterialHistoryCapacity> {
  let entries = 0, exact = true;
  if (directory) {
    const before = await statOrNull(directory);
    if (before) {
      await checkedDirectory(directory);
      const stream = await fs.opendir(directory);
      for await (const _entry of stream) {
        if (++entries > MAX_REVISIONS) { exact = false; break; }
      }
      const after = await fs.lstat(directory);
      await checkedDirectory(directory);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw new Error('资料历史目录在容量核对期间变化，请刷新后重试');
    }
  }
  return { entries, exact, remaining: Math.max(0, MAX_REVISIONS - entries),
    level: !exact ? 'over-limit' : entries === MAX_REVISIONS ? 'full' : entries >= MATERIAL_HISTORY_WARNING_AT ? 'warning' : 'normal' };
}
async function rootDirectory(directory: string) {
  if (!await statOrNull(directory)) await fs.mkdir(directory, { recursive: true });
  return checkedDirectory(directory);
}
async function subDirectory(root: string, relative: string, create: boolean) {
  let current = await checkedDirectory(root);
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..' || part.includes('\\') || part.includes(':')) throw new Error('资料同步目录路径无效');
    current = path.join(current, part);
    if (!await statOrNull(current)) {
      if (!create) return null;
      await fs.mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    }
    const real = await checkedDirectory(current);
    if (!within(root, real)) throw new Error('资料同步目录越界');
  }
  return current;
}
async function readRegular(root: string, relative: string, limit: number) {
  relativeSchema.parse(relative);
  const parts = relative.split('/'); let current = await checkedDirectory(root);
  for (let index = 0; index < parts.length - 1; index++) {
    current = path.join(current, parts[index]!); await checkedDirectory(current);
  }
  const file = path.join(current, parts.at(-1)!); const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit || !within(root, await fs.realpath(file))) throw new Error('资料同步文件类型、链接或大小异常');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('资料同步文件读取前发生变化');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length; if (size > limit) throw new Error('资料同步文件读取期间过大'); chunks.push(Buffer.from(chunk));
    }
    const after = await handle.stat(), latest = await fs.lstat(file);
    await checkedDirectory(root);
    if (latest.isSymbolicLink() || !latest.isFile() || before.dev !== latest.dev || before.ino !== latest.ino || before.size !== size
      || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || after.size !== latest.size || after.mtimeMs !== latest.mtimeMs || after.ctimeMs !== latest.ctimeMs)
      throw new Error('资料同步文件读取期间发生变化');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
function checkPaths(entries: Entry[]) {
  const files = new Set<string>(), spellings = new Map<string, string>(); let total = 0;
  for (const entry of entries) {
    relativeSchema.parse(entry.path); const normalized = key(entry.path);
    if (files.has(normalized)) throw new Error('资料同步存在大小写或 Unicode 等价重复路径'); files.add(normalized);
    const parts = entry.path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/'), canonical = key(prefix);
      if (spellings.has(canonical) && spellings.get(canonical) !== prefix) throw new Error('资料同步目录名存在大小写或 Unicode 冲突');
      spellings.set(canonical, prefix);
    }
    total += entry.bytes;
    if (total > MAX_TOTAL) throw new Error('单个资料同步快照超过256 MiB');
  }
  for (const entry of entries) {
    const parts = key(entry.path).split('/');
    for (let n = 1; n < parts.length; n++) if (files.has(parts.slice(0, n).join('/'))) throw new Error('资料同步文件和目录重名');
  }
}
function validateMetadata(data: Buffer, relative: string, projectId: string) {
  if (/(?:^|\/)(?:[^/]*\.(?:tmp|(?:sqlite3?|db)(?:-(?:wal|shm))?|pem|key)|(?:ai-)?connections\.json|credentials\.json|settings\.json)$/iu.test(relative) || relative.split('/').some(part => part.startsWith('~$'))) throw new Error('固定资料目录包含临时文件、数据库或账户配置，同步已停止');
  const belongs = (value: unknown, depth = 0): void => {
    if (depth > 80) throw new Error('资料同步元数据层级过深');
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && 'projectId' in value && (value as { projectId: unknown }).projectId !== projectId) throw new Error('资料同步元数据属于另一部小说');
    for (const child of Object.values(value)) belongs(child, depth + 1);
  };
  if (/\.md$/iu.test(relative)) {
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('资料同步 Markdown 不是有效 UTF-8'); }
    if (/^(?:创作笔记|人物卡|文风档案|创作筹备|故事记忆|正文确认)\.md$/u.test(relative) && !text.startsWith('<!-- novel-writer ')) throw new Error('固定 Markdown 资料缺少小说归属元数据');
    if (text.startsWith('<!-- novel-writer')) {
      const match = /^<!-- novel-writer ([^\r\n]+) -->\r?\n/u.exec(text);
      if (!match) throw new Error('资料同步 Markdown 头损坏');
      let value: any; try { value = JSON.parse(match[1]!); } catch { throw new Error('资料同步 Markdown 元数据损坏'); }
      if (value.schemaVersion !== 1 || value.projectId !== projectId || typeof value.kind !== 'string') throw new Error('资料同步 Markdown 版本或小说归属不匹配');
      belongs(value);
    }
  } else if (/\.json$/iu.test(relative) && !relative.startsWith('character-originals/')) {
    let value: any; try { value = JSON.parse(data.toString('utf8')); } catch { throw new Error('资料同步 JSON 文件损坏'); }
    if (value && typeof value === 'object' && ('projectId' in value || 'schemaVersion' in value)) {
      if (value.schemaVersion !== 1 || value.projectId !== projectId) throw new Error('资料同步 JSON 版本或小说归属不匹配');
      belongs(value);
    }
  }
}
async function scanTree(root: string, projectId: string, budget?: { bytes: number; files: number; metadataBytes?: number }): Promise<Tree> {
  if (!await statOrNull(root)) return emptyTree();
  await checkedDirectory(root); const data = new Map<string, Buffer>(); let count = 0, bytes = 0, metadataBytes = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 30) throw new Error('资料同步目录层级过深'); await checkedDirectory(directory);
    // DAG scans may encounter a very large hostile directory. Stream its names
    // so the entry budget is enforced before allocating a full directory list.
    const items = budget ? await fs.opendir(directory) : await fs.readdir(directory, { withFileTypes: true });
    for await (const item of items) {
      if (++count > MAX_FILES) throw new Error('资料同步条目超过10000个');
      const file = path.join(directory, item.name), relative = path.relative(root, file).split(path.sep).join('/'); relativeSchema.parse(relative);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('资料同步源包含目录链接或符号链接');
      if (stat.isDirectory()) {
        const before = data.size; await walk(file, depth + 1);
        // The v1 complete-history format records files but not nested empty
        // directories. Refuse to call the export complete if one would be lost.
        if (budget && data.size === before) throw new Error('完整历史含未记录的空目录，未生成归档；原历史已保留');
        continue;
      }
      if (budget && (data.size >= budget.files || stat.size > budget.bytes - bytes)) throw new Error('完整历史归档的文件引用数量或读取大小超过上限');
      if (budget?.metadataBytes !== undefined) {
        metadataBytes += dagEntryMetadataBytes({ path: relative, bytes: stat.size, sha256: '0'.repeat(64) });
        if (metadataBytes > budget.metadataBytes) throw new Error('完整历史清单超过8 MiB');
      }
      const content = await readRegular(root, relative, budget ? Math.min(MAX_FILE, budget.bytes - bytes) : MAX_FILE); validateMetadata(content, relative, projectId);
      bytes += content.length; if (bytes > MAX_TOTAL) throw new Error('资料同步总量超过256 MiB'); data.set(relative, content);
    }
  };
  await walk(root, 0); const result = fromData(data); checkPaths(result.entries); return result;
}
/** Bind all directory identities as well as contents; a file-only fingerprint
 * cannot detect replaced or nested empty directories. The complete DAG v1
 * cannot encode nested empty directories, so retention refuses those. */
async function retentionTree(root: string, projectId: string) {
  const inventory: { path: string; type: string; dev: number; ino: number; size?: number; mtime?: number; ctime?: number }[] = [];
  let count = 0;
  const walk = async (directory: string, relative: string, depth: number) => {
    if (depth > 30) throw new Error('本机历史目录层级过深');
    await checkedDirectory(directory); const before = await fs.lstat(directory);
    inventory.push({ path: relative, type: 'dir', dev: before.dev, ino: before.ino,
      ...(relative ? { mtime: before.mtimeMs, ctime: before.ctimeMs } : {}) });
    for await (const item of await fs.opendir(directory)) {
      if (++count > MAX_FILES) throw new Error('本机历史目录条目超过10000个');
      const child = relative ? `${relative}/${item.name}` : item.name; relativeSchema.parse(child);
      const file = path.join(directory, item.name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('本机历史包含目录链接或符号链接');
      if (stat.isDirectory()) await walk(file, child, depth + 1);
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('本机历史包含硬链接或非普通文件');
        inventory.push({ path: child, type: 'file', dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
      }
    }
    const after = await fs.lstat(directory); await checkedDirectory(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('本机历史目录在核对期间变化');
  };
  const snapshot = async () => {
    inventory.length = 0; count = 0; await walk(root, '', 0);
    return [...inventory].sort((a, b) => a.path.localeCompare(b.path));
  };
  const before = await snapshot();
  const tree = await scanTree(root, projectId, { bytes: MAX_TOTAL, files: MAX_FILES, metadataBytes: MATERIAL_DAG_LIMITS.manifestBytes });
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('本机历史在核对期间变化，请重新预览');
  return { fingerprint: hash(JSON.stringify({ inventory: before, entries: tree.entries })), tree };
}
function preview(data: Buffer | undefined, relative: string) {
  if (!data || !/\.(?:md|txt|json)$/iu.test(relative)) return undefined;
  return data.toString('utf8').slice(0, 1600);
}
function historyText(data: Buffer | undefined, relative: string) {
  if (!data || !/\.(?:md|txt|json)$/iu.test(relative)) return { text: undefined, truncated: false };
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return { text: undefined, truncated: false }; }
  const truncated = text.length > 16000; let end = Math.min(text.length, 16000);
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  return { text: text.slice(0, end), truncated };
}

/** Canonical author files remain in the application's fixed per-project directory.
 * Book-local revisions are immutable transport snapshots, never the live store. The
 * caller must hold its IPC/AI barrier while synchronizing; file hashes additionally
 * detect external changes. No watcher, SQLite database or credential is transported. */
export class MaterialSyncService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly historyImportTickets = new Map<string, HistoryImportTicket>();
  private readonly dagImportTickets = new Map<string, HistoryImportTicket>();
  constructor(private readonly workspace: Workspace, private readonly materialsRoot: string, private readonly userData: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  private project(projectId: string) { return this.workspace.getProject(z.uuid().parse(projectId)); }
  private retentionJournal(projectId: string) { return path.join(this.userData, 'material-sync', `${projectId}-retention.json`); }
  private syncPending(projectId: string) { return path.join(this.userData, 'material-sync', `${projectId}-pending.json`); }
  private async noSyncPending(projectId: string) {
    if (await statOrNull(this.syncPending(projectId))) throw new Error('资料同步换入记录尚未处理，本机历史不能移动或恢复，原件均保留');
  }
  private async stateLocation(projectId: string) {
    const base = await rootDirectory(this.userData); return path.join((await subDirectory(base, 'material-sync', true))!, `${projectId}.json`);
  }
  private async readState(projectId: string) {
    const file = await this.stateLocation(projectId); if (!await statOrNull(file)) return { state: { schemaVersion: 1, projectId, enabled: null, base: {}, lastRevision: null } as State, raw: null };
    const raw = (await readRegular(path.dirname(file), path.basename(file), 2 * 1024 * 1024)).toString('utf8');
    let state: State; try { state = stateSchema.parse(JSON.parse(raw)); } catch { throw new Error('本机资料同步状态损坏或版本不受支持，原状态已保留'); }
    if (state.projectId !== projectId) throw new Error('本机资料同步状态属于另一部小说');
    checkPaths(Object.entries(state.base).map(([relative, sha256]) => ({ path: relative, sha256, bytes: 0 })));
    return { state, raw };
  }
  private async writeState(projectId: string, state: State, expectedRaw: string | null) {
    stateSchema.parse(state); const file = await this.stateLocation(projectId);
    const current = await this.readState(projectId); if (current.raw !== expectedRaw) throw new Error('本机资料同步状态已在外部变化，原状态已保留');
    const temporary = path.join(path.dirname(file), `sync-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx' });
    if ((await this.readState(projectId)).raw !== expectedRaw) throw new Error('本机资料同步状态保存期间变化，暂存已保留');
    await checkedDirectory(path.dirname(file)); await fs.rename(temporary, file);
  }
  private async recoverPending(projectId: string) {
    if (await statOrNull(this.retentionJournal(projectId))) throw new Error('本机历史保留记录尚未核对，请先打开资料历史，原件均保留');
    const directory = path.dirname(await this.stateLocation(projectId)), filename = `${projectId}-pending.json`, file = path.join(directory, filename);
    if (!await statOrNull(file)) return;
    const raw = (await readRegular(directory, filename, 16384)).toString('utf8'); let pending: z.infer<typeof pendingSchema>;
    try { pending = pendingSchema.parse(JSON.parse(raw)); } catch { throw new Error('资料同步换入记录损坏，原件和暂存已保留，请检查同步历史'); }
    if (pending.projectId !== projectId || !pending.stage.startsWith(`sync-stage-${projectId}-`)) throw new Error('资料同步换入记录归属不匹配');
    z.uuid().parse(pending.stage.slice(`sync-stage-${projectId}-`.length));
    const base = await rootDirectory(this.materialsRoot), canonical = path.join(base, projectId), stage = path.join(base, pending.stage);
    const history = await subDirectory(base, `同步历史/${projectId}`, false), archive = history ? path.join(history, pending.archive) : '';
    const hasStage = Boolean(await statOrNull(stage)), hasArchive = Boolean(archive && await statOrNull(archive));
    if (hasStage && (await scanTree(stage, projectId)).fingerprint !== pending.after) throw new Error('资料同步暂存已发生变化，未自动恢复，原件均保留');
    if (hasArchive && (await scanTree(archive, projectId)).fingerprint !== pending.before) throw new Error('资料同步历史已发生变化，未自动恢复，原件均保留');
    if (!await statOrNull(canonical)) {
      if (hasArchive) await fs.rename(archive, canonical); // Restore the original directory after an interrupted swap.
      else if (pending.before === emptyTree().fingerprint && hasStage) await fs.rename(stage, canonical);
      else throw new Error('上次资料同步换入未完成，请从同步历史恢复原件；未覆盖任何资料');
    }
    const current = (await scanTree(canonical, projectId)).fingerprint;
    if (current !== pending.before && current !== pending.after) throw new Error('资料同步中断后本机资料又发生变化，请核对同步历史，原件均保留');
    if ((await readRegular(directory, filename, 16384)).toString('utf8') !== raw) throw new Error('资料同步恢复记录已变化');
    await fs.unlink(file); // Only this checked local journal; author files and stages are retained.
  }
  private async bookLocations(projectId: string, create: boolean) {
    const book = await checkedDirectory(this.project(projectId).root);
    const meta = await subDirectory(book, META, false); if (!meta) throw new Error('本书归属资料缺失');
    let value: any; try { value = JSON.parse((await readRegular(meta, 'project.json', 1024 * 1024)).toString('utf8')); } catch { throw new Error('本书归属资料损坏'); }
    if (value.schemaVersion !== 1 || value.id !== projectId) throw new Error('本书归属已变化，资料同步已停止');
    const versions = await subDirectory(book, `${META}/${TRANSPORT}/${VERSIONS}`, create);
    return { book, versions: versions ?? path.join(book, META, TRANSPORT, VERSIONS) };
  }
  private async readRevisions(versions: string, projectId: string): Promise<Revision[]> {
    if (!await statOrNull(versions)) return [];
    await checkedDirectory(versions); const revisions: Revision[] = []; const names = await fs.readdir(versions);
    if (names.length > MAX_REVISIONS) throw new Error('资料同步目录超过1000个条目，已停止读取；请保留完整历史与父版本，ZIP留档不会释放版本名额');
    for (const name of names) {
      z.uuid().parse(name); const folder = path.join(versions, name); await checkedDirectory(folder);
      const file = path.join(folder, 'manifest.json'); if (!await statOrNull(file)) continue; // A partial upload has no committed manifest.
      let manifest: Manifest;
      try { manifest = manifestSchema.parse(JSON.parse((await readRegular(folder, 'manifest.json', 2 * 1024 * 1024)).toString('utf8'))); }
      catch { throw new Error('远端资料同步清单损坏或版本不受支持，原资料已保留'); }
      if (manifest.projectId !== projectId || manifest.revisionId !== name) throw new Error('远端资料同步版本的小说归属或 ID 不匹配');
      if (new Set(manifest.parents).size !== manifest.parents.length || manifest.parents.includes(name)) throw new Error('远端资料同步版本父关系重复或成环');
      checkPaths(manifest.entries); revisions.push({ manifest, folder });
    }
    const map = new Map(revisions.map(revision => [revision.manifest.revisionId, revision]));
    const seen = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('远端资料同步版本关系成环'); if (seen.has(id)) return;
      const item = map.get(id); if (!item) throw new Error('远端资料同步历史尚未传输完整，请等待文件同步完成');
      visiting.add(id); for (const parent of item.manifest.parents) visit(parent); visiting.delete(id); seen.add(id);
    };
    for (const id of map.keys()) visit(id); return revisions.sort((a, b) => a.manifest.revisionId < b.manifest.revisionId ? -1 : 1);
  }
  private async readRevision(revision: Revision, projectId: string) {
    const root = await subDirectory(revision.folder, 'files', false); const data = new Map<string, Buffer>();
    if (!root && revision.manifest.entries.length) throw new Error('远端资料同步版本文件未传输完整');
    for (const entry of revision.manifest.entries) {
      const bytes = await readRegular(root!, entry.path, MAX_FILE);
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error('远端资料同步版本文件哈希不匹配，请等待完整传输');
      validateMetadata(bytes, entry.path, projectId); data.set(entry.path, bytes);
    }
    return fromData(data);
  }
  private historyDirectory(projectId: string) { return path.join(this.materialsRoot, '同步历史', projectId); }
  private async bookIdentity(projectId: string, book: string) {
    const stat = await fs.lstat(book); await checkedDirectory(book);
    const meta = await subDirectory(book, META, false); if (!meta) throw new Error('本书归属资料缺失');
    const projectRaw = await readRegular(meta, 'project.json', 1024 * 1024);
    let project: any; try { project = JSON.parse(projectRaw.toString('utf8')); } catch { throw new Error('本书归属资料损坏'); }
    if (project.schemaVersion !== 1 || project.id !== projectId) throw new Error('本书归属已变化，资料历史操作已停止');
    return hash(JSON.stringify({ book, dev: stat.dev, ino: stat.ino, project: hash(projectRaw) }));
  }
  private async resolveRetentionJournal(projectId: string, book: string, bookIdentity: string, active: string | null, retained: string | null) {
    const file = this.retentionJournal(projectId), stat = await statOrNull(file);
    if (!stat) return;
    await this.noSyncPending(projectId);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('本机历史保留记录类型异常，原件均保留');
    const directory = path.dirname(file), name = path.basename(file);
    await checkedDirectory(directory);
    const raw = await readRegular(directory, name, 16384);
    let journal: z.infer<typeof retentionJournalSchema>;
    try { journal = retentionJournalSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
    catch { throw new Error('本机历史保留记录损坏或版本不受支持，原件均保留'); }
    if (journal.projectId !== projectId || journal.bookIdentity !== bookIdentity) throw new Error('本机历史保留记录归属不匹配，原件均保留');
    const activeIdentity = active ? await this.dagDirectoryIdentity(active) : null, retainedIdentity = retained ? await this.dagDirectoryIdentity(retained) : null;
    const source = active ? path.join(active, journal.id) : null, target = retained ? path.join(retained, journal.id) : null;
    const sourceExists = !!(source && await statOrNull(source)), targetExists = !!(target && await statOrNull(target));
    if (sourceExists === targetExists) throw new Error('本机历史保留中断后两侧同时存在或均不存在，原件和记录均保留');
    const selected = sourceExists ? source! : target!;
    if ((await retentionTree(selected, projectId)).fingerprint !== journal.treeFingerprint) throw new Error('本机历史保留中断后内容或目录已变化，原件和记录均保留');
    await this.noSyncPending(projectId);
    if (await this.bookIdentity(projectId, book) !== bookIdentity) throw new Error('本书归属在保留恢复期间变化');
    if (!!(source && await statOrNull(source)) !== sourceExists || !!(target && await statOrNull(target)) !== targetExists
      || (await retentionTree(selected, projectId)).fingerprint !== journal.treeFingerprint) throw new Error('本机历史保留恢复期间变化，记录和原件均保留');
    await this.noSyncPending(projectId);
    const root = await checkedDirectory(this.materialsRoot), activeAgain = await subDirectory(root, `同步历史/${projectId}`, false), retainedAgain = await subDirectory(root, `同步历史保留/${projectId}`, false);
    if (activeAgain !== active || retainedAgain !== retained
      || (activeAgain && await this.dagDirectoryIdentity(activeAgain)) !== activeIdentity
      || (retainedAgain && await this.dagDirectoryIdentity(retainedAgain)) !== retainedIdentity)
      throw new Error('本机历史目录在保留恢复期间出现、消失或变化，记录和原件均保留');
    const latest = await fs.lstat(file);
    if (latest.isSymbolicLink() || !latest.isFile() || latest.nlink !== 1 || latest.dev !== stat.dev || latest.ino !== stat.ino
      || !(await readRegular(directory, name, 16384)).equals(raw)) throw new Error('本机历史保留记录在核对期间变化');
    await fs.unlink(file);
  }
  /** History reads intentionally do not inspect synchronization state or replay a
   * pending canonical swap. They remain available while sharing is disabled. */
  private async historyLocations(projectId: string, recoverRetention = false) {
    const locations = await this.bookLocations(projectId, false), bookIdentity = await this.bookIdentity(projectId, locations.book);
    const base = await statOrNull(this.materialsRoot) ? await checkedDirectory(this.materialsRoot) : null;
    const localHistory = base ? await subDirectory(base, `同步历史/${projectId}`, false) : null;
    const retainedHistory = base ? await subDirectory(base, `同步历史保留/${projectId}`, false) : null;
    const canonical = base ? await subDirectory(base, projectId, false) : null;
    if (await statOrNull(this.retentionJournal(projectId))) {
      if (!recoverRetention) throw new Error('本机历史保留记录尚未核对，请先打开资料历史，原件均保留');
      await this.resolveRetentionJournal(projectId, locations.book, bookIdentity, localHistory, retainedHistory);
    }
    return { ...locations, bookIdentity, localHistory, retainedHistory, canonical };
  }
  history(projectId: string): Promise<MaterialHistorySnapshot> {
    const id = z.uuid().parse(projectId); this.project(id);
    return this.serial(async () => {
      const locations = await this.historyLocations(id, true), versions: MaterialHistoryVersion[] = [];
      const local = await this.localInventories(locations.localHistory, locations.retainedHistory);
      for (const [root, names, location] of [[locations.localHistory, local.active.names, 'active'], [locations.retainedHistory, local.retained.names, 'retained']] as const) {
        if (root) for (const name of names) {
          const folder = path.join(root, name); await checkedDirectory(folder);
          const stat = await fs.lstat(folder);
          versions.push({ source: 'local', location, id: name, createdAt: stat.mtime.toISOString(), files: null, bytes: null });
        }
      }
      for (const revision of await this.readRevisions(locations.versions, id)) {
        versions.push({ source: 'transport', id: revision.manifest.revisionId, createdAt: revision.manifest.createdAt,
          files: revision.manifest.entries.length, bytes: revision.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) });
      }
      versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
      return { schemaVersion: 1, projectId: id, versions };
    });
  }
  /** Advisory read only: available even when history listing exceeds its safety limit. */
  capacity(projectId: string): Promise<MaterialHistoryCapacitySnapshot> {
    const id = z.uuid().parse(projectId); this.project(id);
    return this.serial(async () => {
      const locations = await this.historyLocations(id);
      const local = await historyCapacity(locations.localHistory), transport = await historyCapacity(locations.versions);
      if ((await this.historyLocations(id)).bookIdentity !== locations.bookIdentity)
        throw new Error('本书归属在容量核对期间变化，未返回历史容量');
      return { schemaVersion: 1, projectId: id, checkedAt: new Date().toISOString(), limit: MAX_REVISIONS,
        warningAt: MATERIAL_HISTORY_WARNING_AT, local, transport };
    });
  }
  /** Exact, bounded root inventories, including uncommitted folders. No source is skipped. */
  private async dagInventory(directory: string | null) {
    if (!directory || !await statOrNull(directory)) return { identity: null, names: [] as string[] };
    const identity = await this.dagDirectoryIdentity(directory), names: string[] = [];
    for await (const item of await fs.opendir(directory)) {
      if (names.length >= MAX_REVISIONS) throw new Error('完整历史归档目录超过1000个条目，未生成归档');
      z.uuid().parse(item.name); names.push(item.name);
    }
    names.sort();
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('完整历史目录包含大小写等价的重复版本ID');
    if (await this.dagDirectoryIdentity(directory) !== identity) throw new Error('完整历史目录在读取期间变化，请重新核对');
    return { identity, names };
  }
  private async localInventories(active: string | null, retained: string | null) {
    const first = await this.dagInventory(active), second = await this.dagInventory(retained);
    const all = [...first.names, ...second.names];
    if (all.length > MATERIAL_DAG_LIMITS.localVersions || new Set(all.map(name => name.toLowerCase())).size !== all.length)
      throw new Error('本机历史活动区与保留区ID重复或超出2000条，未跳过任何历史');
    return { active: first, retained: second };
  }
  retainHistory(input: MaterialHistoryRetainRequest): Promise<MaterialHistoryRetainResult> {
    const request = historyRetainSchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      await this.noSyncPending(request.projectId);
      const initial = await this.inspectHistory({ projectId: request.projectId, source: 'local', id: request.id, fingerprint: request.fingerprint });
      let locations = await this.historyLocations(request.projectId);
      let inventory = await this.localInventories(locations.localHistory, locations.retainedHistory);
      if (!locations.localHistory || !inventory.active.names.includes(request.id) || inventory.retained.names.some(name => name.toLowerCase() === request.id.toLowerCase()))
        throw new Error('所选本机历史不在活动区或保留区已有同名记录');
      if (inventory.retained.names.length >= MAX_REVISIONS) throw new Error('本机历史保留区已满，未移动或删除历史');
      const root = await rootDirectory(this.materialsRoot), retainedRoot = (await subDirectory(root, `同步历史保留/${request.projectId}`, true))!;
      locations = await this.historyLocations(request.projectId);
      inventory = await this.localInventories(locations.localHistory, locations.retainedHistory);
      if (!locations.localHistory || locations.retainedHistory !== retainedRoot || inventory.retained.names.length >= MAX_REVISIONS) throw new Error('本机历史目录或容量已变化');
      await this.inspectHistory({ projectId: request.projectId, source: 'local', id: request.id, fingerprint: request.fingerprint });
      const source = (await subDirectory(locations.localHistory, request.id, false))!, target = path.join(retainedRoot, request.id);
      if (!source || await statOrNull(target)) throw new Error('本机历史源或目标目录已变化，未移动历史');
      const frozen = await retentionTree(source, request.projectId), sourceParentIdentity = await this.dagDirectoryIdentity(locations.localHistory), targetParentIdentity = await this.dagDirectoryIdentity(retainedRoot);
      const canonicalIdentity = locations.canonical ? await this.dagDirectoryIdentity(locations.canonical) : null;
      await this.noSyncPending(request.projectId);
      if (await this.bookIdentity(request.projectId, locations.book) !== initial.bookIdentity) throw new Error('本书归属已变化');
      const file = this.retentionJournal(request.projectId), state = await this.stateLocation(request.projectId); await checkedDirectory(path.dirname(state));
      const journal = { schemaVersion: 1 as const, kind: 'local-history-retention' as const, projectId: request.projectId, id: request.id,
        bookIdentity: initial.bookIdentity, treeFingerprint: frozen.fingerprint, createdAt: new Date().toISOString() };
      const handle = await fs.open(file, 'wx');
      try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
      // After recording intent, any ambiguous state leaves the record and all
      // source files intact for explicit recovery; the destination is checked
      // immediately before rename, without claiming external-process CAS.
      await this.noSyncPending(request.projectId);
      if ((await retentionTree(source, request.projectId)).fingerprint !== frozen.fingerprint)
        throw new Error('本机历史移动前内容已变化，原件和记录均保留');
      const activeAgain = await subDirectory(root, `同步历史/${request.projectId}`, false), retainedAgain = await subDirectory(root, `同步历史保留/${request.projectId}`, false), canonicalAgain = await subDirectory(root, request.projectId, false);
      if (activeAgain !== locations.localHistory || retainedAgain !== retainedRoot || canonicalAgain !== locations.canonical
        || await this.dagDirectoryIdentity(locations.localHistory) !== sourceParentIdentity
        || await this.dagDirectoryIdentity(retainedRoot) !== targetParentIdentity
        || (canonicalAgain ? await scanTree(canonicalAgain, request.projectId) : emptyTree()).fingerprint !== initial.current.fingerprint
        || (canonicalAgain ? await this.dagDirectoryIdentity(canonicalAgain) : null) !== canonicalIdentity
        || await this.bookIdentity(request.projectId, locations.book) !== initial.bookIdentity || await statOrNull(target))
        throw new Error('本机历史移动前目录或内容已变化，原件和记录均保留');
      // Book/canonical checks above involve awaits. Re-read the frozen source
      // afterwards so an external edit during those checks cannot be moved on
      // the strength of the earlier scan. Ordinary rename is not a cross-
      // process compare-and-swap; ambiguous outcomes keep the journal.
      if ((await retentionTree(source, request.projectId)).fingerprint !== frozen.fingerprint || await statOrNull(target))
        throw new Error('本机历史移动前内容或目标已变化，原件和记录均保留');
      await fs.rename(source, target);
      await this.resolveRetentionJournal(request.projectId, locations.book, initial.bookIdentity, locations.localHistory, retainedRoot);
      return { schemaVersion: 1, projectId: request.projectId, id: request.id, location: 'retained', files: frozen.tree.entries.length,
        bytes: frozen.tree.entries.reduce((sum, entry) => sum + entry.bytes, 0) };
    });
  }
  private reclaimLog(projectId: string) { return path.join(this.userData, 'material-sync', `${projectId}-reclaims.json`); }
  /** 回收记录只写在应用数据目录，不进入书内目录；读取失败时拒绝继续，避免覆盖旧记录。 */
  private async appendReclaimRecord(projectId: string, record: z.infer<typeof reclaimRecordSchema>) {
    const file = this.reclaimLog(projectId); await fs.mkdir(path.dirname(file), { recursive: true });
    let records: unknown[] = [];
    if (await statOrNull(file)) {
      const raw = (await readRegular(path.dirname(file), path.basename(file), 4 * 1024 * 1024)).toString('utf8');
      const parsed = z.array(reclaimRecordSchema).max(500).parse(JSON.parse(raw));
      if (parsed.some(item => item.id === record.id)) throw new Error('该历史已有回收记录');
      records = parsed;
    }
    // 记录条数有上限：超过 500 条时丢最旧的，而不是让第 501 次回收在删除成功后报写入失败。
    if (records.length >= 500) records.shift();
    records.push(record);
    const temporary = path.join(path.dirname(file), `reclaims-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(records, null, 2), { flag: 'wx' });
    await checkedDirectory(path.dirname(file)); await fs.rename(temporary, file);
  }
  /** 回收保留区历史：释放磁盘，但绝不动活动区、书内传输版本和完整ZIP归档。
   * 普通文件系统没有跨进程原子删除，删除前后各复核一次身份与内容。 */
  reclaimHistory(input: MaterialHistoryReclaimRequest): Promise<MaterialHistoryReclaimResult> {
    const request = historyReclaimSchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      await this.noSyncPending(request.projectId);
      for (const ticket of [...this.historyImportTickets.values(), ...this.dagImportTickets.values()]) {
        if (ticket.projectId === request.projectId && !ticket.consumed) throw new Error('有未完成的资料历史导入，已停止回收');
      }
      const locations = await this.historyLocations(request.projectId, true);
      const inventory = await this.localInventories(locations.localHistory, locations.retainedHistory);
      if (inventory.active.names.some(name => name.toLowerCase() === request.id.toLowerCase()))
        throw new Error('活动区的历史不能直接回收；请先确认为保留区，或另存完整归档');
      if (!locations.retainedHistory || !inventory.retained.names.includes(request.id))
        throw new Error('所选历史不在保留区，未删除任何文件');
      // 用与预览一致的指纹语义复核（含书籍归属、目录身份与当前资料），
      // 再用 retentionTree 额外拒绝链接、硬链接与嵌套空目录。
      const context = await this.inspectHistory({ projectId: request.projectId, source: 'local', id: request.id, fingerprint: request.fingerprint });
      // 与传输回收一致：本机上次同步的基线版本（同 ID）不能删，否则完整历史与后续同步都会缺基线。
      const state = await this.readState(request.projectId);
      if (state.state.lastRevision === request.id) throw new Error('该历史是本机上次同步的基线，回收会让后续同步与完整历史缺基线；请先完成一次新同步再回收');
      const target = context.folder;
      const frozen = await retentionTree(target, request.projectId);
      // 父版本保护：任何传输版本把它当作父版本时，删除会破坏完整历史的DAG。
      // 只读各版本自己的清单（未完成传输没有清单时跳过），不要求整份文件齐全。
      for (const parent of await this.revisionParents(locations.versions, request.projectId)) {
        if (parent === request.id) throw new Error('该历史仍是其他版本的父版本，不能回收');
      }
      const retainedIdentity = await this.dagDirectoryIdentity(locations.retainedHistory);
      const bookIdentity = await this.bookIdentity(request.projectId, locations.book);
      if ((await retentionTree(target, request.projectId)).fingerprint !== frozen.fingerprint)
        throw new Error('回收前历史内容已变化，未删除任何文件');
      if (await this.dagDirectoryIdentity(locations.retainedHistory) !== retainedIdentity
        || await this.bookIdentity(request.projectId, locations.book) !== bookIdentity)
        throw new Error('回收前目录或书籍归属已变化，未删除任何文件');
      await fs.rm(target, { recursive: true });
      const record = { schemaVersion: 1 as const, projectId: request.projectId, id: request.id,
        files: frozen.tree.entries.length, bytes: frozen.tree.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        fingerprint: frozen.fingerprint, retainedIdentity, bookIdentity, reclaimedAt: new Date().toISOString() };
      try { await this.appendReclaimRecord(request.projectId, record); }
      catch { throw new Error('历史文件已回收，但回收记录写入失败；请在应用数据目录核对 material-sync 记录'); }
      return { schemaVersion: 1, projectId: request.projectId, id: request.id, files: record.files, bytes: record.bytes, reclaimedAt: record.reclaimedAt };
    });
  }
  /** 回收书内传输历史的一个叶子版本：释放磁盘与名额，但拒绝删除仍是其他版本父版本的条目。 */
  reclaimTransportHistory(input: MaterialHistoryTransportReclaimRequest): Promise<MaterialHistoryReclaimResult> {
    const request = historyTransportReclaimSchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      await this.noSyncPending(request.projectId);
      for (const ticket of [...this.historyImportTickets.values(), ...this.dagImportTickets.values()]) {
        if (ticket.projectId === request.projectId && !ticket.consumed) throw new Error('有未完成的资料历史导入，已停止回收');
      }
      const locations = await this.bookLocations(request.projectId, false);
      const context = await this.inspectHistory({ projectId: request.projectId, source: 'transport', id: request.id, fingerprint: request.fingerprint });
      for (const parent of await this.revisionParents(locations.versions, request.projectId)) {
        if (parent === request.id) throw new Error('该传输版本仍是其他版本的父版本，不能回收');
      }
      // 本机上次同步的基线版本不能回收：删掉后 synchronize 会因基线缺失直接失败。
      const state = await this.readState(request.projectId);
      if (state.state.lastRevision === request.id) throw new Error('该传输版本是本机上次同步的基线，回收会让后续同步无法继续；请先完成一次新同步再回收');
      const folder = context.folder;
      const manifestHash = hash(await readRegular(folder, 'manifest.json', 2 * 1024 * 1024));
      const parentIdentity = await this.dagDirectoryIdentity(locations.versions);
      const bookIdentity = await this.bookIdentity(request.projectId, locations.book);
      // 删除前再核对一次清单与父目录身份：普通文件系统没有跨进程原子删除。
      if (hash(await readRegular(folder, 'manifest.json', 2 * 1024 * 1024)) !== manifestHash
        || await this.dagDirectoryIdentity(locations.versions) !== parentIdentity
        || await this.bookIdentity(request.projectId, locations.book) !== bookIdentity)
        throw new Error('回收前传输版本或目录已变化，未删除任何文件');
      await this.inspectHistory({ projectId: request.projectId, source: 'transport', id: request.id, fingerprint: request.fingerprint });
      await fs.rm(folder, { recursive: true });
      const record = { schemaVersion: 1 as const, projectId: request.projectId, id: request.id,
        files: context.history.entries.length, bytes: context.history.entries.reduce((sum, entry) => sum + entry.bytes, 0),
        fingerprint: context.fingerprint, retainedIdentity: parentIdentity, bookIdentity, reclaimedAt: new Date().toISOString() };
      try { await this.appendReclaimRecord(request.projectId, record); }
      catch { throw new Error('传输历史已回收，但回收记录写入失败；请在应用数据目录核对 material-sync 记录'); }
      return { schemaVersion: 1, projectId: request.projectId, id: request.id, files: record.files, bytes: record.bytes, reclaimedAt: record.reclaimedAt };
    });
  }
  /** 只读传输清单里的父版本关系：未完成传输（没有清单）跳过，清单损坏或归属不符则停止回收。 */
  private async revisionParents(versions: string, projectId: string) {
    if (!await statOrNull(versions)) return [] as string[];
    await checkedDirectory(versions);
    const names = await fs.readdir(versions);
    if (names.length > MAX_REVISIONS) throw new Error('资料同步目录超过1000个条目，已停止回收历史');
    const parents: string[] = [];
    for (const name of names) {
      z.uuid().parse(name);
      const folder = path.join(versions, name), stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (!await statOrNull(path.join(folder, 'manifest.json'))) continue;
      let manifest: Manifest;
      try { manifest = manifestSchema.parse(JSON.parse((await readRegular(folder, 'manifest.json', 2 * 1024 * 1024)).toString('utf8'))); }
      catch { throw new Error('资料同步清单损坏，无法确认历史占用，已停止回收'); }
      if (manifest.projectId !== projectId) throw new Error('资料同步清单归属不匹配，已停止回收');
      parents.push(...manifest.parents);
    }
    return parents;
  }  private async dagDirectoryIdentity(directory: string) {
    const real = await checkedDirectory(directory), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('完整历史归档目录身份异常');
    return JSON.stringify({ real, dev: stat.dev, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
  }
  private async inspectHistoryDag(projectId: string): Promise<DagContext> {
    const locations = await this.historyLocations(projectId);
    const localInventory = await this.localInventories(locations.localHistory, locations.retainedHistory), transportInventory = await this.dagInventory(locations.versions);
    if (!localInventory.active.names.length && !localInventory.retained.names.length && !transportInventory.names.length) throw new Error('暂无可完整归档的资料历史');
    const transport: MaterialDagManifest['transport'] = [], local: MaterialDagManifest['local'] = [];
    const blobs = new Map<string, Buffer>(), revisions: { id: string; folder: string; manifest: Manifest; raw: Buffer; identity: string }[] = [];
    const identities: unknown[] = []; let rawBytes = 0, referencedBytes = 0, references = 0, uniqueBytes = 0, localMetadataBytes = 0;
    const add = (data: Buffer) => {
      const sha256 = hash(data);
      if (!blobs.has(sha256)) {
        if (blobs.size >= MATERIAL_DAG_LIMITS.blobs || uniqueBytes + data.length > MATERIAL_DAG_LIMITS.contentBytes)
          throw new Error('完整历史归档的去重原文超过64 MiB或对象数量超过上限');
        blobs.set(sha256, data); uniqueBytes += data.length;
      }
      return sha256;
    };
    // Read and account for every raw manifest before loading any transport payload.
    for (const id of transportInventory.names) {
      const folder = (await subDirectory(locations.versions, id, false))!;
      if (!folder) throw new Error('完整历史传输版本在读取期间消失');
      const identity = await this.dagDirectoryIdentity(folder), children: string[] = [];
      for await (const child of await fs.opendir(folder)) {
        if (children.length >= 2 || (child.name !== 'manifest.json' && child.name !== 'files'))
          throw new Error('历史传输目录包含未声明文件或目录，未生成完整归档');
        children.push(child.name);
      }
      if (!children.includes('manifest.json')) throw new Error('存在未完成传输的历史目录，请等待完整传输后再归档');
      const raw = await readRegular(folder, 'manifest.json', Math.min(2 * 1024 * 1024, MATERIAL_DAG_LIMITS.rawManifestBytes - rawBytes));
      rawBytes += raw.length;
      let manifest: Manifest;
      try { manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw))); }
      catch { throw new Error('完整历史清单损坏或版本不受支持'); }
      if (manifest.projectId !== projectId || manifest.revisionId !== id) throw new Error('完整历史版本的小说归属或ID不匹配');
      checkPaths(manifest.entries);
      references += 1 + manifest.entries.length; referencedBytes += raw.length + manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
      if (references > MATERIAL_DAG_LIMITS.references || referencedBytes > MATERIAL_DAG_LIMITS.referencedBytes)
        throw new Error('完整历史归档的文件引用超过10000或引用内容超过256 MiB');
      transport.push({ id, manifestSha256: add(raw) }); revisions.push({ id, folder, manifest, raw, identity });
    }
    const byId = new Map(revisions.map(item => [item.id, item])), visiting = new Set<string>(), done = new Set<string>(), parents = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('完整历史的父版本关系成环'); if (done.has(id)) return;
      const item = byId.get(id); if (!item) throw new Error('完整历史缺少父版本，请等待完整传输');
      const list = item.manifest.parents;
      if (new Set(list).size !== list.length || list.includes(id)) throw new Error('完整历史父版本重复或成环');
      visiting.add(id); for (const parent of list) { parents.add(parent); visit(parent); } visiting.delete(id); done.add(id);
    };
    for (const id of byId.keys()) visit(id);
    const leaves = transportInventory.names.filter(id => !parents.has(id));
    for (const revision of revisions) {
      const files = await subDirectory(revision.folder, 'files', false);
      const filesIdentity = files ? await this.dagDirectoryIdentity(files) : null;
      const tree = files ? await scanTree(files, projectId, { bytes: revision.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0), files: revision.manifest.entries.length }) : emptyTree();
      if (JSON.stringify(tree.entries) !== JSON.stringify(ordered([...revision.manifest.entries]))) throw new Error('历史版本文件与清单不匹配，未生成完整归档');
      for (const data of tree.data.values()) add(data);
      if (hash(await readRegular(revision.folder, 'manifest.json', 2 * 1024 * 1024)) !== hash(revision.raw)
        || await this.dagDirectoryIdentity(revision.folder) !== revision.identity
        || (files && await this.dagDirectoryIdentity(files) !== filesIdentity)) throw new Error('历史版本在归档核对期间变化');
      identities.push({ id: revision.id, source: 'transport', identity: revision.identity, filesIdentity });
    }
    const localLocations = [...localInventory.active.names.map(id => ({ id, root: locations.localHistory! })), ...localInventory.retained.names.map(id => ({ id, root: locations.retainedHistory! }))];
    for (const { id, root } of localLocations) {
      const folder = (await subDirectory(root, id, false))!;
      if (!folder) throw new Error('本机归档在读取期间消失');
      const identity = await this.dagDirectoryIdentity(folder), stat = await fs.lstat(folder);
      const tree = await scanTree(folder, projectId, { bytes: MATERIAL_DAG_LIMITS.referencedBytes - referencedBytes,
        files: MATERIAL_DAG_LIMITS.references - references, metadataBytes: MATERIAL_DAG_LIMITS.manifestBytes - localMetadataBytes });
      references += tree.entries.length; referencedBytes += tree.entries.reduce((sum, entry) => sum + entry.bytes, 0);
      localMetadataBytes += tree.entries.reduce((sum, entry) => sum + dagEntryMetadataBytes(entry), 0);
      for (const data of tree.data.values()) add(data);
      if (await this.dagDirectoryIdentity(folder) !== identity) throw new Error('本机历史在归档核对期间变化');
      local.push({ id, createdAt: stat.mtime.toISOString(), entries: tree.entries }); identities.push({ id, source: 'local', identity });
    }
    const checkLocations = async () => {
      const latest = await this.historyLocations(projectId);
      if (latest.bookIdentity !== locations.bookIdentity || latest.localHistory !== locations.localHistory || latest.retainedHistory !== locations.retainedHistory || latest.versions !== locations.versions)
        throw new Error('完整历史目录或本书归属在核对期间变化');
      return latest;
    };
    // In particular, re-resolve an initially absent local root. Otherwise a
    // first local archive created during this scan could be silently omitted.
    const latest = await checkLocations();
    if (JSON.stringify(await this.localInventories(latest.localHistory, latest.retainedHistory)) !== JSON.stringify(localInventory)
      || JSON.stringify(await this.dagInventory(latest.versions)) !== JSON.stringify(transportInventory)) throw new Error('完整历史在核对期间变化');
    await checkLocations();
    // The final location check itself reads book metadata. Check root identity
    // once more afterwards, including roots that were absent at the start.
    const finalRoot = async (directory: string, identity: string | null) => {
      if (identity === null) {
        if (await statOrNull(directory)) throw new Error('完整历史目录在核对期间出现，请重新预览');
      } else if (await this.dagDirectoryIdentity(directory) !== identity) throw new Error('完整历史目录在核对期间变化，请重新预览');
    };
    await finalRoot(locations.localHistory ?? path.join(this.materialsRoot, '同步历史', projectId), localInventory.active.identity);
    await finalRoot(locations.retainedHistory ?? path.join(this.materialsRoot, '同步历史保留', projectId), localInventory.retained.identity);
    await finalRoot(locations.versions, transportInventory.identity);
    const fingerprint = hash(JSON.stringify({ projectId, bookIdentity: locations.bookIdentity, localInventory, transportInventory, transport, local, leaves, identities }));
    const planned = { schemaVersion: 1, kind: 'material-history-dag-archive', projectId, archiveId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-01-01T00:00:00.000Z', fingerprint, transport, local, leaves,
      blobs: [...blobs].map(([sha256, data]) => ({ sha256, bytes: data.length })), file: '完整资料历史.zip', bytes: uniqueBytes,
      archiveBytes: MATERIAL_DAG_LIMITS.archiveBytes, sha256: '0'.repeat(64) };
    if (Buffer.byteLength(JSON.stringify(planned, null, 2)) > MATERIAL_DAG_LIMITS.manifestBytes) throw new Error('完整历史完成清单超过8 MiB');
    const snapshot: MaterialHistoryDagPreview = { schemaVersion: 1, projectId, fingerprint, transportVersions: transport.length,
      localArchives: local.length, branches: leaves.length, files: references, blobs: blobs.size, bytes: uniqueBytes };
    return { snapshot, book: locations.book, bookIdentity: locations.bookIdentity, transport, local, leaves, blobs };
  }
  previewHistoryDag(projectId: string): Promise<MaterialHistoryDagPreview> {
    const id = z.uuid().parse(projectId); this.project(id);
    return this.serial(async () => (await this.inspectHistoryDag(id)).snapshot);
  }
  private async assertHistoryDagUnchanged(context: DagContext) {
    if ((await this.inspectHistoryDag(context.snapshot.projectId)).snapshot.fingerprint !== context.snapshot.fingerprint)
      throw new Error('完整历史或本书归属已变化，请重新预览；原件均保留');
  }
  private async checkDagArchiveTarget(context: DagContext, directory: string, archiveId: string, expectedSHA: string, baseIdentity: string, directoryIdentity: string) {
    const locations = await this.historyLocations(context.snapshot.projectId);
    if (locations.bookIdentity !== context.bookIdentity) throw new Error('完整历史归档的小说归属已变化');
    const base = await subDirectory(context.book, `${META}/完整历史归档`, false), latest = base ? await subDirectory(base, archiveId, false) : null;
    if (!base || latest !== directory || await this.dagDirectoryIdentity(base) !== baseIdentity
      || await this.dagDirectoryIdentity(directory) !== directoryIdentity) throw new Error('完整历史归档目标目录身份已变化，未发布完成清单');
    if (hash(await readRegular(directory, '完整资料历史.zip', MATERIAL_DAG_LIMITS.archiveBytes)) !== expectedSHA)
      throw new Error('完整历史归档ZIP暂存已变化，未发布完成清单');
    if (await this.dagDirectoryIdentity(directory) !== directoryIdentity) throw new Error('完整历史归档目标目录在校验期间变化');
  }
  archiveHistoryDag(input: MaterialHistoryDagRequest): Promise<MaterialHistoryDagArchiveResult> {
    const request = z.object({ projectId: z.uuid(), fingerprint: hashSchema }).strict().parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const context = await this.inspectHistoryDag(request.projectId);
      if (context.snapshot.fingerprint !== request.fingerprint) throw new Error('完整历史已变化，请重新预览后再归档');
      const archiveId = randomUUID(), manifest: MaterialDagManifest = { schemaVersion: 1, kind: 'material-history-dag-archive',
        projectId: request.projectId, archiveId, createdAt: new Date().toISOString(), fingerprint: request.fingerprint,
        transport: context.transport, local: context.local, leaves: context.leaves,
        blobs: [...context.blobs].map(([sha256, data]) => ({ sha256, bytes: data.length })).sort((a,b) => a.sha256.localeCompare(b.sha256)) };
      const { archive, completion } = await encodeMaterialHistoryDag(manifest, context.blobs);
      await this.assertHistoryDagUnchanged(context);
      const base = (await subDirectory(context.book, `${META}/完整历史归档`, true))!;
      const directory = path.join(base, archiveId); await fs.mkdir(directory);
      const file = path.join(directory, '完整资料历史.zip'); await checkedDirectory(directory); await fs.writeFile(file, archive, { flag: 'wx' });
      const baseIdentity = await this.dagDirectoryIdentity(base), directoryIdentity = await this.dagDirectoryIdentity(directory), sha256 = hash(archive);
      await this.assertHistoryDagUnchanged(context);
      await this.checkDagArchiveTarget(context, directory, archiveId, sha256, baseIdentity, directoryIdentity);
      await this.assertHistoryDagUnchanged(context);
      await this.checkDagArchiveTarget(context, directory, archiveId, sha256, baseIdentity, directoryIdentity);
      await fs.writeFile(path.join(directory, '完成清单.json'), completion, { flag: 'wx' });
      return { ...context.snapshot, archiveId, directory, file, archiveBytes: archive.length, sha256 };
    });
  }
  private async inspectHistory(request: MaterialHistoryRequest): Promise<HistoryContext> {
    const locations = await this.historyLocations(request.projectId);
    const current = locations.canonical ? await scanTree(locations.canonical, request.projectId) : emptyTree();
    let history: Tree, manifestHash: string | null = null, folder: string, contentRoot: string | null;
    if (request.source === 'local') {
      const inventories = await this.localInventories(locations.localHistory, locations.retainedHistory);
      const root = inventories.active.names.includes(request.id) ? locations.localHistory : inventories.retained.names.includes(request.id) ? locations.retainedHistory : null;
      if (!root) throw new Error('所选本机资料历史不存在，请刷新列表');
      folder = (await subDirectory(root, request.id, false))!;
      if (!folder) throw new Error('所选本机资料历史不存在，请刷新列表');
      contentRoot = folder;
      history = await scanTree(folder, request.projectId);
    } else {
      const revisions = await this.readRevisions(locations.versions, request.projectId), revision = revisions.find(value => value.manifest.revisionId === request.id);
      if (!revision) throw new Error('所选随书资料版本不存在或尚未传输完整，请刷新列表');
      folder = revision.folder;
      const raw = await readRegular(folder, 'manifest.json', 2 * 1024 * 1024);
      let latest: Manifest; try { latest = manifestSchema.parse(JSON.parse(raw.toString('utf8'))); } catch { throw new Error('资料历史清单损坏或版本不受支持'); }
      if (JSON.stringify(latest) !== JSON.stringify(revision.manifest)) throw new Error('资料历史清单在读取期间变化，请重新预览');
      manifestHash = hash(raw);
      const declared = await this.readRevision(revision, request.projectId), files = await subDirectory(folder, 'files', false);
      contentRoot = files;
      history = files ? await scanTree(files, request.projectId) : emptyTree();
      if (declared.fingerprint !== history.fingerprint) throw new Error('资料历史完整目录与清单不匹配，请等待完整传输');
      if (hash(await readRegular(folder, 'manifest.json', 2 * 1024 * 1024)) !== manifestHash) throw new Error('资料历史清单在读取期间变化，请重新预览');
    }
    await checkedDirectory(folder); const sourceStat = await fs.lstat(folder);
    const fingerprint = hash(JSON.stringify({ projectId: request.projectId, source: request.source, id: request.id,
      bookIdentity: locations.bookIdentity, folder, dev: sourceStat.dev, ino: sourceStat.ino, manifestHash,
      current: current.entries, history: history.entries }));
    if (request.fingerprint !== undefined && request.fingerprint !== fingerprint) throw new Error('资料历史或当前资料已变化，请重新预览后处理');
    return { projectId: request.projectId, source: request.source, id: request.id, book: locations.book,
      bookIdentity: locations.bookIdentity, current, history, fingerprint, folder, contentRoot, canonical: locations.canonical };
  }
  previewHistory(input: MaterialHistoryRequest): Promise<MaterialHistoryPreview> {
    const request = historyRequestSchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const context = await this.inspectHistory(request), current = new Map(context.current.entries.map(entry => [entry.path, entry])), history = new Map(context.history.entries.map(entry => [entry.path, entry]));
      const files: MaterialHistoryFile[] = [...new Set([...current.keys(), ...history.keys()])].sort().map(relative => {
        const left = current.get(relative), right = history.get(relative);
        return { path: relative, currentHash: left?.sha256 ?? null, historyHash: right?.sha256 ?? null, currentBytes: left?.bytes ?? 0,
          historyBytes: right?.bytes ?? 0, change: !left ? 'history-only' : !right ? 'current-only' : left.sha256 === right.sha256 ? 'unchanged' : 'changed' };
      });
      const result: MaterialHistoryPreview = { schemaVersion: 1, projectId: request.projectId, source: request.source, id: request.id, fingerprint: context.fingerprint, files };
      if (request.path !== undefined) {
        if (!current.has(request.path) && !history.has(request.path)) throw new Error('所选资料历史文件不存在，请刷新预览');
        const left = historyText(context.current.data.get(request.path), request.path), right = historyText(context.history.data.get(request.path), request.path);
        result.detail = { path: request.path, currentText: left.text, historyText: right.text, currentTruncated: left.truncated, historyTruncated: right.truncated };
      }
      return result;
    });
  }
  private async assertHistoryUnchanged(context: HistoryContext) {
    const latest = await this.inspectHistory({ projectId: context.projectId, source: context.source, id: context.id, fingerprint: context.fingerprint });
    if (latest.book !== context.book || latest.bookIdentity !== context.bookIdentity) throw new Error('小说归属或目录位置已变化，历史副本暂存已保留');
  }
  /** Restore a user-selected history only after a separate explicit UI confirmation.
   * The existing pending format makes an interrupted directory swap recoverable;
   * the current directory is renamed intact to a new local-history backup. */
  restoreHistory(input: MaterialHistoryCopyRequest): Promise<MaterialHistoryRestoreResult> {
    const request = historyCopySchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const id = request.projectId;
      await this.noSyncPending(id);
      const context = await this.inspectHistory(request);
      const result = { schemaVersion: 1 as const, projectId: id, source: request.source, id: request.id };
      if (context.current.fingerprint === context.history.fingerprint) return { ...result, backupId: null, changed: false };
      if (!context.canonical) throw new Error('当前固定资料目录不存在，无法创建换前备份；原资料和历史均保留');
      const base = await checkedDirectory(this.materialsRoot);
      const current = await retentionTree(context.canonical, id), source = context.contentRoot ? await retentionTree(context.contentRoot, id) : null;
      if (current.tree.fingerprint !== context.current.fingerprint || (source?.tree.fingerprint ?? emptyTree().fingerprint) !== context.history.fingerprint)
        throw new Error('当前资料或历史目录已变化，请重新预览');
      const folderIdentity = await this.dagDirectoryIdentity(context.folder);
      const state = await this.readState(id), history = (await subDirectory(base, `同步历史/${id}`, true))!;
      await this.requireHistorySlot(history, '本机资料历史');
      const historyIdentity = await this.dagDirectoryIdentity(history), historyStat = await fs.lstat(history);
      const checkHistoryRoot = async (unchanged: boolean) => {
        if (await subDirectory(base, `同步历史/${id}`, false) !== history) throw new Error('换前备份目录位置已变化');
        const latest = await fs.lstat(history);
        if (!latest.isDirectory() || latest.isSymbolicLink() || latest.dev !== historyStat.dev || latest.ino !== historyStat.ino
          || (unchanged && await this.dagDirectoryIdentity(history) !== historyIdentity)) throw new Error('换前备份目录身份或内容已变化');
      };
      const backupId = randomUUID(), archive = path.join(history, backupId);
      const stage = path.join(base, `sync-stage-${id}-${randomUUID()}`);
      if (await statOrNull(archive)) throw new Error('换前备份目录已存在，未覆盖任何资料');
      await fs.mkdir(stage); await this.writeFiles(stage, context.history);
      const staged = await retentionTree(stage, id);
      if (staged.tree.fingerprint !== context.history.fingerprint) throw new Error('历史资料暂存已变化，未换入；原件与暂存均保留');
      const checkSource = async () => {
        if (await this.dagDirectoryIdentity(context.folder) !== folderIdentity) throw new Error('来源历史目录已变化，原件均保留');
        if (context.contentRoot) {
          if ((await retentionTree(context.contentRoot, id)).fingerprint !== source!.fingerprint) throw new Error('来源历史内容或目录已变化，原件均保留');
        } else if (request.source === 'transport' && await subDirectory(context.folder, 'files', false)) throw new Error('来源历史文件目录已变化，原件均保留');
      };
      const checkFrozen = async () => {
        await this.assertHistoryUnchanged(context);
        const locations = await this.historyLocations(id);
        if (locations.canonical !== context.canonical || locations.bookIdentity !== context.bookIdentity) throw new Error('本书或固定资料位置已变化');
        if ((await retentionTree(context.canonical!, id)).fingerprint !== current.fingerprint) throw new Error('当前固定资料或目录已变化');
        await checkSource();
        if ((await retentionTree(stage, id)).fingerprint !== staged.fingerprint) throw new Error('历史资料暂存已变化');
        if ((await this.readState(id)).raw !== state.raw) throw new Error('同步基线已变化');
        await checkHistoryRoot(true);
      };
      await checkFrozen(); await this.noSyncPending(id); await this.requireHistorySlot(history, '本机资料历史');
      const journal = this.syncPending(id), bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: id,
        stage: path.basename(stage), archive: backupId, before: context.current.fingerprint, after: context.history.fingerprint }));
      const handle = await fs.open(journal, 'wx');
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const journalStat = await fs.lstat(journal);
      const checkJournal = async () => {
        const stat = await fs.lstat(journal);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== journalStat.dev || stat.ino !== journalStat.ino
          || !(await readRegular(path.dirname(journal), path.basename(journal), 16384)).equals(bytes)) throw new Error('换入记录已变化，原件和暂存均保留');
      };
      try {
        await checkFrozen(); await this.requireHistorySlot(history, '本机资料历史');
        if (await statOrNull(archive)) throw new Error('换前备份目录被占用，未覆盖任何资料');
        await checkJournal();
        // Last checks after the other awaited reads: no arbitrary cross-process
        // compare-and-swap is available, so a race still leaves the journal.
        if ((await retentionTree(context.canonical, id)).fingerprint !== current.fingerprint) throw new Error('当前资料在换入前变化');
        await checkSource(); await checkHistoryRoot(true); await checkJournal();
        await fs.rename(context.canonical, archive);
        await checkHistoryRoot(false);
        if ((await retentionTree(archive, id)).fingerprint !== current.fingerprint) throw new Error('换前备份在换入期间变化');
        if (await statOrNull(context.canonical)) throw new Error('当前固定资料目录被占用');
        if ((await retentionTree(stage, id)).fingerprint !== staged.fingerprint) throw new Error('换入暂存已变化');
        await checkSource(); await checkJournal(); await fs.rename(stage, context.canonical);
        if ((await retentionTree(context.canonical, id)).fingerprint !== staged.fingerprint
          || (await retentionTree(archive, id)).fingerprint !== current.fingerprint
          || await this.bookIdentity(id, context.book) !== context.bookIdentity || (await this.readState(id)).raw !== state.raw)
          throw new Error('换入后目录、备份或同步基线已变化，原件与记录均保留');
        await checkSource(); await checkHistoryRoot(false); await checkJournal(); await this.recoverPending(id);
        return { ...result, backupId, changed: true };
      } catch (error) {
        if (!await statOrNull(context.canonical)) {
          try { await checkJournal(); await this.recoverPending(id); } catch { /* preserve ambiguous journal and all trees */ }
        }
        throw new Error(`历史资料换入未完成；原件、备份和必要暂存均保留，请重新打开核对：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  copyHistory(input: MaterialHistoryCopyRequest): Promise<MaterialHistoryCopyResult> {
    const request = historyCopySchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const context = await this.inspectHistory(request), base = (await subDirectory(context.book, `${META}/资料历史恢复`, true))!;
      const copyId = randomUUID(), directory = path.join(base, copyId); await fs.mkdir(directory);
      const files = (await subDirectory(directory, 'files', true))!; await this.writeFiles(files, context.history);
      if ((await scanTree(files, request.projectId)).fingerprint !== context.history.fingerprint) throw new Error('资料历史副本暂存发生变化，未发布完成清单');
      await this.assertHistoryUnchanged(context);
      const latestBase = await subDirectory(context.book, `${META}/资料历史恢复`, false), latestDirectory = latestBase ? await subDirectory(latestBase, copyId, false) : null;
      if (latestBase !== base || latestDirectory !== directory) throw new Error('资料历史恢复目录已变化，未发布完成清单');
      await this.assertHistoryUnchanged(context);
      // Source verification awaits filesystem reads; check the copy after it so
      // a destination edit during those reads cannot receive a completion record.
      if ((await scanTree(files, request.projectId)).fingerprint !== context.history.fingerprint) throw new Error('资料历史副本暂存发生变化，未发布完成清单');
      await checkedDirectory(directory);
      const manifest = { schemaVersion: 1, projectId: request.projectId, kind: 'material-history-copy', source: request.source, id: request.id,
        copyId, createdAt: new Date().toISOString(), fingerprint: context.fingerprint, entries: context.history.entries };
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
      return { schemaVersion: 1, projectId: request.projectId, source: request.source, id: request.id, directory,
        files: context.history.entries.length, bytes: context.history.entries.reduce((sum, entry) => sum + entry.bytes, 0) };
    });
  }
  /** A portable compressed snapshot, with a separate completion record written last.
   * No historical parent or current author file is deleted to make this archive. */
  archiveHistory(input: MaterialHistoryCopyRequest): Promise<MaterialHistoryArchiveResult> {
    const request = historyCopySchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const context = await this.inspectHistory(request);
      const bytes = context.history.entries.reduce((sum, entry) => sum + entry.bytes, 0);
      if (bytes > 64 * 1024 * 1024) throw new Error('历史ZIP原始内容超过64 MiB，请使用“恢复为新副本”保留完整文件');
      const zip = new JSZip(), archiveId = randomUUID();
      const manifest = { schemaVersion: 1, kind: 'material-history-archive', projectId: request.projectId,
        source: request.source, id: request.id, archiveId, createdAt: new Date().toISOString(), entries: context.history.entries };
      for (const entry of context.history.entries) zip.file(`files/${entry.path}`, context.history.data.get(entry.path)!);
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      if (archive.length > 80 * 1024 * 1024) throw new Error('历史ZIP超过80 MiB，请使用“恢复为新副本”');
      await this.assertHistoryUnchanged(context);
      const base = (await subDirectory(context.book, `${META}/资料历史归档`, true))!;
      const directory = path.join(base, archiveId); await fs.mkdir(directory);
      const file = path.join(directory, '历史资料.zip');
      await checkedDirectory(directory); await fs.writeFile(file, archive, { flag: 'wx' });
      const sha256 = hash(archive);
      if (hash(await readRegular(directory, '历史资料.zip', 80 * 1024 * 1024)) !== sha256) throw new Error('历史归档暂存已变化，未发布完成清单');
      await this.assertHistoryUnchanged(context);
      const latestBase = await subDirectory(context.book, `${META}/资料历史归档`, false);
      const latestDirectory = latestBase ? await subDirectory(latestBase, archiveId, false) : null;
      if (latestBase !== base || latestDirectory !== directory) throw new Error('历史归档目录已变化，未发布完成清单');
      await this.assertHistoryUnchanged(context);
      if (hash(await readRegular(directory, '历史资料.zip', 80 * 1024 * 1024)) !== sha256) throw new Error('历史归档暂存已变化，未发布完成清单');
      await checkedDirectory(directory);
      await fs.writeFile(path.join(directory, '完成清单.json'), JSON.stringify({ ...manifest, file: '历史资料.zip', bytes, archiveBytes: archive.length, sha256 }, null, 2), { flag: 'wx' });
      return { schemaVersion: 1, projectId: request.projectId, source: request.source, id: request.id,
        directory, file, files: context.history.entries.length, bytes, archiveBytes: archive.length, sha256 };
    });
  }
  private pruneHistoryImportTickets() {
    const now = Date.now();
    for (const [token, ticket] of this.historyImportTickets) if (ticket.expiresAt <= now) this.historyImportTickets.delete(token);
    for (const [token, ticket] of this.dagImportTickets) if (ticket.expiresAt <= now) this.dagImportTickets.delete(token);
  }
  private limitHistoryImportTickets() {
    while (this.historyImportTickets.size + this.dagImportTickets.size >= MAX_IMPORT_TICKETS) {
      const oldest = [...this.historyImportTickets, ...this.dagImportTickets].sort((a,b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (!oldest) break;
      this.historyImportTickets.delete(oldest[0]); this.dagImportTickets.delete(oldest[0]);
    }
  }
  private historyImportTicket(projectId: string, token: string, fingerprint: string) {
    this.pruneHistoryImportTickets();
    const ticket = this.historyImportTickets.get(token);
    if (!ticket || ticket.projectId !== projectId) throw new Error('历史ZIP票据已过期或已失效，请重新选择文件');
    if (ticket.consumed) throw new Error('历史ZIP票据已使用，请核对已生成的新副本；需要另一次导入时重新选择文件');
    if (ticket.fingerprint !== fingerprint) throw new Error('历史ZIP预览指纹不匹配，请重新选择文件');
    return ticket;
  }
  private async readHistoryArchivePair(file: string, expectedName = '历史资料.zip') {
    const originalParent = path.dirname(file), name = path.basename(file), parent = await checkedDirectory(originalParent);
    relativeSchema.parse(name);
    if (name !== expectedName) throw new Error(`请选择本应用原名“${expectedName}”，并保留同目录完成清单；不要重命名归档文件`);
    if (expectedName === '完整资料历史.zip' && path.relative(originalParent, parent) !== '')
      throw new Error('完整历史ZIP来源路径包含链接，请选择实际目录中的原文件');
    const parentBefore = await fs.lstat(originalParent);
    const zipBefore = await fs.lstat(path.join(parent, name)), completionBefore = await fs.lstat(path.join(parent, '完成清单.json'));
    const identity = (stat: Awaited<ReturnType<typeof fs.lstat>>) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    const zip = await readRegular(parent, name, MAX_IMPORT_ARCHIVE), completion = await readRegular(parent, '完成清单.json', MAX_IMPORT_MANIFEST);
    const parentAfter = await fs.lstat(originalParent), zipAfter = await fs.lstat(path.join(parent, name)), completionAfter = await fs.lstat(path.join(parent, '完成清单.json'));
    if (await checkedDirectory(originalParent) !== parent || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino
      || JSON.stringify(identity(zipBefore)) !== JSON.stringify(identity(zipAfter)) || JSON.stringify(identity(completionBefore)) !== JSON.stringify(identity(completionAfter)))
      throw new Error('历史ZIP、完成清单或来源目录在读取期间变化，请重新选择');
    return { zip, completion, identity: { file, parent, parentDev: parentAfter.dev, parentIno: parentAfter.ino,
      zip: identity(zipAfter), completion: identity(completionAfter) } };
  }
  private async assertDagArchiveSourceIdentity(file: string, expected: Awaited<ReturnType<MaterialSyncService['readHistoryArchivePair']>>['identity']) {
    const parentPath = path.dirname(file), parent = await checkedDirectory(parentPath), parentStat = await fs.lstat(parentPath);
    if (path.relative(parentPath, parent) !== '') throw new Error('完整历史ZIP来源路径包含链接');
    const identity = (stat: Awaited<ReturnType<typeof fs.lstat>>) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    const zip = await fs.lstat(path.join(parent, '完整资料历史.zip')), completion = await fs.lstat(path.join(parent, '完成清单.json'));
    if (!zip.isFile() || zip.isSymbolicLink() || !completion.isFile() || completion.isSymbolicLink()
      || parent !== expected.parent || parentStat.dev !== expected.parentDev || parentStat.ino !== expected.parentIno
      || JSON.stringify(identity(zip)) !== JSON.stringify(expected.zip) || JSON.stringify(identity(completion)) !== JSON.stringify(expected.completion))
      throw new Error('完整历史ZIP、完成清单或来源目录在核对期间变化');
  }
  private async inspectHistoryArchive(ticket: HistoryImportTicket): Promise<HistoryImportContext> {
    const locations = await this.historyLocations(ticket.projectId);
    let source: Awaited<ReturnType<MaterialSyncService['readHistoryArchivePair']>>;
    try { source = await this.readHistoryArchivePair(ticket.file); }
    catch (error) {
      if (absent(error)) throw new Error('历史ZIP或同目录“完成清单.json”缺失，请保留完整归档目录后重新选择');
      throw error;
    }
    const archive = await parseMaterialHistoryArchive(source.zip, source.completion, ticket.projectId);
    const history = fromData(archive.data); checkPaths(history.entries);
    for (const [relative, data] of history.data) validateMetadata(data, relative, ticket.projectId);
    const canonicalStat = locations.canonical ? await fs.lstat(locations.canonical) : null;
    const canonicalIdentity = canonicalStat ? { directory: locations.canonical, real: await checkedDirectory(locations.canonical!), dev: canonicalStat.dev, ino: canonicalStat.ino } : null;
    const current = locations.canonical ? await scanTree(locations.canonical, ticket.projectId) : emptyTree();
    const completionHash = hash(source.completion), fingerprint = hash(JSON.stringify({ projectId: ticket.projectId,
      book: locations.book, bookIdentity: locations.bookIdentity, source: source.identity,
      archiveHash: hash(source.zip), completionHash, canonicalIdentity, current: current.entries, history: history.entries }));
    if (ticket.fingerprint && ticket.fingerprint !== fingerprint) throw new Error('历史ZIP、完成清单、当前资料或小说目录已变化，请重新选择并预览');
    return { ticket, book: locations.book, bookIdentity: locations.bookIdentity, current, history, fingerprint, archive, completionHash };
  }
  private historyArchivePreview(context: HistoryImportContext, relative?: string): MaterialHistoryImportPreview {
    const current = new Map(context.current.entries.map(entry => [entry.path, entry])), history = new Map(context.history.entries.map(entry => [entry.path, entry]));
    const files: MaterialHistoryFile[] = [...new Set([...current.keys(), ...history.keys()])].sort().map(name => {
      const left = current.get(name), right = history.get(name);
      return { path: name, currentHash: left?.sha256 ?? null, historyHash: right?.sha256 ?? null, currentBytes: left?.bytes ?? 0,
        historyBytes: right?.bytes ?? 0, change: !left ? 'history-only' : !right ? 'current-only' : left.sha256 === right.sha256 ? 'unchanged' : 'changed' };
    });
    const { manifest } = context.archive;
    const result: MaterialHistoryImportPreview = { schemaVersion: 1, projectId: context.ticket.projectId, token: context.ticket.token,
      source: manifest.source, id: manifest.id, fingerprint: context.fingerprint, name: path.basename(context.ticket.file),
      archiveId: manifest.archiveId, archiveBytes: context.archive.archiveBytes, sha256: context.archive.sha256, files };
    if (relative !== undefined) {
      if (!current.has(relative) && !history.has(relative)) throw new Error('所选历史ZIP文件不存在，请重新预览');
      const left = historyText(context.current.data.get(relative), relative), right = historyText(context.history.data.get(relative), relative);
      result.detail = { path: relative, currentText: left.text, historyText: right.text, currentTruncated: left.truncated, historyTruncated: right.truncated };
    }
    return result;
  }
  /** The file path comes only from the main process's native file picker. */
  openHistoryArchive(projectId: string, file: string): Promise<MaterialHistoryImportPreview> {
    const id = z.uuid().parse(projectId), selected = z.string().min(1).max(32767).parse(file); this.project(id);
    if (!path.isAbsolute(selected) || selected.includes('\0')) throw new Error('历史ZIP来源必须是已授权的完整文件路径');
    const ticket: HistoryImportTicket = { projectId: id, token: randomUUID(), file: path.resolve(selected), fingerprint: '', expiresAt: Date.now() + IMPORT_TICKET_LIFETIME, consumed: false };
    return this.serial(async () => {
      const context = await this.inspectHistoryArchive(ticket); ticket.fingerprint = context.fingerprint;
      ticket.expiresAt = Date.now() + IMPORT_TICKET_LIFETIME;
      this.pruneHistoryImportTickets();
      for (const [token, previous] of this.historyImportTickets) if (previous.projectId === id) this.historyImportTickets.delete(token);
      this.limitHistoryImportTickets();
      this.historyImportTickets.set(ticket.token, ticket);
      return this.historyArchivePreview(context);
    });
  }
  previewHistoryArchive(input: MaterialHistoryImportRequest): Promise<MaterialHistoryImportPreview> {
    const request = historyImportSchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const ticket = this.historyImportTicket(request.projectId, request.token, request.fingerprint);
      return this.historyArchivePreview(await this.inspectHistoryArchive(ticket), request.path);
    });
  }
  importHistoryArchive(input: MaterialHistoryImportCopyRequest): Promise<MaterialHistoryImportResult> {
    const request = historyImportCopySchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const ticket = this.historyImportTicket(request.projectId, request.token, request.fingerprint), context = await this.inspectHistoryArchive(ticket);
      const base = (await subDirectory(context.book, `${META}/资料历史导入`, true))!, copyId = randomUUID(), directory = path.join(base, copyId);
      await fs.mkdir(directory); const files = (await subDirectory(directory, 'files', true))!;
      const targetIdentity = () => Promise.all([base, directory, files].map(async folder => {
        const real = await checkedDirectory(folder), stat = await fs.lstat(folder);
        return JSON.stringify({ real, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
      }));
      const originalTargetIdentity = JSON.stringify(await targetIdentity()); await this.writeFiles(files, context.history);
      const sourceUnchanged = async () => {
        this.historyImportTicket(request.projectId, request.token, request.fingerprint);
        const latest = await this.inspectHistoryArchive(ticket);
        if (latest.book !== context.book || latest.bookIdentity !== context.bookIdentity) throw new Error('小说目录或归属已变化，导入暂存已保留');
      };
      const targetUnchanged = async () => {
        const latestBase = await subDirectory(context.book, `${META}/资料历史导入`, false), latestDirectory = latestBase ? await subDirectory(latestBase, copyId, false) : null;
        if (latestBase !== base || latestDirectory !== directory) throw new Error('历史ZIP导入目标目录已变化，未发布完成清单');
        if (JSON.stringify(await targetIdentity()) !== originalTargetIdentity) throw new Error('历史ZIP导入目标目录身份已变化，未发布完成清单');
        if ((await scanTree(files, request.projectId)).fingerprint !== context.history.fingerprint) throw new Error('历史ZIP导入暂存已变化，未发布完成清单');
      };
      // The final asynchronous source pass must precede the final target pass.
      await sourceUnchanged(); await targetUnchanged(); await sourceUnchanged(); await targetUnchanged(); await checkedDirectory(directory);
      const { manifest } = context.archive;
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: 'material-history-import-copy',
        projectId: request.projectId, source: manifest.source, id: manifest.id, archiveId: manifest.archiveId, archiveCreatedAt: manifest.createdAt,
        archiveSha256: context.archive.sha256, completionSha256: context.completionHash, copyId, createdAt: new Date().toISOString(),
        fingerprint: context.fingerprint, entries: context.history.entries }, null, 2), { flag: 'wx' });
      ticket.consumed = true;
      return { schemaVersion: 1, projectId: request.projectId, source: manifest.source, id: manifest.id, archiveId: manifest.archiveId,
        sha256: context.archive.sha256, directory, files: context.history.entries.length, bytes: context.archive.bytes };
    });
  }
  private dagImportTicket(projectId: string, token: string, fingerprint: string) {
    this.pruneHistoryImportTickets();
    const ticket = this.dagImportTickets.get(token);
    if (!ticket || ticket.projectId !== projectId) throw new Error('完整历史ZIP票据已过期或失效，请重新选择文件');
    if (ticket.consumed) throw new Error('完整历史ZIP票据已使用，请核对已生成的新副本');
    if (ticket.fingerprint !== fingerprint) throw new Error('完整历史ZIP预览指纹不匹配，请重新选择文件');
    return ticket;
  }
  /** Preflight all expanded paths and every logical metadata use before creating any output. */
  private buildDagImportPlan(archive: MaterialDagContents, projectId: string): DagImportPlan {
    const directories = new Set<string>(), directoryNames = new Map<string, string>(), fileNames = new Set<string>();
    const files: DagImportPlan['files'] = []; let expandedBytes = 0;
    const directory = (parts: string[]) => {
      let prefix = '';
      for (const part of parts) {
        if (!isSafeRelative(part) || part.startsWith('.')) throw new Error('完整历史导入目录路径不安全');
        prefix = prefix ? `${prefix}/${part}` : part;
        const normalized = key(prefix), existing = directoryNames.get(normalized);
        if (existing && existing !== prefix || fileNames.has(normalized)) throw new Error('完整历史导入目录存在等价路径或文件冲突');
        directoryNames.set(normalized, prefix); directories.add(prefix);
        if (directories.size > MAX_DAG_IMPORT_DIRECTORIES || directories.size + files.length > MAX_DAG_IMPORT_ENTRIES)
          throw new Error('完整历史导入目录或总条目超过安全上限');
      }
    };
    const file = (prefix: string[], relative: string, data: Buffer) => {
      relativeSchema.parse(relative); const parts = [...prefix, ...relative.split('/')]; directory(parts.slice(0, -1));
      const full = parts.join('/'), normalized = key(full);
      if (fileNames.has(normalized) || directoryNames.has(normalized)) throw new Error('完整历史导入文件存在等价路径或目录冲突');
      fileNames.add(normalized); expandedBytes += data.length;
      if (files.length >= MATERIAL_DAG_LIMITS.references || expandedBytes > MATERIAL_DAG_LIMITS.referencedBytes
        || directories.size + files.length + 1 > MAX_DAG_IMPORT_ENTRIES) throw new Error('完整历史导入展开内容或条目超过安全上限');
      files.push({ path: full, bytes: data.length, sha256: hash(data), data });
    };
    for (const item of archive.manifest.transport) {
      const raw = archive.blobs.get(item.manifestSha256); if (!raw) throw new Error('完整历史缺少传输清单原件');
      let manifest: Manifest;
      try { manifest = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw))); }
      catch { throw new Error('完整历史传输清单损坏'); }
      if (manifest.projectId !== projectId || manifest.revisionId !== item.id) throw new Error('完整历史传输清单属于另一部小说或版本');
      directory(['transport', item.id, 'files']); file(['transport', item.id], 'manifest.json', raw);
      for (const entry of manifest.entries) {
        const data = archive.blobs.get(entry.sha256); if (!data || data.length !== entry.bytes) throw new Error('完整历史缺少文件原件');
        validateMetadata(data, entry.path, projectId); file(['transport', item.id, 'files'], entry.path, data);
      }
    }
    for (const item of archive.manifest.local) {
      directory(['local', item.id]);
      for (const entry of item.entries) {
        const data = archive.blobs.get(entry.sha256); if (!data || data.length !== entry.bytes) throw new Error('完整历史缺少本机历史原件');
        validateMetadata(data, entry.path, projectId); file(['local', item.id], entry.path, data);
      }
    }
    return { directories: [...directories].sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
      files: files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  }
  private async inspectHistoryDagArchive(ticket: HistoryImportTicket): Promise<DagImportContext> {
    const locations = await this.historyLocations(ticket.projectId);
    let source: Awaited<ReturnType<MaterialSyncService['readHistoryArchivePair']>>;
    try { source = await this.readHistoryArchivePair(ticket.file, '完整资料历史.zip'); }
    catch (error) { if (absent(error)) throw new Error('完整历史ZIP或同目录完成清单缺失，请保留完整归档目录'); throw error; }
    const archive = parseMaterialHistoryDag(source.zip, source.completion, ticket.projectId), plan = this.buildDagImportPlan(archive, ticket.projectId);
    const completionEstimate = { schemaVersion: 1, kind: 'material-history-dag-import-copy', projectId: ticket.projectId,
      copyId: '00000000-0000-4000-8000-000000000000', archiveId: archive.manifest.archiveId, archiveSha256: archive.sha256,
      completionSha256: hash(source.completion), fingerprint: '0'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z', sourceArchive: archive.manifest };
    if (Buffer.byteLength(JSON.stringify(completionEstimate, null, 2)) > MAX_IMPORT_MANIFEST) throw new Error('完整历史导入完成清单超过8 MiB');
    const canonicalIdentity = locations.canonical ? await this.dagDirectoryIdentity(locations.canonical) : null;
    const current = locations.canonical ? await scanTree(locations.canonical, ticket.projectId) : emptyTree();
    const latestLocations = await this.historyLocations(ticket.projectId);
    if (latestLocations.bookIdentity !== locations.bookIdentity || latestLocations.canonical !== locations.canonical
      || (locations.canonical && await this.dagDirectoryIdentity(locations.canonical) !== canonicalIdentity))
      throw new Error('本书归属或当前资料在导入核对期间变化');
    const latestSource = await this.readHistoryArchivePair(ticket.file, '完整资料历史.zip');
    if (JSON.stringify(latestSource.identity) !== JSON.stringify(source.identity) || hash(latestSource.zip) !== archive.sha256
      || hash(latestSource.completion) !== hash(source.completion)) throw new Error('完整历史ZIP或完成清单在核对期间变化');
    const currentFingerprint = current.fingerprint, currentEntries = current.entries; current.data.clear();
    const finalCurrent = locations.canonical ? await scanTree(locations.canonical, ticket.projectId) : emptyTree();
    if (finalCurrent.fingerprint !== currentFingerprint) throw new Error('当前资料在完整历史导入核对期间变化');
    finalCurrent.data.clear();
    await this.assertDagArchiveSourceIdentity(ticket.file, source.identity);
    // The source identity check is asynchronous. A nested current file can
    // change during it without changing the canonical root directory's mtime.
    const afterSource = locations.canonical ? await scanTree(locations.canonical, ticket.projectId) : emptyTree();
    if (afterSource.fingerprint !== currentFingerprint) throw new Error('当前资料在完整历史导入核对期间变化');
    afterSource.data.clear();
    if (locations.canonical ? await this.dagDirectoryIdentity(locations.canonical) !== canonicalIdentity : Boolean(await statOrNull(path.join(this.materialsRoot, ticket.projectId))))
      throw new Error('当前资料目录在完整历史导入核对期间变化');
    const completionHash = hash(source.completion), fingerprint = hash(JSON.stringify({ projectId: ticket.projectId,
      bookIdentity: locations.bookIdentity, source: source.identity, archiveSha256: archive.sha256, completionHash,
      canonical: canonicalIdentity, current: currentEntries, directories: plan.directories, files: plan.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) }));
    if (ticket.fingerprint && ticket.fingerprint !== fingerprint) throw new Error('完整历史ZIP、当前资料或小说归属已变化，请重新选择');
    const preview: MaterialHistoryDagImportPreview = { schemaVersion: 1, projectId: ticket.projectId, token: ticket.token, fingerprint,
      archiveId: archive.manifest.archiveId, name: '完整资料历史.zip', archiveBytes: archive.archiveBytes, sha256: archive.sha256,
      transportVersions: archive.manifest.transport.length, localArchives: archive.manifest.local.length, branches: archive.manifest.leaves.length,
      files: plan.files.length, blobs: archive.blobs.size, bytes: archive.bytes, directories: plan.directories.length };
    return { ticket, book: locations.book, bookIdentity: locations.bookIdentity, fingerprint, archive, completionHash, plan, preview };
  }
  openHistoryDagArchive(projectId: string, file: string): Promise<MaterialHistoryDagImportPreview> {
    const id = z.uuid().parse(projectId); this.project(id);
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('完整历史ZIP路径无效');
    return this.serial(async () => {
      const ticket: HistoryImportTicket = { projectId: id, token: randomUUID(), file: path.resolve(file), fingerprint: '', expiresAt: 0, consumed: false };
      const context = await this.inspectHistoryDagArchive(ticket); ticket.fingerprint = context.fingerprint; ticket.expiresAt = Date.now() + IMPORT_TICKET_LIFETIME;
      this.pruneHistoryImportTickets();
      for (const [token, previous] of this.dagImportTickets) if (previous.projectId === id) this.dagImportTickets.delete(token);
      this.limitHistoryImportTickets(); this.dagImportTickets.set(ticket.token, ticket);
      return context.preview;
    });
  }
  previewHistoryDagArchive(input: MaterialHistoryDagImportRequest): Promise<MaterialHistoryDagImportPreview> {
    const request = historyImportCopySchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => (await this.inspectHistoryDagArchive(this.dagImportTicket(request.projectId, request.token, request.fingerprint))).preview);
  }
  private async assertHistoryDagImportUnchanged(context: DagImportContext) {
    this.dagImportTicket(context.ticket.projectId, context.ticket.token, context.fingerprint);
    const latest = await this.inspectHistoryDagArchive(context.ticket);
    if (latest.book !== context.book || latest.bookIdentity !== context.bookIdentity || latest.fingerprint !== context.fingerprint)
      throw new Error('完整历史来源、当前资料或小说归属已变化，导入暂存已保留');
  }
  private async dagImportFileIdentity(file: string) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('完整历史导入目标不是普通文件');
    return JSON.stringify({ dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
  }
  private async captureDagImportTarget(base: string, directory: string, plan: DagImportPlan): Promise<DagImportTargetIdentity> {
    const directories = new Map<string, string>(), files = new Map<string, string>();
    for (const relative of plan.directories) {
      const folder = await subDirectory(directory, relative, false); if (!folder) throw new Error('完整历史导入暂存目录缺失');
      directories.set(relative, await this.dagDirectoryIdentity(folder));
    }
    for (const entry of plan.files) {
      const relativeParent = path.posix.dirname(entry.path), folder = await subDirectory(directory, relativeParent, false);
      if (!folder) throw new Error('完整历史导入暂存目录缺失');
      files.set(entry.path, await this.dagImportFileIdentity(path.join(folder, path.posix.basename(entry.path))));
    }
    return { base: await this.dagDirectoryIdentity(base), root: await this.dagDirectoryIdentity(directory), directories, files };
  }
  private async checkHistoryDagImportTarget(context: DagImportContext, base: string, directory: string, copyId: string,
    identity: DagImportTargetIdentity, plan: DagImportPlan) {
    const locations = await this.historyLocations(context.ticket.projectId);
    if (locations.book !== context.book || locations.bookIdentity !== context.bookIdentity)
      throw new Error('完整历史导入的小说归属在最终核对期间变化，未发布完成清单');
    const latestBase = await subDirectory(context.book, `${META}/完整历史导入`, false);
    const latestDirectory = latestBase ? await subDirectory(latestBase, copyId, false) : null;
    if (latestBase !== base || latestDirectory !== directory || await this.dagDirectoryIdentity(base) !== identity.base
      || await this.dagDirectoryIdentity(directory) !== identity.root) throw new Error('完整历史导入目标目录身份已变化，未发布完成清单');
    const expectedDirs = new Set(plan.directories), expectedFiles = new Map(plan.files.map(entry => [entry.path, entry]));
    const seenDirs = new Set<string>(), seenFiles = new Set<string>();
    const walk = async (folder: string, prefix = '') => {
      for await (const item of await fs.opendir(folder)) {
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        if (!isSafeRelative(item.name) || item.name.startsWith('.')) throw new Error('完整历史导入暂存包含不安全路径');
        const current = path.join(folder, item.name), stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('完整历史导入暂存包含链接');
        if (stat.isDirectory()) {
          if (!expectedDirs.has(relative) || await this.dagDirectoryIdentity(current) !== identity.directories.get(relative))
            throw new Error('完整历史导入暂存目录已变化');
          seenDirs.add(relative); await walk(current, relative);
        } else {
          const entry = expectedFiles.get(relative);
          if (!entry || !stat.isFile() || await this.dagImportFileIdentity(current) !== identity.files.get(relative))
            throw new Error('完整历史导入暂存文件身份已变化');
          const parent = await subDirectory(directory, prefix, false); if (!parent) throw new Error('完整历史导入暂存父目录已变化');
          const data = await readRegular(parent, item.name, Math.min(MAX_FILE, entry.bytes));
          if (data.length !== entry.bytes || hash(data) !== entry.sha256 || await this.dagImportFileIdentity(current) !== identity.files.get(relative))
            throw new Error('完整历史导入暂存文件内容已变化');
          seenFiles.add(relative);
        }
        if (seenDirs.size > MAX_DAG_IMPORT_DIRECTORIES || seenDirs.size + seenFiles.size > MAX_DAG_IMPORT_ENTRIES)
          throw new Error('完整历史导入暂存条目超过上限');
      }
    };
    await walk(directory);
    if (seenDirs.size !== expectedDirs.size || seenFiles.size !== expectedFiles.size) throw new Error('完整历史导入暂存缺少文件或目录');
    // Inspect every directory again after file reads; same-byte directory swaps
    // during a source or target check cannot receive a completion record.
    for (const [relative, original] of identity.directories) {
      const folder = await subDirectory(directory, relative, false);
      if (!folder || await this.dagDirectoryIdentity(folder) !== original) throw new Error('完整历史导入暂存目录身份已变化');
    }
    if (await this.dagDirectoryIdentity(directory) !== identity.root || await this.dagDirectoryIdentity(base) !== identity.base)
      throw new Error('完整历史导入目标目录在校验期间变化');
  }
  importHistoryDagArchive(input: MaterialHistoryDagImportRequest): Promise<MaterialHistoryDagImportResult> {
    const request = historyImportCopySchema.parse(structuredClone(input)); this.project(request.projectId);
    return this.serial(async () => {
      const ticket = this.dagImportTicket(request.projectId, request.token, request.fingerprint), context = await this.inspectHistoryDagArchive(ticket);
      const copyId = randomUUID(), completion = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'material-history-dag-import-copy',
        projectId: request.projectId, copyId, archiveId: context.archive.manifest.archiveId, archiveSha256: context.archive.sha256,
        completionSha256: context.completionHash, fingerprint: context.fingerprint, createdAt: new Date().toISOString(), sourceArchive: context.archive.manifest }, null, 2));
      if (completion.length > MAX_IMPORT_MANIFEST) throw new Error('完整历史导入完成清单超过8 MiB');
      const base = (await subDirectory(context.book, `${META}/完整历史导入`, true))!, directory = path.join(base, copyId);
      await fs.mkdir(directory);
      for (const relative of context.plan.directories) await subDirectory(directory, relative, true);
      for (const entry of context.plan.files) {
        const parent = (await subDirectory(directory, path.posix.dirname(entry.path), false))!;
        if (!parent) throw new Error('完整历史导入暂存目录缺失');
        await fs.writeFile(path.join(parent, path.posix.basename(entry.path)), entry.data, { flag: 'wx' });
      }
      const identity = await this.captureDagImportTarget(base, directory, context.plan);
      await this.assertHistoryDagImportUnchanged(context);
      await this.checkHistoryDagImportTarget(context, base, directory, copyId, identity, context.plan);
      await this.assertHistoryDagImportUnchanged(context);
      await this.checkHistoryDagImportTarget(context, base, directory, copyId, identity, context.plan);
      await fs.writeFile(path.join(directory, 'manifest.json'), completion, { flag: 'wx' });
      ticket.consumed = true;
      return { ...context.preview, copyId, directory };
    });
  }
  private disabled(projectId: string, state: State): MaterialSyncSnapshot {
    return { schemaVersion: 1, projectId, enabled: false, status: 'disabled', fingerprint: hash(JSON.stringify(state)), selectedRemoteRevision: null,
      remoteRevisions: [], files: [], localFiles: 0, remoteFiles: 0, message: '创作资料同步未开启；正式资料仍保存在本机固定目录。', historyDirectory: this.historyDirectory(projectId), lastSyncedAt: state.lastSyncedAt };
  }
  private async inspect(projectId: string, remoteRevision?: string): Promise<Inspection> {
    this.project(projectId); if (remoteRevision !== undefined) z.uuid().parse(remoteRevision);
    const { state, raw: stateRaw } = await this.readState(projectId);
    await this.recoverPending(projectId);
    const base = await rootDirectory(this.materialsRoot), canonical = path.join(base, projectId);
    if (state.enabled === false) return { snapshot: this.disabled(projectId, state), state, stateRaw, canonical, versions: '', book: '', local: emptyTree(), remote: emptyTree(), revisions: [], leaves: [] };
    const { book, versions } = await this.bookLocations(projectId, false), revisions = await this.readRevisions(versions, projectId);
    const enabled = state.enabled ?? revisions.length > 0;
    if (!enabled) return { snapshot: this.disabled(projectId, state), state, stateRaw, canonical, versions, book, local: emptyTree(), remote: emptyTree(), revisions, leaves: [] };
    if (state.lastRevision && !revisions.some(item => item.manifest.revisionId === state.lastRevision)) throw new Error('本机上次同步版本在本书历史中缺失，请恢复完整同步目录；原资料已保留');
    const parents = new Set(revisions.flatMap(item => item.manifest.parents)), leaves = revisions.filter(item => !parents.has(item.manifest.revisionId));
    const selected = remoteRevision ? leaves.find(item => item.manifest.revisionId === remoteRevision) : leaves.length === 1 ? leaves[0] : undefined;
    if (remoteRevision && !selected) throw new Error('所选远端版本已变化或不再是当前分支，请刷新后重新选择');
    const local = await scanTree(canonical, projectId), remote = selected ? await this.readRevision(selected, projectId) : emptyTree();
    const localMap = new Map(local.entries.map(entry => [entry.path, entry])), remoteMap = new Map(remote.entries.map(entry => [entry.path, entry]));
    const files: MaterialSyncDifference[] = [];
    for (const relative of [...new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(state.base)])].sort()) {
      const left = localMap.get(relative), right = remoteMap.get(relative), localHash = left?.sha256 ?? null, remoteHash = right?.sha256 ?? null;
      if (localHash === remoteHash) continue;
      const prior = state.base[relative] ?? null;
      const action = localHash === prior ? 'pull' : remoteHash === prior ? 'push' : 'conflict';
      files.push({ path: relative, localHash, remoteHash, localBytes: left?.bytes ?? 0, remoteBytes: right?.bytes ?? 0, action,
        localPreview: preview(local.data.get(relative), relative), remotePreview: preview(remote.data.get(relative), relative) });
    }
    const unresolvedBranch = leaves.length > 1 && !selected;
    const fingerprint = hash(JSON.stringify({ projectId, state, local: local.entries, versions: revisions.map(item => item.manifest), selected: selected?.manifest.revisionId ?? null }));
    const snapshot: MaterialSyncSnapshot = { schemaVersion: 1, projectId, enabled, fingerprint, status: unresolvedBranch || files.some(file => file.action === 'conflict') ? 'conflicts' : files.length || leaves.length > 1 ? 'pending' : 'clean',
      selectedRemoteRevision: selected?.manifest.revisionId ?? null, remoteRevisions: leaves.map(item => ({ id: item.manifest.revisionId, createdAt: item.manifest.createdAt, files: item.manifest.entries.length, bytes: item.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) })),
      files: unresolvedBranch ? [] : files, localFiles: local.entries.length, remoteFiles: remote.entries.length, historyDirectory: this.historyDirectory(projectId), lastSyncedAt: state.lastSyncedAt,
      message: unresolvedBranch ? '检测到多个远端分支，请明确选择一个完整快照。未选分支保留在版本历史，不会自动混合。' : leaves.length > 1 ? '已选择一个完整远端快照；其余分支保留在版本历史，不自动混合。请核对逐文件冲突后同步。' : files.length ? '存在待同步资料；冲突解决前两侧正式文件均保留。' : '两侧创作资料一致；正式资料仍在本机固定目录。' };
    return { snapshot, state, stateRaw, local, remote, revisions, leaves, selected, canonical, versions, book };
  }
  status(projectId: string, remoteRevision?: string) {
    const id = z.uuid().parse(projectId), revision = remoteRevision === undefined ? undefined : z.uuid().parse(remoteRevision);
    return this.serial(async () => (await this.inspect(id, revision)).snapshot);
  }
  configure(projectId: string, enabled: boolean) {
    const id = z.uuid().parse(projectId), value = z.boolean().parse(enabled); this.project(id);
    return this.serial(async () => { await this.recoverPending(id); const old = await this.readState(id); await this.writeState(id, { ...old.state, enabled: value }, old.raw); return (await this.inspect(id)).snapshot; });
  }
  private async writeFiles(directory: string, tree: Tree) {
    await checkedDirectory(directory);
    for (const entry of tree.entries) {
      const parent = path.posix.dirname(entry.path); if (parent !== '.') await subDirectory(directory, parent, true);
      await fs.writeFile(path.join(directory, ...entry.path.split('/')), tree.data.get(entry.path)!, { flag: 'wx' });
    }
  }
  private async requireHistorySlot(directory: string | null, label: string) {
    const capacity = await historyCapacity(directory);
    if (capacity.entries >= MAX_REVISIONS) throw new Error(`${label}容量已满（${capacity.exact ? '' : '至少'}${capacity.entries}/1000个目录条目），未新增历史；请保留完整历史与父版本，ZIP留档不会释放名额`);
  }
  private async requireLocalHistorySlot(context: Inspection, merged: Tree) {
    if (context.local.fingerprint === merged.fingerprint || !await statOrNull(context.canonical)) return;
    const base = await checkedDirectory(this.materialsRoot);
    const history = await subDirectory(base, `同步历史/${context.snapshot.projectId}`, false);
    await this.requireHistorySlot(history, '本机资料历史');
  }
  private async publishRevision(context: Inspection, tree: Tree) {
    const locations = await this.bookLocations(context.snapshot.projectId, true);
    if (locations.book !== context.book || locations.versions !== context.versions) throw new Error('小说目录位置已变化，原资料已保留');
    await this.requireHistorySlot(locations.versions, '书内传输版本');
    const id = randomUUID(), folder = path.join(locations.versions, id); await fs.mkdir(folder);
    const files = (await subDirectory(folder, 'files', true))!; await this.writeFiles(files, tree);
    const manifest: Manifest = { schemaVersion: 1, projectId: context.snapshot.projectId, revisionId: id, createdAt: new Date().toISOString(), parents: context.leaves.map(item => item.manifest.revisionId).sort(), entries: tree.entries };
    const verify = await scanTree(files, context.snapshot.projectId); if (verify.fingerprint !== tree.fingerprint) throw new Error('远端资料同步暂存发生变化，未发布清单');
    await this.assertUnchanged(context);
    await checkedDirectory(folder); await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    context.revisions.push({ manifest, folder }); context.revisions.sort((a, b) => a.manifest.revisionId < b.manifest.revisionId ? -1 : 1);
    return id;
  }
  private async assertUnchanged(context: Inspection, includeRemote = true) {
    const id = context.snapshot.projectId;
    if ((await scanTree(context.canonical, id)).fingerprint !== context.local.fingerprint || (await this.readState(id)).raw !== context.stateRaw) throw new Error('资料或本机同步基线已在同步期间变化，两侧原件已保留，请重新核对');
    const locations = await this.bookLocations(id, false);
    if (locations.book !== context.book || locations.versions !== context.versions) throw new Error('小说资料同步位置已变化');
    if (includeRemote) {
      const current = await this.readRevisions(context.versions, id);
      if (JSON.stringify(current.map(item => item.manifest)) !== JSON.stringify(context.revisions.map(item => item.manifest))) throw new Error('远端资料版本在同步期间变化，请重新核对');
      if (context.selected && (await this.readRevision(context.selected, id)).fingerprint !== context.remote.fingerprint) throw new Error('远端资料内容在同步期间变化，请重新核对');
    }
  }
  private async replaceCanonical(context: Inspection, merged: Tree) {
    if (context.local.fingerprint === merged.fingerprint) return;
    const id = context.snapshot.projectId, base = await checkedDirectory(this.materialsRoot);
    await this.requireLocalHistorySlot(context, merged);
    const stage = path.join(base, `sync-stage-${id}-${randomUUID()}`); await fs.mkdir(stage); await this.writeFiles(stage, merged);
    if ((await scanTree(stage, id)).fingerprint !== merged.fingerprint) throw new Error('本机资料同步暂存已变化，原件和暂存已保留');
    await this.assertUnchanged(context);
    const history = (await subDirectory(base, `同步历史/${id}`, true))!, archiveId = randomUUID(), archive = path.join(history, archiveId);
    await this.assertUnchanged(context);
    await this.requireLocalHistorySlot(context, merged);
    const journal = path.join(path.dirname(await this.stateLocation(id)), `${id}-pending.json`);
    await fs.writeFile(journal, JSON.stringify({ schemaVersion: 1, projectId: id, stage: path.basename(stage), archive: archiveId, before: context.local.fingerprint, after: merged.fingerprint }), { flag: 'wx' });
    const hadCanonical = Boolean(await statOrNull(context.canonical));
    if (hadCanonical) { await checkedDirectory(context.canonical); await fs.rename(context.canonical, archive); }
    try {
      if (hadCanonical && (await scanTree(archive, id)).fingerprint !== context.local.fingerprint) throw new Error('本机原资料在换入前发生变化');
      if (await statOrNull(context.canonical)) throw new Error('本机资料位置被其他程序占用');
      await checkedDirectory(base); await checkedDirectory(stage); await fs.rename(stage, context.canonical);
      await this.recoverPending(id);
    } catch (error) {
      if (hadCanonical && !await statOrNull(context.canonical)) await fs.rename(archive, context.canonical).catch(() => {});
      throw new Error(`本机资料换入失败；原件、历史与暂存均保留：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  synchronize(input: MaterialSyncRequest) {
    const request = requestSchema.parse(structuredClone(input)); this.project(request.projectId);
    if (request.resolutions !== undefined && !request.fingerprint) throw new Error('解决同步冲突必须携带核对时的指纹');
    return this.serial(async () => {
      const context = await this.inspect(request.projectId, request.remoteRevision);
      if (!context.snapshot.enabled) return context.snapshot;
      if (request.fingerprint !== undefined && request.fingerprint !== context.snapshot.fingerprint) throw new Error('资料同步内容已变化，请重新预览后处理');
      if (context.leaves.length > 1 && !context.selected) return context.snapshot;
      const conflicts = new Set(context.snapshot.files.filter(file => file.action === 'conflict').map(file => file.path));
      const choices = new Map<string, 'local' | 'remote'>();
      for (const resolution of request.resolutions ?? []) {
        if (!conflicts.has(resolution.path) || choices.has(resolution.path)) throw new Error('同步冲突解决路径无效、重复或不属于当前冲突');
        choices.set(resolution.path, resolution.source);
      }
      if ([...conflicts].some(relative => !choices.has(relative))) return context.snapshot;
      const data = new Map(context.local.data);
      for (const file of context.snapshot.files) {
        if (file.action === 'pull' || file.action === 'conflict' && choices.get(file.path) === 'remote') {
          const remote = context.remote.data.get(file.path); if (remote) data.set(file.path, remote); else data.delete(file.path);
        }
      }
      const merged = fromData(data); checkPaths(merged.entries);
      let revisionId = context.selected?.manifest.revisionId ?? null;
      const publish = context.leaves.length !== 1 || merged.fingerprint !== context.remote.fingerprint;
      // Check both sides before creating a transport revision or a canonical staging tree.
      // Incomplete uploads occupy the same bounded directory space as committed versions.
      if (publish) await this.requireHistorySlot(context.versions, '书内传输版本');
      await this.requireLocalHistorySlot(context, merged);
      if (publish) revisionId = await this.publishRevision(context, merged); else await this.assertUnchanged(context);
      await this.replaceCanonical(context, merged);
      await this.writeState(request.projectId, { schemaVersion: 1, projectId: request.projectId, enabled: context.state.enabled, base: Object.fromEntries(merged.entries.map(entry => [entry.path, entry.sha256])), lastRevision: revisionId, lastSyncedAt: new Date().toISOString() }, context.stateRaw);
      return (await this.inspect(request.projectId)).snapshot;
    });
  }
}
