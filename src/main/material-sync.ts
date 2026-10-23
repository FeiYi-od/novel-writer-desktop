import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MaterialSyncDifference, MaterialSyncRequest, MaterialSyncSnapshot } from '../shared/material-sync';
import type { Workspace } from './workspace';
import { isSafeRelative } from './nas-backup';

const META = '小说资料', TRANSPORT = '创作资料同步', VERSIONS = '版本';
const MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024, MAX_FILES = 10000, MAX_REVISIONS = 1000;
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
type Entry = z.infer<typeof entrySchema>;
type Manifest = z.infer<typeof manifestSchema>;
type State = z.infer<typeof stateSchema>;
interface Tree { entries: Entry[]; data: Map<string, Buffer>; fingerprint: string }
interface Revision { manifest: Manifest; folder: string }
interface Inspection { snapshot: MaterialSyncSnapshot; state: State; stateRaw: string | null; local: Tree; remote: Tree;
  revisions: Revision[]; leaves: Revision[]; selected?: Revision; canonical: string; versions: string; book: string }
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ordered = <T extends { path: string }>(entries: T[]) => entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
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
    if (latest.isSymbolicLink() || !latest.isFile() || before.dev !== latest.dev || before.ino !== latest.ino || before.size !== size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('资料同步文件读取期间发生变化');
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
async function scanTree(root: string, projectId: string): Promise<Tree> {
  if (!await statOrNull(root)) return emptyTree();
  await checkedDirectory(root); const data = new Map<string, Buffer>(); let count = 0, bytes = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 30) throw new Error('资料同步目录层级过深'); await checkedDirectory(directory);
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > MAX_FILES) throw new Error('资料同步条目超过10000个');
      const file = path.join(directory, item.name), relative = path.relative(root, file).split(path.sep).join('/'); relativeSchema.parse(relative);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('资料同步源包含目录链接或符号链接');
      if (stat.isDirectory()) { await walk(file, depth + 1); continue; }
      const content = await readRegular(root, relative, MAX_FILE); validateMetadata(content, relative, projectId);
      bytes += content.length; if (bytes > MAX_TOTAL) throw new Error('资料同步总量超过256 MiB'); data.set(relative, content);
    }
  };
  await walk(root, 0); const result = fromData(data); checkPaths(result.entries); return result;
}
function preview(data: Buffer | undefined, relative: string) {
  if (!data || !/\.(?:md|txt|json)$/iu.test(relative)) return undefined;
  return data.toString('utf8').slice(0, 1600);
}

/** Canonical author files remain in the application's fixed per-project directory.
 * Book-local revisions are immutable transport snapshots, never the live store. The
 * caller must hold its IPC/AI barrier while synchronizing; file hashes additionally
 * detect external changes. No watcher, SQLite database or credential is transported. */
export class MaterialSyncService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace, private readonly materialsRoot: string, private readonly userData: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  private project(projectId: string) { return this.workspace.getProject(z.uuid().parse(projectId)); }
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
    if (names.length > MAX_REVISIONS) throw new Error('资料同步版本超过1000个，请先归档历史');
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
  private async publishRevision(context: Inspection, tree: Tree) {
    const locations = await this.bookLocations(context.snapshot.projectId, true);
    if (locations.book !== context.book || locations.versions !== context.versions) throw new Error('小说目录位置已变化，原资料已保留');
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
    const stage = path.join(base, `sync-stage-${id}-${randomUUID()}`); await fs.mkdir(stage); await this.writeFiles(stage, merged);
    if ((await scanTree(stage, id)).fingerprint !== merged.fingerprint) throw new Error('本机资料同步暂存已变化，原件和暂存已保留');
    await this.assertUnchanged(context);
    const history = (await subDirectory(base, `同步历史/${id}`, true))!, archiveId = randomUUID(), archive = path.join(history, archiveId);
    await this.assertUnchanged(context);
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
      if (publish) revisionId = await this.publishRevision(context, merged); else await this.assertUnchanged(context);
      await this.replaceCanonical(context, merged);
      await this.writeState(request.projectId, { schemaVersion: 1, projectId: request.projectId, enabled: context.state.enabled, base: Object.fromEntries(merged.entries.map(entry => [entry.path, entry.sha256])), lastRevision: revisionId, lastSyncedAt: new Date().toISOString() }, context.stateRaw);
      return (await this.inspect(request.projectId)).snapshot;
    });
  }
}
