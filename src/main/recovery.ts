import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DraftRequest, RecoveryDraft, RecoveryEntry } from '../shared/contracts';
import type { Workspace } from './workspace';
import { validateDocument } from './docx';
import mammoth from 'mammoth';
import { decodeText } from './text-import';
import { selectDraftsToPrune } from '../core/draft-retention';
import { copyableText, normalizeParagraphs } from '../core/typography';
import { randomUUID } from 'node:crypto';
const schema = z.object({ schemaVersion: z.literal(1), id: z.uuid(), projectId: z.uuid(), sourcePath: z.string().min(1).max(2000), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative(), updatedAt: z.string(), status: z.enum(['pending', 'saved']), characters: z.number().int().nonnegative(), content: z.custom<RecoveryDraft['content']>() });
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
export class RecoveryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string, private workspace: Workspace) {}
  private async directory(projectId: string) {
    this.workspace.getProject(z.uuid().parse(projectId)); await fs.mkdir(this.root, { recursive: true });
    const root = await fs.realpath(this.root), target = path.join(root, projectId); await fs.mkdir(target, { recursive: true });
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await fs.realpath(target))) throw new Error('草稿恢复目录或链接异常'); return target;
  }
  async read(projectId: string, id: string): Promise<RecoveryDraft> {
    z.uuid().parse(id); const directory = await this.directory(projectId), file = path.join(directory, `${id}.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(directory, await fs.realpath(file))) throw new Error('恢复草稿类型或链接越界');
    if (stat.size > 8 * 1024 * 1024) throw new Error('恢复草稿过大');
    const raw = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > 8 * 1024 * 1024 || directory !== await this.directory(projectId)) throw new Error('恢复草稿过大或目录已变化');
    const draft = schema.parse(JSON.parse(raw)); validateDocument(draft.content);
    if (draft.projectId !== projectId || draft.id !== id) throw new Error('恢复草稿小说或 ID 不匹配');
    this.source(projectId, draft.sourcePath); return draft;
  }
  private source(projectId: string, sourcePath: string) {
    const project = this.workspace.getProject(projectId), target = path.resolve(project.root, sourcePath);
    if (path.isAbsolute(sourcePath) || sourcePath.includes(':') || !inside(project.root, target) || inside(path.join(project.root, '小说资料'), target) || !/\.(docx|txt)$/i.test(sourcePath)) throw new Error('恢复草稿来源路径无效');
  }
  private async write(draft: RecoveryDraft) {
    const directory = await this.directory(draft.projectId), file = path.join(directory, `${draft.id}.json`), temp = `${file}.${randomUUID()}.tmp`;
    const json = JSON.stringify(draft); if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('本机草稿超过8 MB限制');
    try { await fs.writeFile(temp, json, { flag: 'wx' }); for (let attempt = 0; ; attempt++) { if (directory !== await this.directory(draft.projectId)) throw new Error('草稿恢复目录已变化，暂存已保留'); try { await fs.rename(temp, file); break; } catch (e) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; await new Promise(r => setTimeout(r, 30 * 2 ** attempt)); } } }
    finally { await fs.rm(temp, { force: true }); }
  }
  async checkpoint(input: DraftRequest) {
    const parsed = z.object({ projectId: z.uuid(), id: z.uuid(), path: z.string(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().nonnegative(), content: z.custom<DraftRequest['content']>() }).parse(input);
    const request = structuredClone(parsed);
    this.source(request.projectId, request.path); validateDocument(request.content);
    return this.serial(async () => {
      let old: RecoveryDraft | undefined; try { old = await this.read(request.projectId, request.id); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (old && (old.sourcePath !== request.path || old.projectId !== request.projectId)) throw new Error('草稿会话不能换写作目标');
      if (old && old.revision >= request.revision) return;
      const content = normalizeParagraphs(request.content);
      await this.write({ schemaVersion: 1, id: request.id, projectId: request.projectId, sourcePath: request.path, sourceHash: request.expectedHash, revision: request.revision, updatedAt: new Date().toISOString(), status: 'pending', characters: copyableText(content).replace(/\s/g, '').length, content });
    });
  }
  complete(projectId: string, id: string, revision: number) {
    z.number().int().nonnegative().parse(revision);
    return this.serial(async () => {
      let current: RecoveryDraft; try { current = await this.read(projectId, id); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      if (current.revision === revision) await this.write({ ...current, status: 'saved' });
    });
  }
  async list(projectId: string): Promise<RecoveryEntry[]> {
    const directory = await this.directory(projectId), names = (await fs.readdir(directory)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    const result: RecoveryEntry[] = [];
    for (const name of names) { const { content, ...entry } = await this.read(projectId, name.slice(0, -5)); result.push(entry); }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200);
  }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
}


export interface RawDraftEntry { id: string; fileName: string; kind: 'docx' | 'txt'; bytes: number; at: string; sourcePath: string }
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const backupMetadataSchema = z.object({ schemaVersion: z.literal(1).optional(), sourcePath: z.string().max(2000).optional(), at: z.string().max(100).optional(), bytes: z.number().int().nonnegative().optional() });
const missingFile = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
type BackupSuffix = 'draft' | 'previous';
async function backupDirectory(root: string, projectId: string): Promise<string | null> {
  z.uuid().parse(projectId);
  try {
    const realRoot = await fs.realpath(root), directory = path.join(realRoot, projectId), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(realRoot, await fs.realpath(directory))) throw new Error('备份目录或链接异常，原文件已保留');
    return directory;
  } catch (error) { if (missingFile(error)) return null; throw error; }
}
function backupName(id: string, suffix: BackupSuffix) {
  if (typeof id !== 'string' || id.length > 160 || !new RegExp(`^[0-9]+-[a-f0-9-]+-${suffix}\\.(docx|txt)$`, 'u').test(id)) throw new Error('备份文件名不合法');
}
async function checkedBackupFile(directory: string, id: string, maxBytes = MAX_BACKUP_BYTES) {
  const file = path.join(directory, id), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(directory, await fs.realpath(file))) throw new Error('备份文件类型或链接异常，原文件已保留');
  if (stat.size > maxBytes) throw new Error('备份文件过大，原文件已保留');
  return { file, stat };
}
async function readBackupBytes(root: string, projectId: string, id: string, suffix: BackupSuffix) {
  z.uuid().parse(projectId); backupName(id, suffix);
  const directory = await backupDirectory(root, projectId);
  if (!directory) throw Object.assign(new Error('备份文件不存在'), { code: 'ENOENT' });
  const initial = await checkedBackupFile(directory, id), bytes = await fs.readFile(initial.file);
  const currentDirectory = await backupDirectory(root, projectId);
  if (directory !== currentDirectory) throw new Error('备份目录读取期间已变化，请重新读取');
  const current = await checkedBackupFile(directory, id);
  if (bytes.length > MAX_BACKUP_BYTES || initial.stat.size !== current.stat.size || initial.stat.mtimeMs !== current.stat.mtimeMs || initial.stat.ino !== current.stat.ino) throw new Error('备份文件读取期间已变化或过大，请重新读取');
  return { directory, bytes };
}
async function readBackupMetadata(directory: string, id: string, suffix: BackupSuffix) {
  const name = id.replace(new RegExp(`-${suffix}\\.(docx|txt)$`, 'u'), `-${suffix}.meta.json`);
  try {
    const { file } = await checkedBackupFile(directory, name, 64 * 1024), raw = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('备份来源记录过大');
    try { return backupMetadataSchema.parse(JSON.parse(raw)); }
    catch { throw new Error('备份来源记录损坏或版本不受支持，原记录已保留'); }
  } catch (error) { if (missingFile(error)) return undefined; throw error; }
}
/** 列某一类备份条目（失败副本或保存前版本），共用同一套解析与排序逻辑。 */
async function listBackupEntries(root: string, projectId: string, suffix: 'draft' | 'previous'): Promise<RawDraftEntry[]> {
  const directory = await backupDirectory(root, projectId);
  if (!directory) return [];
  const names = await fs.readdir(directory);
  if (names.length > 20000) throw new Error('本机备份条目过多，请先归档，原文件已保留');
  const pattern = new RegExp(`^[0-9]+-[a-f0-9-]+-${suffix}\\.(docx|txt)$`, 'u');
  const entries: RawDraftEntry[] = [];
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const { stat } = await checkedBackupFile(directory, name);
    const meta = await readBackupMetadata(directory, name, suffix);
    entries.push({
      id: name, fileName: name, kind: match[1] as 'docx' | 'txt', bytes: stat.size,
      at: meta?.at ?? stat.mtime.toISOString(), sourcePath: meta?.sourcePath ?? '（来源未记录）'
    });
  }
  return entries.sort((left, right) => right.at.localeCompare(left.at));
}
/** 保存失败时落盘的原始草稿（比 checkpoint 更底层），列出来让作者能看见并取回。 */
export function listRawDrafts(root: string, projectId: string) {
  return listBackupEntries(root, projectId, 'draft');
}
/** 每次成功保存前留下的"上一版"副本，用于回看历史版本。 */
export function listPreviousVersions(root: string, projectId: string) {
  return listBackupEntries(root, projectId, 'previous');
}
/** 预览原始草稿的正文；DOCX 用 mammoth 只取文字，不改文件。 */
export async function readRawDraft(root: string, projectId: string, id: string) {
  const { bytes } = await readBackupBytes(root, projectId, id, 'draft');
  if (id.endsWith('.txt')) return { id, text: decodeText(bytes).text, warnings: ['TXT 仅纯文本预览'] };
  const preview = await mammoth.convertToHtml({ buffer: bytes });
  return { id, text: preview.value, warnings: preview.messages.map(message => message.message) };
}
/** sidecar 里的来源路径必须留在本书目录内：拒绝绝对路径、盘符、`..`，并核对目标仍在书目录里。 */
function safeSourceName(source: string, fallback: string) {
  if (!source) return fallback;
  if (source.length > 2000) throw new Error('备份来源路径过长，已拒绝取回');
  if (/^[a-zA-Z]:/u.test(source) || source.startsWith('/') || source.startsWith('\\')) throw new Error('备份来源路径越界，已拒绝取回');
  const segments = source.split(/[\\/]/u);
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('备份来源路径越界，已拒绝取回');
  const base = path.basename(source).replace(/\.[^.]+$/u, '');
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').trim().slice(0, 80);
  return cleaned || fallback;
}
function ensureInside(root: string, target: string) {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('取回目标越界，已拒绝');
  return target;
}
/** 把原始草稿另存为书目录里的新章节，绝不覆盖原稿。 */
export async function restoreRawDraft(root: string, projectId: string, id: string, bookRoot: string, now = new Date()) {
  const { directory, bytes } = await readBackupBytes(root, projectId, id, 'draft');
  const meta = await readBackupMetadata(directory, id, 'draft');
  const source = meta?.sourcePath ?? '';
  const base = safeSourceName(source, '草稿');
  const extension = id.endsWith('.txt') ? '.txt' : '.docx';
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  const realBookRoot = await fs.realpath(bookRoot), target = ensureInside(realBookRoot, path.join(realBookRoot, `${base}-取回-${stamp}${extension}`));
  if (directory !== await backupDirectory(root, projectId) || realBookRoot !== await fs.realpath(bookRoot)) throw new Error('备份或小说目录已变化，请重新读取后取回');
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return { path: path.relative(realBookRoot, target).split(path.sep).join('/') };
}

/** 预览历史版本的正文；DOCX 用 mammoth 只取文字，不改文件。 */
export async function readPreviousVersion(root: string, projectId: string, id: string) {
  const { bytes } = await readBackupBytes(root, projectId, id, 'previous');
  if (id.endsWith('.txt')) return { id, text: decodeText(bytes).text, warnings: ['TXT 仅纯文本预览'] };
  const preview = await mammoth.convertToHtml({ buffer: bytes });
  return { id, text: preview.value, warnings: preview.messages.map(message => message.message) };
}
/** 把历史版本另存为书目录里的新章节，绝不覆盖当前原稿。 */
export async function restorePreviousVersion(root: string, projectId: string, id: string, bookRoot: string, now = new Date()) {
  const { directory, bytes } = await readBackupBytes(root, projectId, id, 'previous');
  const meta = await readBackupMetadata(directory, id, 'previous');
  const source = meta?.sourcePath ?? '';
  const base = safeSourceName(source, '章节');
  const extension = id.endsWith('.txt') ? '.txt' : '.docx';
  const stamp = now.toISOString().replace(/[:.]/gu, '-');
  const realBookRoot = await fs.realpath(bookRoot), target = ensureInside(realBookRoot, path.join(realBookRoot, `${base}-历史版-${stamp}${extension}`));
  if (directory !== await backupDirectory(root, projectId) || realBookRoot !== await fs.realpath(bookRoot)) throw new Error('备份或小说目录已变化，请重新读取后取回');
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return { path: path.relative(realBookRoot, target).split(path.sep).join('/') };
}

export async function pruneRawDrafts(root: string, projectId: string, options: { keep?: number; olderThanDays?: number; dryRun?: boolean } = {}) {
  return pruneEntries(root, projectId, 'draft', options);
}
/** 历史版本也按同样规则清理：最新 keep 份永远保留（默认 50 份 / 90 天）。 */
export async function prunePreviousVersions(root: string, projectId: string, options: { keep?: number; olderThanDays?: number; dryRun?: boolean } = {}) {
  return pruneEntries(root, projectId, 'previous', { keep: 50, olderThanDays: 90, ...options });
}
async function pruneEntries(root: string, projectId: string, suffix: 'draft' | 'previous', options: { keep?: number; olderThanDays?: number; dryRun?: boolean } = {}) {
  const validated = z.object({ keep: z.number().int().min(1).max(20000).optional(), olderThanDays: z.number().finite().nonnegative().optional(), dryRun: z.boolean().optional() }).strict().parse(options);
  const entries = await listBackupEntries(root, projectId, suffix);
  const directory = await backupDirectory(root, projectId);
  const pattern = new RegExp(`-${suffix}\\.(docx|txt)$`, 'u');
  const prune = selectDraftsToPrune(entries, validated);
  if (!validated.dryRun && directory) {
    for (const entry of prune) {
      if (directory !== await backupDirectory(root, projectId)) throw new Error('备份目录清理期间已变化，已停止');
      await checkedBackupFile(directory, entry.id);
      await readBackupMetadata(directory, entry.id, suffix);
      await fs.rm(path.join(directory, entry.id), { force: true });
      await fs.rm(path.join(directory, entry.id.replace(pattern, `-${suffix}.meta.json`)), { force: true });
    }
  }
  return { total: entries.length, pruned: prune.length, kept: entries.length - prune.length, ids: prune.map(item => item.id) };
}
