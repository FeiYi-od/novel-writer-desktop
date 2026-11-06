import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const journalSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), from: z.string().min(1), to: z.string().min(1), libraryBefore: z.string().max(4 * 1024 * 1024), metadataHash: z.string().regex(/^[a-f0-9]{64}$/u), rootDev: z.number(), rootIno: z.number() }).strict();
type Journal = z.infer<typeof journalSchema>;

export function checkedFolderName(input: string) {
  const name = z.string().min(1).max(120).parse(input);
  if (name !== name.trim() || /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(name) || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) || name === '.' || name === '..') throw new Error('文件夹名称含无效字符或 Windows 保留名称');
  return name;
}

/** Directory.Move refuses an existing destination. The command is constant; paths are passed via
 * environment variables, so names are never interpreted as PowerShell code. */
export async function moveWithoutReplace(from: string, to: string) {
  if (process.platform !== 'win32') throw new Error('文件夹改名目前仅支持 Windows');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('无法找到 Windows 系统工具，未执行改名');
  try {
    await execute(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $drive=[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:STARWRITING_FOLDER_FROM)); if ($drive.DriveType -ne [System.IO.DriveType]::Fixed -and $drive.DriveType -ne [System.IO.DriveType]::Removable) { throw 'unsupported drive type' }; [System.IO.Directory]::Move($env:STARWRITING_FOLDER_FROM, $env:STARWRITING_FOLDER_TO)"], { windowsHide: true, timeout: 30000, env: { ...process.env, STARWRITING_FOLDER_FROM: from, STARWRITING_FOLDER_TO: to } });
  } catch { throw new Error('无法重命名文件夹；请确认目标不存在、目录未被占用且位于本地或可移动磁盘，目标不会被覆盖'); }
}

export class ProjectFolderRename {
  private readonly journalFile: string;
  private readonly libraryFile: string;
  constructor(private readonly localData: string, private readonly move = moveWithoutReplace) {
    this.journalFile = path.join(localData, 'folder-rename-pending.json');
    this.libraryFile = path.join(localData, 'library.json');
  }
  private async readRegular(file: string, max: number) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('书架索引或操作记录类型异常，原文件已保留');
    return fs.readFile(file);
  }
  private roots(raw: string) { return z.array(z.string().min(1)).max(10000).parse(JSON.parse(raw)); }
  private validateJournal(value: Journal) {
    if (!path.isAbsolute(value.from) || !path.isAbsolute(value.to) || !same(path.dirname(value.from), path.dirname(value.to)) || same(value.from, value.to) || path.resolve(value.from) !== value.from || path.resolve(value.to) !== value.to) throw new Error('文件夹改名记录路径异常，原记录已保留');
    checkedFolderName(path.basename(value.to));
    const roots = this.roots(value.libraryBefore);
    if (roots.filter(root => same(root, value.from)).length !== 1 || roots.some(root => same(root, value.to))) throw new Error('文件夹改名记录与书架索引不匹配，原记录已保留');
    return JSON.stringify(roots.map(root => same(root, value.from) ? value.to : root), null, 2);
  }
  private async verifyRoot(root: string, record: Journal) {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== record.rootDev || stat.ino !== record.rootIno || !same(await fs.realpath(root), root)) throw new Error('小说目录身份已变化，无法自动完成改名');
    const metadata = await this.projectMetadata(root);
    if (digest(metadata) !== record.metadataHash || z.object({ id: z.uuid() }).passthrough().parse(JSON.parse(metadata.toString('utf8'))).id !== record.projectId) throw new Error('小说身份资料已变化，无法自动完成改名');
  }
  private async projectMetadata(root: string) {
    const directory = path.join(root, '小说资料'), stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await fs.realpath(directory), directory)) throw new Error('小说身份资料目录包含链接，已停止操作');
    return this.readRegular(path.join(directory, 'project.json'), 1024 * 1024);
  }
  private async exists(file: string) { try { await fs.lstat(file); return true; } catch (error) { if (absent(error)) return false; throw error; } }
  async pendingProjectId() {
    try { return journalSchema.parse(JSON.parse((await this.readRegular(this.journalFile, 5 * 1024 * 1024)).toString('utf8'))).projectId; }
    catch { return null; }
  }
  hasPending() { return this.exists(this.journalFile); }
  private async libraryBytes() { return this.readRegular(this.libraryFile, 4 * 1024 * 1024); }
  private async writeLibrary(record: Journal, next: string) {
    const original = Buffer.from(record.libraryBefore, 'utf8');
    const history = path.join(this.localData, 'folder-rename-history'); await fs.mkdir(history, { recursive: true });
    const stat = await fs.lstat(history);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(await fs.realpath(history), history)) throw new Error('书架索引备份目录异常，未覆盖索引');
    const backup = path.join(history, `${digest(original)}.json`);
    try { await fs.writeFile(backup, original, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!(await this.readRegular(backup, 4 * 1024 * 1024)).equals(original)) throw new Error('书架索引备份异常，未覆盖索引'); }
    const temp = `${this.libraryFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, next, { flag: 'wx' });
      if (!(await this.libraryBytes()).equals(original)) throw new Error('书架索引在改名期间变化，请保留双方文件并核对');
      await this.verifyRoot(record.to, record);
      if (await this.exists(record.from)) throw new Error('旧文件夹已重新出现，请保留双方目录并核对');
      await fs.rename(temp, this.libraryFile);
    } finally { await fs.rm(temp, { force: true }); }
  }
  /** Called before reading the library on startup. Ambiguous states are preserved, never guessed. */
  async recover() {
    let bytes: Buffer;
    try { bytes = await this.readRegular(this.journalFile, 5 * 1024 * 1024); }
    catch (error) { if (absent(error)) return; throw error; }
    let record: Journal;
    try { record = journalSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch { throw new Error('文件夹改名记录损坏或版本不支持，原记录已保留'); }
    const next = this.validateJournal(record), oldExists = await this.exists(record.from), newExists = await this.exists(record.to);
    const library = await this.libraryBytes();
    if (oldExists) {
      await this.verifyRoot(record.from, record);
      if (!library.equals(Buffer.from(record.libraryBefore))) throw new Error('书架索引已变化，文件夹改名记录保留，请核对');
    } else if (newExists) {
      await this.verifyRoot(record.to, record);
      if (library.equals(Buffer.from(record.libraryBefore))) await this.writeLibrary(record, next);
      else if (!library.equals(Buffer.from(next))) throw new Error('书架索引已变化，文件夹改名记录保留，请核对');
    } else throw new Error('新旧小说目录均不可访问，文件夹改名记录已保留');
    if (!(await this.readRegular(this.journalFile, 5 * 1024 * 1024)).equals(bytes)) throw new Error('文件夹改名记录已变化，未自动清理');
    await fs.unlink(this.journalFile);
  }
  async rename(project: { id: string; root: string }, name: string) {
    const safe = checkedFolderName(name), from = path.resolve(project.root), parent = path.dirname(from), to = path.join(parent, safe);
    if (parent === from || same(from, to)) throw new Error('新文件夹名称与当前名称相同，或仅改变大小写');
    if (from.startsWith('\\\\')) throw new Error('网络目录的文件夹改名尚未开放，请先使用本地目录');
    if (await this.exists(this.journalFile)) throw new Error('已有未完成的文件夹改名记录，请先重新启动并核对');
    const root = await fs.lstat(from), parentStat = await fs.lstat(parent);
    if (!root.isDirectory() || root.isSymbolicLink() || !parentStat.isDirectory() || parentStat.isSymbolicLink() || !same(await fs.realpath(from), from) || !same(await fs.realpath(parent), parent)) throw new Error('小说或父目录包含链接，不能安全改名');
    if ((await fs.readdir(parent)).some(item => item.toLowerCase() === safe.toLowerCase())) throw new Error('目标文件夹已存在，不能覆盖');
    const metadata = await this.projectMetadata(from);
    if (z.object({ id: z.uuid() }).passthrough().parse(JSON.parse(metadata.toString('utf8'))).id !== project.id) throw new Error('小说身份已变化，未执行改名');
    const original = await this.libraryBytes(), libraryBefore = original.toString('utf8');
    if (!Buffer.from(libraryBefore, 'utf8').equals(original)) throw new Error('书架索引不是有效 UTF-8，原文件已保留');
    const record: Journal = { schemaVersion: 1, projectId: z.uuid().parse(project.id), from, to, libraryBefore, metadataHash: digest(metadata), rootDev: root.dev, rootIno: root.ino };
    this.validateJournal(record);
    const temporary = `${this.journalFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx' }); await fs.link(temporary, this.journalFile); }
    finally { await fs.rm(temporary, { force: true }); }
    try {
      await this.verifyRoot(from, record);
      if (!(await this.libraryBytes()).equals(original)) throw new Error('书架索引已变化，未执行改名');
      await this.move(from, to);
      await this.recover();
      return to;
    } catch (error) {
      try {
        await this.recover();
        if (!(await this.exists(from)) && await this.exists(to)) { await this.verifyRoot(to, record); return to; }
      } catch { /* preserve ambiguous journal and both locations */ }
      throw error;
    }
  }
}
