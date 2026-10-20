import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function statOrNull(file: string) { try { return await fs.lstat(file); } catch (error) { if (missing(error)) return null; throw error; } }
async function directory(root: string, target: string) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await fs.realpath(target))) throw new Error('恢复资料目录或链接异常，原资料已保留');
}
async function safeFile(root: string, target: string) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 || !inside(root, await fs.realpath(target))) throw new Error('恢复资料文件类型、链接或大小异常，原资料已保留');
  return stat;
}

/** Import a restored book's own materials as one directory publication. Never
 * merge a half-copy into existing author data or swallow an import failure. */
export async function importRecoveredMaterials(bookRoot: string, materialsRoot: string, projectId: string) {
  z.uuid().parse(projectId);
  const book = await fs.realpath(bookRoot), marker = path.join(book, '小说资料', 'restore-materials.json');
  const markerStat = await statOrNull(marker);
  let source = path.join(book, '资料');
  if (markerStat) {
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 16384 || !inside(book, await fs.realpath(marker))) throw new Error('恢复资料位置标记类型或大小异常，原记录已保留');
    let value: { projectId: string; directory: string };
    try { value = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), directory: z.string().regex(/^小说资料\/restore-materials-[a-f0-9-]{36}$/) }).strict().parse(JSON.parse(await fs.readFile(marker, 'utf8'))); }
    catch { throw new Error('恢复资料位置标记损坏或版本不受支持，原记录已保留'); }
    if (value.projectId !== projectId) throw new Error('恢复资料的小说归属不匹配，原资料已保留');
    z.uuid().parse(value.directory.slice('小说资料/restore-materials-'.length));
    source = path.join(book, value.directory);
    if (!await statOrNull(source)) throw new Error('恢复资料位置缺失，原记录已保留');
  } else if (!await statOrNull(source)) return;

  await fs.mkdir(materialsRoot, { recursive: true });
  const base = await fs.realpath(materialsRoot), target = path.join(base, projectId), targetStat = await statOrNull(target);
  if (targetStat) {
    await directory(base, target);
    if ((await fs.readdir(target)).length) return; // Existing author data always wins.
  }
  await directory(book, source);
  const files: { relative: string; sha256: string; size: number }[] = [];
  let total = 0, entries = 0;
  const collect = async (folder: string, depth: number) => {
    await directory(source, folder);
    if (depth > 30) throw new Error('恢复资料目录层级过深，原资料已保留');
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (++entries > 20000) throw new Error('恢复资料条目过多，原资料已保留');
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('恢复资料包含目录链接，原资料已保留');
      if (entry.isDirectory()) { await collect(file, depth + 1); continue; }
      const stat = await safeFile(source, file); total += stat.size;
      if (total > 256 * 1024 * 1024) throw new Error('恢复资料总量超过256 MiB，原资料已保留');
      files.push({ relative: path.relative(source, file), sha256: digest(await fs.readFile(file)), size: stat.size });
    }
  };
  await collect(source, 0);
  const stage = path.join(base, `.restore-${projectId}-${randomUUID()}`); await fs.mkdir(stage);
  for (const file of files) {
    const original = path.join(source, file.relative), destination = path.join(stage, file.relative);
    await safeFile(source, original);
    const bytes = await fs.readFile(original);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error('恢复资料复制期间已变化，原件和暂存已保留');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: 'wx' });
  }
  await directory(book, source);
  for (const file of files) {
    const original = path.join(source, file.relative); await safeFile(source, original);
    if (digest(await fs.readFile(original)) !== file.sha256) throw new Error('恢复资料发布前已变化，原件和暂存已保留');
  }
  const latest = await statOrNull(target);
  if (latest) {
    await directory(base, target);
    if (!targetStat || (await fs.readdir(target)).length) throw new Error('本机资料目录已变化，原件和暂存已保留，请重新打开');
    await fs.rmdir(target); // Only an empty, checked directory; never recursively delete data.
  }
  await fs.rename(stage, target);
}
