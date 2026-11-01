import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';

/** Limits apply to the entire explicitly selected tree, not just its manifest. */
export const SILLY_PLUGIN_INSPECT_LIMITS = Object.freeze({
  files: 256, directories: 128, entries: 384, depth: 8, pathCharacters: 1024,
  fileBytes: 2 * 1024 * 1024, manifestBytes: 64 * 1024, totalBytes: 8 * 1024 * 1024
});

export interface SillyPluginFile { path: string; bytes: number; sha256: string }
export interface SillyPluginInspection {
  schemaVersion: 1;
  projectId: string;
  fingerprint: string;
  displayName: string;
  version: string | null;
  js: { path: string; exists: boolean } | null;
  css: { path: string; exists: boolean } | null;
  hooks: { activate: string | null; clean: string | null; other: string[] };
  requires: string[];
  optional: string[];
  license: { present: boolean; files: string[]; declared: string | null };
  files: SillyPluginFile[];
  totalBytes: number;
  warnings: string[];
  executed: false;
}

type Stamp = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type Directory = { path: string; stamp: Stamp };
type FileSnapshot = SillyPluginFile & { stamp: Stamp };
type Tree = { directories: Directory[]; files: FileSnapshot[]; totalBytes: number; manifest: Buffer };
const validUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
class PluginInspectionError extends Error {}
const same = (a: string, b: string) => path.relative(a, b) === '';
const stamp = (s: Stats): Stamp => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sortByPath = <T extends { path: string }>(items: T[]) => items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const canonical = (value: string) => value.normalize('NFC').toLowerCase();
// Never echo credential-shaped values or URI schemes from untrusted metadata.
// This is a conservative screen, not a guarantee that arbitrary text contains no secret.
const suspiciousMetadata = (value: string) => /\b(?:sk-[a-z0-9_-]{16,}|gh[opusr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AIza[a-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/iu.test(value)
  || /(?:https?|ftp|file|data|javascript|wss?):/iu.test(value)
  || /\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/iu.test(value)
  || /[a-z0-9_+-]{48,}/iu.test(value);
const unsafeMetadata = (value: string) => {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* malformed escapes stay literal */ }
  return suspiciousMetadata(value) || suspiciousMetadata(decoded);
};

function safePart(part: string) {
  return part.length > 0 && part.length <= 255 && part !== '.' && part !== '..' && !unsafeMetadata(part) && !/[\\/:*?"<>|%\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(part)
    && !/[. ]$/u.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part);
}
function relativePath(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > SILLY_PLUGIN_INSPECT_LIMITS.pathCharacters || value.startsWith('/')
    || value.split('/').length > SILLY_PLUGIN_INSPECT_LIMITS.depth || !value.split('/').every(safePart)) throw new PluginInspectionError(`${label}不是安全的插件相对路径`);
  return value;
}
async function checkedDirectory(directory: string): Promise<Stamp> {
  const before = await fs.lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || !same(directory, await fs.realpath(directory))) throw new PluginInspectionError('插件目录包含链接或越界路径');
  const after = await fs.lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || !equal(stamp(before), stamp(after))) throw new PluginInspectionError('插件目录在检查期间已变化');
  return stamp(after);
}

async function readFile(file: string, relative: string): Promise<{ bytes: number; sha256: string; stamp: Stamp; manifest?: Buffer }> {
  const limits = SILLY_PLUGIN_INSPECT_LIMITS, max = relative === 'manifest.json' ? limits.manifestBytes : limits.fileBytes;
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max || !same(file, await fs.realpath(file))) throw new PluginInspectionError('插件文件包含链接、异常类型或超过大小上限');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !equal(stamp(before), stamp(opened))) throw new PluginInspectionError('插件文件读取前已变化');
    const digest = createHash('sha256'), chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > max) throw new PluginInspectionError('插件文件读取期间超过大小上限');
      digest.update(buffer.subarray(0, bytesRead));
      if (relative === 'manifest.json') chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat(), latest = await fs.lstat(file);
    if (!latest.isFile() || latest.isSymbolicLink() || after.nlink !== 1 || latest.nlink !== 1 || total !== opened.size || !equal(stamp(opened), stamp(after)) || !equal(stamp(after), stamp(latest))
      || !same(file, await fs.realpath(file))) throw new PluginInspectionError('插件文件读取期间已变化');
    return { bytes: total, sha256: digest.digest('hex'), stamp: stamp(latest), ...(relative === 'manifest.json' ? { manifest: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

async function snapshot(root: string): Promise<Tree> {
  const limits = SILLY_PLUGIN_INSPECT_LIMITS;
  const directories: Directory[] = [], files: FileSnapshot[] = [], names = new Set<string>();
  let totalBytes = 0, entries = 0, manifest: Buffer | undefined;
  const walk = async (directory: string, prefix: string, depth: number) => {
    const before = await checkedDirectory(directory);
    directories.push({ path: prefix, stamp: before });
    if (directories.length > limits.directories) throw new PluginInspectionError('插件目录数量超过上限');
    const stream = await fs.opendir(directory);
    for await (const entry of stream) {
      if (++entries > limits.entries) throw new PluginInspectionError('插件文件和目录总数超过上限');
      if (!safePart(entry.name)) throw new PluginInspectionError('插件包含不安全的文件名');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative.length > limits.pathCharacters || names.has(canonical(relative))) throw new PluginInspectionError('插件包含重复、等价或过长的路径');
      names.add(canonical(relative));
      const full = path.join(directory, entry.name), stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new PluginInspectionError('插件包含文件或目录链接');
      if (stat.isDirectory()) {
        if (depth >= limits.depth) throw new PluginInspectionError('插件目录层级超过上限');
        await walk(full, relative, depth + 1);
      } else if (stat.isFile()) {
        if (files.length >= limits.files) throw new PluginInspectionError('插件文件数量超过上限');
        const value = await readFile(full, relative);
        totalBytes += value.bytes;
        if (totalBytes > limits.totalBytes) throw new PluginInspectionError('插件总大小超过上限');
        files.push({ path: relative, bytes: value.bytes, sha256: value.sha256, stamp: value.stamp });
        if (value.manifest) manifest = value.manifest;
      } else throw new PluginInspectionError('插件包含不支持的文件类型');
    }
    if (!equal(before, await checkedDirectory(directory))) throw new PluginInspectionError('插件目录内容在检查期间已变化');
  };
  await walk(root, '', 0);
  if (!manifest) throw new PluginInspectionError('插件目录缺少 manifest.json');
  return { directories: sortByPath(directories), files: sortByPath(files), totalBytes, manifest };
}

function text(value: unknown, label: string, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PluginInspectionError(`${label}缺失`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) || unsafeMetadata(value) || !value.trim()) throw new PluginInspectionError(`${label}无效或过长`);
  return value.trim();
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new PluginInspectionError(`${label}格式无效或超过上限`);
  return value.map((item: unknown) => text(item, label, true)!);
}
function parseManifest(raw: Buffer, tree: Tree, projectId: string): SillyPluginInspection {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new PluginInspectionError('插件 manifest.json 不是有效 UTF-8 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginInspectionError('插件 manifest.json 不是对象');
  const manifest = value as Record<string, unknown>;
  const displayName = text(manifest.display_name, '插件名称', true)!;
  const version = text(manifest.version, '插件版本');
  const jsPath = relativePath(manifest.js, '插件脚本入口'), cssPath = relativePath(manifest.css, '插件样式入口');
  const filePaths = new Set(tree.files.map(file => file.path));
  const entry = (entryPath: string | null) => entryPath === null ? null : { path: entryPath, exists: filePaths.has(entryPath) };
  const hookValue = manifest.hooks;
  if (hookValue !== undefined && hookValue !== null && (typeof hookValue !== 'object' || Array.isArray(hookValue))) throw new PluginInspectionError('插件 hooks 格式无效');
  const hooks = (hookValue ?? {}) as Record<string, unknown>;
  const other = Object.keys(hooks).filter(key => key !== 'activate' && key !== 'clean');
  if (other.length > 64) throw new PluginInspectionError('插件 hooks 数量超过上限');
  const safeOther = other.map(key => text(key, '插件 hook 名称', true)!);
  const requires = strings(manifest.requires, '插件依赖'), optional = strings(manifest.optional, '可选插件依赖');
  const licenses = tree.files.filter(file => !file.path.includes('/') && /^(?:license|licence|copying)(?:\.(?:md|txt))?$/iu.test(file.path)).map(file => file.path);
  const declared = text(manifest.license, '许可证声明');
  const warnings = ['仅检查文件和清单，未执行插件；不能据此认定运行兼容。'];
  if (!jsPath) warnings.push('未声明脚本入口。');
  if (jsPath && !filePaths.has(jsPath)) warnings.push('声明的脚本入口不存在。');
  if (cssPath && !filePaths.has(cssPath)) warnings.push('声明的样式入口不存在。');
  if (!licenses.length) warnings.push('未找到根目录许可证文件；声明不能替代许可核对。');
  if (requires.length || optional.length) warnings.push('依赖仅列出，未验证或加载。');
  if (hookValue) warnings.push('生命周期钩子仅列出，未运行。');
  const files = tree.files.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 }));
  return { schemaVersion: 1, projectId, fingerprint: sha(JSON.stringify({ projectId, directories: tree.directories, files: tree.files })),
    displayName, version, js: entry(jsPath), css: entry(cssPath),
    hooks: { activate: text(hooks.activate, 'activate hook'), clean: text(hooks.clean, 'clean hook'), other: safeOther },
    requires, optional, license: { present: licenses.length > 0, files: licenses, declared }, files, totalBytes: tree.totalBytes, warnings, executed: false };
}

/** Caller must provide a directory explicitly chosen through a trusted main-process picker
 * and validate project membership. The selected files are read only, never executed. */
export async function inspectSillyPlugin(projectId: string, selectedDirectory: string): Promise<SillyPluginInspection> {
  if (typeof projectId !== 'string' || !validUuid.test(projectId)) throw new PluginInspectionError('插件检查的小说标识无效');
  if (typeof selectedDirectory !== 'string' || !path.isAbsolute(selectedDirectory)) throw new PluginInspectionError('请选择插件目录');
  try {
    const root = path.resolve(selectedDirectory);
    // Reject a mistaken non-plugin directory before opening any unrelated file.
    const initialRoot = await checkedDirectory(root);
    const initialManifest = await readFile(path.join(root, 'manifest.json'), 'manifest.json');
    if (!initialManifest.manifest) throw new PluginInspectionError('插件清单缺失');
    parseManifest(initialManifest.manifest, { directories: [], files: [], totalBytes: 0, manifest: initialManifest.manifest }, projectId);
    if (!equal(initialRoot, await checkedDirectory(root))) throw new PluginInspectionError('插件目录在检查期间已变化，请重新选择');
    const first = await snapshot(root);
    const firstManifest = first.files.find(file => file.path === 'manifest.json');
    if (!firstManifest || !equal(initialManifest.stamp, firstManifest.stamp) || initialManifest.sha256 !== firstManifest.sha256
      || !equal(initialRoot, first.directories[0]?.stamp)) throw new PluginInspectionError('插件清单或目录在检查期间已变化，请重新选择');
    const report = parseManifest(first.manifest, first, projectId);
    const second = await snapshot(root);
    if (!equal(first.directories, second.directories) || !equal(first.files, second.files) || first.totalBytes !== second.totalBytes || !first.manifest.equals(second.manifest))
      throw new PluginInspectionError('插件目录或文件在检查期间已变化，请重新选择');
    // A file can be modified after its second read without changing its parent
    // directory's mtime. Recheck every path after both complete scans.
    for (const directory of second.directories) {
      const full = directory.path ? path.join(root, ...directory.path.split('/')) : root;
      if (!equal(directory.stamp, await checkedDirectory(full))) throw new PluginInspectionError('插件目录在检查期间已变化，请重新选择');
    }
    for (const file of second.files) {
      const full = path.join(root, ...file.path.split('/')), latest = await fs.lstat(full);
      if (!latest.isFile() || latest.isSymbolicLink() || latest.nlink !== 1 || !equal(file.stamp, stamp(latest)) || !same(full, await fs.realpath(full)))
        throw new PluginInspectionError('插件文件在检查期间已变化，请重新选择');
    }
    for (const directory of second.directories) {
      const full = directory.path ? path.join(root, ...directory.path.split('/')) : root;
      if (!equal(directory.stamp, await checkedDirectory(full))) throw new PluginInspectionError('插件目录在检查期间已变化，请重新选择');
    }
    return report;
  } catch (error) {
    if (error instanceof PluginInspectionError) throw error;
    // Native filesystem errors may contain absolute paths or other private data.
    throw new PluginInspectionError('无法安全读取所选插件目录，请检查内容与权限');
  }
}
