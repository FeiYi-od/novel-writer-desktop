import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Workspace } from './workspace';

export interface BackupEntry { path: string; bytes: number; sha256: string }
export interface BackupResult { folder: string; files: number; bytes: number; entries: BackupEntry[]; skipped: string[]; materialsFiles: number }
interface Manifest {
  schemaVersion: 1 | 2; projectId: string; projectName: string; createdAt: string;
  files: number; bytes: number; materials: number; entries: BackupEntry[]; skipped: number;
}
export interface ArchiveFile extends BackupEntry { root: string; relative: string }
export interface ArchiveSnapshot {
  projectId: string; projectName: string; roots: string[]; entries: ArchiveFile[]; skipped: string[]; materialsFiles: number;
}
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);
const MAX_FILES = 20_000, MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const BOOK_PREFIX = 'book';
export const MATERIALS_PREFIX = 'materials';
const LEGACY_MATERIALS_PREFIX = '资料';
const META = '小说资料';
const MARKER = 'restore-materials.json';
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const canonicalKey = (relative: string) => relative.normalize('NFC').toLowerCase();

/** 清单可跨 Windows 设备恢复，不允许 ADS、设备名、尾随点/空格或等价路径。 */
function portableRelative(value: unknown, maxLength = 400, maxDepth = 40): value is string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\\:*?"<>|\u0000-\u001f\u007f]/u.test(value) || value.startsWith('/')) return false;
  const parts = value.split('/');
  return parts.length <= maxDepth && parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
export function isSafeRelative(value: unknown): value is string { return portableRelative(value); }
export function safeName(value: string, fallback = '书') {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '_').trim().replace(/[. ]+$/u, '').slice(0, 80);
  if (!cleaned || /^\.+$/u.test(cleaned)) return fallback;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned) ? `_${cleaned}` : cleaned;
}

async function directoryRoot(directory: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('归档目录不能是链接或非目录');
  return fs.realpath(directory);
}
/** 逐层 lstat，不能只用 path.relative 检查一个表面上在包内的目录链接。 */
async function regularFile(root: string, relative: string) {
  if (!portableRelative(relative, 512, 42)) throw new Error('归档文件路径不安全');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('归档文件包含目录链接或符号链接');
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('归档路径不是普通文件');
  }
  if (!within(root, await fs.realpath(current))) throw new Error('归档文件链接越界');
  return current;
}
async function fingerprint(root: string, relative: string, limit = MAX_FILE_BYTES) {
  const file = await regularFile(root, relative);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error('归档文件过大或不是普通文件');
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('归档文件读取期间超过大小限制');
      digest.update(chunk);
    }
    const after = await handle.stat();
    const current = await fs.lstat(await regularFile(root, relative));
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== current.ino || before.dev !== current.dev) throw new Error('归档期间原文件发生变化，请重新执行');
    return { bytes, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}
async function futureRealPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if (!absent(error)) throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await futureRealPath(parent), path.basename(absolute));
  }
}
export async function assertArchiveTarget(roots: string[], target: string) {
  const absolute = path.resolve(target), real = await futureRealPath(absolute);
  if (roots.some(root => within(root, absolute) || within(root, real))) throw new Error('备份或导出目标不能放在本书正文或固定资料目录内');
  return real;
}
async function materialsDirectory(workspace: Workspace, projectId: string) {
  if (!workspace.materialsRoot) return null;
  let root: string;
  try { root = await directoryRoot(workspace.materialsRoot); }
  catch (error) { if (absent(error)) return null; throw error; }
  const directory = path.join(root, projectId);
  try { return await directoryRoot(directory); }
  catch (error) { if (absent(error)) return null; throw error; }
}
function checkEntryPaths(entries: BackupEntry[], invalid: string[]) {
  const paths = new Set<string>(), spellings = new Map<string, string>();
  for (const entry of entries) {
    const key = canonicalKey(entry.path);
    if (paths.has(key)) invalid.push(`重复路径：${entry.path}`);
    paths.add(key);
    const parts = entry.path.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const prefix = parts.slice(0, count).join('/'), normalized = canonicalKey(prefix);
      if (spellings.has(normalized) && spellings.get(normalized) !== prefix) invalid.push(`等价目录名冲突：${entry.path}`);
      spellings.set(normalized, prefix);
    }
  }
  for (const entry of entries) {
    const parts = canonicalKey(entry.path).split('/');
    for (let index = 1; index < parts.length; index++) {
      if (paths.has(parts.slice(0, index).join('/'))) { invalid.push(`文件与目录冲突：${entry.path}`); break; }
    }
  }
}
/** 两个独立分区保留书中自己的 manifest.json/资料，不再与控制文件合并。 */
export async function collectArchive(workspace: Workspace, projectId: string): Promise<ArchiveSnapshot> {
  const project = workspace.getProject(projectId);
  const root = await directoryRoot(project.root), materials = await materialsDirectory(workspace, projectId);
  const entries: ArchiveFile[] = [], skipped: string[] = []; let total = 0, visited = 0;
  const walk = async (base: string, directory: string, prefix: string, depth: number) => {
    if (depth > 38 || ++visited > MAX_FILES) throw new Error('归档目录层级或数量过多');
    const names = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of names) {
      const source = path.join(directory, item.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`归档源包含目录链接或符号链接：${item.name}`);
      if (SKIP.has(item.name)) { skipped.push(source); continue; }
      const relative = path.relative(base, source).split(path.sep).join('/');
      if (!isSafeRelative(`${prefix}/${relative}`)) throw new Error(`归档文件名不能安全地在 Windows 恢复：${relative}`);
      if (stat.isDirectory()) { await walk(base, source, prefix, depth + 1); continue; }
      if (!stat.isFile()) throw new Error(`归档源不是普通文件：${relative}`);
      if (entries.length >= MAX_FILES) throw new Error('归档文件超过 20000 个');
      const value = await fingerprint(base, relative);
      total += value.bytes;
      if (total > MAX_TOTAL_BYTES) throw new Error('归档内容超过 8 GiB，请分开备份');
      entries.push({ path: `${prefix}/${relative}`, root: base, relative, ...value });
    }
  };
  await walk(root, root, BOOK_PREFIX, 0);
  const bookFiles = entries.length;
  if (materials) await walk(materials, materials, MATERIALS_PREFIX, 0);
  const invalid: string[] = []; checkEntryPaths(entries, invalid);
  if (invalid.length) throw new Error(`归档内容有名称冲突：${invalid[0]}`);
  if (!entries.length) throw new Error('这本书目录里没有可归档的文件');
  const metadata = entries.find(entry => entry.path === `${BOOK_PREFIX}/${META}/project.json`);
  if (!metadata || metadata.bytes > 1024 * 1024) throw new Error('本书项目归属资料缺失或过大');
  checkProjectMetadata(await readArchiveFile(metadata), projectId);
  return { projectId, projectName: project.name, roots: materials ? [root, materials] : [root], entries, skipped, materialsFiles: entries.length - bookFiles };
}
export function archiveManifest(snapshot: ArchiveSnapshot, now: Date): Manifest {
  return { schemaVersion: 2, projectId: snapshot.projectId, projectName: snapshot.projectName, createdAt: now.toISOString(), files: snapshot.entries.length,
    bytes: snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0), materials: snapshot.materialsFiles,
    entries: snapshot.entries.map(({ path: relative, bytes, sha256 }) => ({ path: relative, bytes, sha256 })), skipped: snapshot.skipped.length };
}
export async function readArchiveFile(entry: ArchiveFile) {
  const file = await regularFile(entry.root, entry.relative), handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== entry.bytes || before.size > MAX_FILE_BYTES) throw new Error('归档期间原文件发生变化');
    const data = Buffer.alloc(entry.bytes); let read = 0;
    while (read < data.length) {
      const chunk = await handle.read(data, read, Math.min(64 * 1024, data.length - read), read);
      if (!chunk.bytesRead) break;
      read += chunk.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, read), after = await handle.stat();
    if (read !== entry.bytes || extra.bytesRead || createHash('sha256').update(data).digest('hex') !== entry.sha256 || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('归档期间原文件发生变化');
    await regularFile(entry.root, entry.relative);
    return data;
  } finally { await handle.close(); }
}
function checkProjectMetadata(data: Buffer, projectId: string) {
  let value: any;
  try { value = JSON.parse(data.toString('utf8')); } catch { throw new Error('项目归属资料损坏，已保留原件'); }
  if (!value || value.schemaVersion !== 1 || value.id !== projectId || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('项目资料版本或 projectId 与归档归属不匹配');
}
async function newFolder(targetDir: string, base: string) {
  await fs.mkdir(targetDir, { recursive: true }); const root = await directoryRoot(targetDir);
  for (let index = 1; index <= 50; index++) {
    const folder = path.join(root, index === 1 ? base : `${base}-${index}`);
    try { await fs.mkdir(folder); return folder; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  throw new Error('目标目录重名过多，请另选位置');
}
async function ensureParent(root: string, relative: string) {
  const parts = relative.split('/'); let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, await fs.realpath(directory))) throw new Error('归档目标目录包含链接或文件冲突');
  }
  if (!within(root, path.join(root, ...parts))) throw new Error('归档目标越界');
  return path.join(root, ...parts);
}

export async function backupBook(workspace: Workspace, projectId: string, targetDir: string, now = new Date()): Promise<BackupResult> {
  const snapshot = await collectArchive(workspace, projectId);
  const target = await assertArchiveTarget(snapshot.roots, targetDir);
  const folder = await newFolder(target, `${safeName(snapshot.projectName)}-${now.toISOString().replace(/[:.]/gu, '-')}`);
  for (const entry of snapshot.entries) {
    const source = await regularFile(entry.root, entry.relative), destination = await ensureParent(folder, entry.path);
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    const copied = await fingerprint(folder, entry.path);
    if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) throw new Error(`备份期间原文件发生变化：${entry.path}；不完整目录已保留，不作为有效备份`);
    await regularFile(entry.root, entry.relative);
  }
  const manifest = archiveManifest(snapshot, now);
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
  const verified = await verifyBackup(folder);
  if (!verified.ok) throw new Error('新备份完整性校验失败，请保留原件并重新备份');
  return { folder, files: manifest.files, bytes: manifest.bytes, entries: manifest.entries, skipped: snapshot.skipped, materialsFiles: snapshot.materialsFiles };
}

async function readManifest(folder: string): Promise<{ root: string; manifest: Manifest | null; invalid: string[]; hash: string }> {
  const invalid: string[] = []; let root: string, text: string;
  try {
    root = await directoryRoot(folder);
    const file = await regularFile(root, 'manifest.json');
    if ((await fs.stat(file)).size > MAX_MANIFEST_BYTES) throw new Error('清单过大');
    text = await fs.readFile(file, 'utf8');
  } catch { return { root: path.resolve(folder), manifest: null, invalid: ['manifest.json 无法安全读取'], hash: '' }; }
  const hash = createHash('sha256').update(text).digest('hex');
  let value: any;
  try { value = JSON.parse(text); } catch { return { root, manifest: null, invalid: ['manifest.json 不是有效 JSON'], hash }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { root, manifest: null, invalid: ['manifest.json 结构无效'], hash };
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return { root, manifest: null, invalid: ['未知 schemaVersion，已保留原包'], hash };
  if (typeof value.projectId !== 'string' || !UUID.test(value.projectId)) invalid.push('projectId');
  if (typeof value.projectName !== 'string' || !value.projectName.trim() || value.projectName.length > 200) invalid.push('projectName');
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) invalid.push('createdAt');
  if (!Array.isArray(value.entries) || !value.entries.length || value.entries.length > MAX_FILES) invalid.push('entries');
  const entries: BackupEntry[] = [];
  for (const item of Array.isArray(value.entries) && value.entries.length <= MAX_FILES ? value.entries : []) {
    if (!item || typeof item !== 'object' || !isSafeRelative(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE_BYTES || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) { invalid.push('清单文件字段无效'); continue; }
    if (value.schemaVersion === 2 && (!item.path.includes('/') || ![BOOK_PREFIX, MATERIALS_PREFIX].includes(item.path.split('/')[0]))) invalid.push(`未知分区：${item.path}`);
    if (value.schemaVersion === 1 && canonicalKey(item.path) === 'manifest.json') invalid.push('旧包的控制清单与原件重名');
    entries.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
  }
  checkEntryPaths(entries, invalid);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const materials = entries.filter(entry => entry.path.startsWith(`${value.schemaVersion === 1 ? LEGACY_MATERIALS_PREFIX : MATERIALS_PREFIX}/`)).length;
  if (!Number.isSafeInteger(value.files) || value.files !== entries.length) invalid.push('files');
  if (!Number.isSafeInteger(value.bytes) || value.bytes !== bytes || bytes > MAX_TOTAL_BYTES) invalid.push('bytes');
  if (value.materials !== undefined && (!Number.isSafeInteger(value.materials) || value.materials !== materials)) invalid.push('materials');
  if (value.schemaVersion === 2 && value.materials === undefined) invalid.push('materials');
  if (value.skipped !== undefined && (!Number.isSafeInteger(value.skipped) || value.skipped < 0)) invalid.push('skipped');
  return { root, manifest: { schemaVersion: value.schemaVersion, projectId: value.projectId, projectName: value.projectName, createdAt: value.createdAt, files: entries.length, bytes, materials, entries, skipped: value.skipped ?? 0 }, invalid, hash };
}
async function verifyParsed(parsed: Awaited<ReturnType<typeof readManifest>>) {
  const invalid = [...parsed.invalid], mismatch: string[] = [], missing: string[] = [];
  if (parsed.manifest && !invalid.length) {
    for (const entry of parsed.manifest.entries) {
      try {
        const actual = await fingerprint(parsed.root, entry.path);
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) mismatch.push(entry.path);
      } catch (error) {
        if (absent(error)) missing.push(entry.path); else invalid.push(`无法安全读取：${entry.path}`);
      }
    }
    const metadataPath = `${parsed.manifest.schemaVersion === 2 ? BOOK_PREFIX + '/' : ''}${META}/project.json`;
    const metadata = parsed.manifest.entries.find(entry => entry.path === metadataPath);
    if (!metadata || metadata.bytes > 1024 * 1024) invalid.push('项目归属资料缺失或过大');
    else try { checkProjectMetadata(await readArchiveFile({ ...metadata, root: parsed.root, relative: metadata.path }), parsed.manifest.projectId); }
    catch { invalid.push('项目资料版本或 projectId 与清单不匹配'); }
  }
  return { ok: !!parsed.manifest && !invalid.length && !mismatch.length && !missing.length, checked: parsed.manifest?.entries.length ?? 0, mismatch, missing, invalid };
}
/** schema1 继续可读；未知版本/链接/重复等价路径/总量或实际大小不符一律拒绝。 */
export async function verifyBackup(folder: string) { return verifyParsed(await readManifest(folder)); }

export async function restoreBackup(folder: string, targetDir: string, now = new Date()) {
  const parsed = await readManifest(folder), checked = await verifyParsed(parsed);
  if (!checked.ok || !parsed.manifest) throw new Error(`备份校验失败（被改动 ${checked.mismatch.length} 个、丢失 ${checked.missing.length} 个、清单异常 ${checked.invalid.length} 处），已拒绝恢复`);
  const manifest = parsed.manifest;
  const target = await assertArchiveTarget([parsed.root], targetDir);
  const destination = await newFolder(target, `${safeName(manifest.projectName)} -恢复-${now.toISOString().replace(/[:.]/gu, '-')}`);
  let materialsRelative: string | null = null;
  if (manifest.schemaVersion === 2 && manifest.materials) {
    materialsRelative = `${META}/restore-materials-${randomUUID()}`;
    await ensureParent(destination, `${materialsRelative}/placeholder`);
  }
  let materialsFolder: string | null = null;
  for (const entry of manifest.entries) {
    const relative = manifest.schemaVersion === 1 ? entry.path : entry.path.startsWith(`${BOOK_PREFIX}/`) ? entry.path.slice(BOOK_PREFIX.length + 1) : `${materialsRelative}/${entry.path.slice(MATERIALS_PREFIX.length + 1)}`;
    if (!portableRelative(relative, 512, 42)) throw new Error('恢复目标路径不安全，已保留不完整恢复目录');
    const source = await regularFile(parsed.root, entry.path), copy = await ensureParent(destination, relative);
    await fs.copyFile(source, copy, fs.constants.COPYFILE_EXCL);
    const actual = await fingerprint(destination, relative);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`恢复后校验失败：${entry.path}；原包和不完整恢复目录已保留`);
    if (manifest.schemaVersion === 1 && entry.path.startsWith(`${LEGACY_MATERIALS_PREFIX}/`)) materialsFolder = path.join(destination, LEGACY_MATERIALS_PREFIX);
  }
  const reread = await readManifest(parsed.root);
  if (reread.hash !== parsed.hash || reread.invalid.length) throw new Error('恢复期间备份清单发生变化，请保留原包并重试');
  if (materialsRelative) {
    materialsFolder = path.join(destination, ...materialsRelative.split('/'));
    const marker = `${META}/${MARKER}`, file = await ensureParent(destination, marker);
    try {
      const old = await fs.readFile(await regularFile(destination, marker));
      const history = await ensureParent(destination, `${META}/restore-materials-history/${randomUUID()}.json`);
      await fs.writeFile(history, old, { flag: 'wx' });
      // 仅替换刚从备份恢复并留档的应用指针，不覆盖正文、资料或源包。
      await fs.unlink(file);
    } catch (error) { if (!absent(error)) throw error; }
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: manifest.projectId, directory: materialsRelative }, null, 2), { encoding: 'utf8', flag: 'wx' });
  }
  return { folder: destination, materialsFolder, files: manifest.entries.length, bytes: manifest.bytes };
}
