import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Project, RenameChapterRequest } from '../shared/contracts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, target: string) => { const r = path.relative(root, target); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const key = (relative: string) => path.normalize(relative).toLowerCase();
const operationSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), id: z.uuid(), from: z.string().min(1).max(2000), to: z.string().min(1).max(2000), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string(), status: z.enum(['prepared', 'committed', 'cancelled']) });
type Operation = z.infer<typeof operationSchema>;

/** Immutable old-name bindings protect summaries and historical AI requests.
 * No old name can be reused for a different chapter. Draft writes must use the
 * current path; only source reads are redirected to the renamed chapter. */
export class ChapterPaths {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly getProject: (id: string) => Project) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private project(id: string) { return this.getProject(z.uuid().parse(id)); }
  private relative(project: Project, input: string) {
    if (typeof input !== 'string' || !input || path.isAbsolute(input) || input.includes(':') || input.split(/[\\/]/).includes('..')) throw new Error('无效章节路径或路径越界');
    const file = path.resolve(project.root, input), relative = path.relative(project.root, file);
    if (!inside(project.root, file) || relative.split(path.sep)[0].toLowerCase() === '小说资料' || !/\.(docx|txt)$/i.test(relative)) throw new Error('章节路径越界或格式不受支持');
    return relative;
  }
  private async directory(project: Project) {
    const metadata = await fs.realpath(path.join(project.root, '小说资料'));
    if (!inside(project.root, metadata)) throw new Error('重命名资料目录链接越界');
    const directory = path.join(project.root, '小说资料', 'chapter-renames');
    await fs.mkdir(directory, { recursive: true });
    if (!inside(project.root, await fs.realpath(directory))) throw new Error('重命名资料目录链接越界');
    return directory;
  }
  private async safeFile(project: Project, relative: string) {
    const file = path.join(project.root, this.relative(project, relative));
    const parent = await fs.realpath(path.dirname(file));
    if (path.relative(path.dirname(file), parent) !== '') throw new Error('章节目录含链接，不能重命名');
    return file;
  }
  private async bytes(file: string): Promise<Buffer | null> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) throw new Error('重命名文件类型、链接或大小不受支持');
      return await fs.readFile(file);
    } catch (e) { if (missing(e)) return null; throw e; }
  }
  private async write(directory: string, operation: Operation) {
    const file = path.join(directory, 'operation.json'), temp = path.join(directory, randomUUID() + '.tmp');
    try {
      await fs.writeFile(temp, JSON.stringify(operation, null, 2), { flag: 'wx' });
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temp, file); break; }
        catch (e) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; await new Promise(r => setTimeout(r, 30 * 2 ** attempt)); }
      }
    } finally { await fs.unlink(temp).catch(e => { if (!missing(e)) throw e; }); }
  }
  private async finish(project: Project, directory: string, operation: Operation) {
    const source = await this.safeFile(project, operation.from), target = await this.safeFile(project, operation.to);
    const archive = path.join(directory, 'original' + path.extname(operation.from));
    const [oldBytes, newBytes, archived] = await Promise.all([this.bytes(source), this.bytes(target), this.bytes(archive)]);
    if (oldBytes && !newBytes && !archived) { operation.status = 'cancelled'; await this.write(directory, operation); return; }
    if (!oldBytes && newBytes && archived && hash(archived) === operation.sourceHash) {
      // The move happened before a crash. Keep even externally edited target
      // bytes; their new hash will correctly invalidate old story summaries.
      operation.status = 'committed'; await this.write(directory, operation); return;
    }
    if (oldBytes && newBytes && !archived && hash(oldBytes) === operation.sourceHash && hash(newBytes) === operation.sourceHash) {
      // Both resolved absolute paths stay inside the selected novel. Moving
      // the source to the unique journal folder retains its original bytes.
      if (!inside(project.root, source) || !inside(project.root, archive)) throw new Error('重命名归档路径越界');
      await fs.rename(source, archive);
      const moved = (await this.bytes(archive))!;
      if (hash(moved) !== operation.sourceHash) throw new Error('重命名期间原文变化，双方及归档已保留，请核对文件');
      operation.status = 'committed'; await this.write(directory, operation); return;
    }
    throw new Error('重命名尚未完成或文件发生冲突，双方及原稿快照已保留，请核对文件后重试');
  }
  private async load(project: Project): Promise<Operation[]> {
    const root = await this.directory(project), records: Operation[] = [];
    const names = (await fs.readdir(root)).filter(name => z.uuid().safeParse(name).success);
    if (names.length > 1000) throw new Error('重命名记录超过当前上限，请保留记录并检查');
    for (const id of names) {
      const directory = path.join(root, id);
      if (!inside(root, await fs.realpath(directory))) throw new Error('重命名记录链接越界');
      const raw = await this.bytes(path.join(directory, 'operation.json')); if (raw === null) continue;
      const operation = operationSchema.parse(JSON.parse(raw.toString('utf8')));
      if (operation.projectId !== project.id || operation.id !== id) throw new Error('重命名记录属于其他小说或身份错误');
      operation.from = this.relative(project, operation.from); operation.to = this.relative(project, operation.to);
      if (key(operation.from) === key(operation.to)) throw new Error('重命名记录路径无效');
      if (operation.status === 'prepared') await this.finish(project, directory, operation);
      if (operation.status === 'committed') records.push(operation);
    }
    const froms = new Set<string>();
    for (const record of records) {
      if (froms.has(key(record.from))) throw new Error('重命名旧路径重复，已停止读取'); froms.add(key(record.from));
      try { if (await this.bytes(await this.safeFile(project, record.from))) throw new Error('历史章节名称已被外部重新占用，请核对并保留双方文件'); }
      catch (e) { if (!missing(e)) throw e; }
    }
    return records;
  }
  private resolved(input: string, records: Operation[]) {
    let relative = input; const visited = new Set<string>();
    for (;;) {
      if (visited.has(key(relative))) throw new Error('重命名路径循环，已停止读取'); visited.add(key(relative));
      const next = records.find(record => key(record.from) === key(relative));
      if (!next) return relative; relative = next.to;
    }
  }
  resolve(id: string, relative: string) { return this.serial(async () => { const project = this.project(id); return this.resolved(this.relative(project, relative), await this.load(project)); }); }
  resolveMany(id: string, input: string[]) { return this.serial(async () => { const project = this.project(id), records = await this.load(project); return z.array(z.string().min(1).max(2000)).max(10000).parse(input).map(relative => this.resolved(this.relative(project, relative), records)); }); }
  check(id: string) { return this.serial(async () => { await this.load(this.project(id)); }); }
  rename(input: RenameChapterRequest): Promise<string> {
    return this.serial(async () => {
      const request = z.object({ projectId: z.uuid(), path: z.string().min(1).max(2000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).max(120) }).parse(input);
      if (request.name.trim() !== request.name || /[<>:"/\\|?*\x00-\x1f]/u.test(request.name) || /[. ]$/u.test(request.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(request.name)) throw new Error('章节名称含无效或Windows保留字符，请修改');
      const project = this.project(request.projectId), records = await this.load(project), from = this.relative(project, request.path);
      if (this.resolved(from, records) !== from) throw new Error('章节已经重命名，请重新打开当前文件');
      const to = path.join(path.dirname(from), request.name + path.extname(from));
      if (key(from) === key(to)) throw new Error('章节名称与当前名称相同');
      if (records.some(r => key(r.from) === key(to) || key(r.to) === key(to))) throw new Error('此名称属于历史章节，请换一个名称，避免历史记录串稿');
      const source = await this.safeFile(project, from), target = await this.safeFile(project, to);
      if ((await fs.readdir(path.dirname(source))).some(name => name.toLowerCase() === path.basename(to).toLowerCase())) throw new Error('目标名称已存在，不能覆盖已有文件');
      const bytes = await this.bytes(source);
      if (!bytes || hash(bytes) !== request.expectedHash) throw new Error('原文已被其他程序修改，请重新打开后重命名');
      const id = randomUUID(), directory = path.join(await this.directory(project), id); await fs.mkdir(directory);
      if (!inside(project.root, await fs.realpath(directory))) throw new Error('原稿归档路径越界');
      await fs.writeFile(path.join(directory, 'snapshot' + path.extname(from)), bytes, { flag: 'wx' });
      const operation: Operation = { schemaVersion: 1, projectId: project.id, id, from, to, sourceHash: request.expectedHash, createdAt: new Date().toISOString(), status: 'prepared' };
      await this.write(directory, operation);
      // COPYFILE_EXCL reserves the new filename without overwriting a racer.
      try { await fs.copyFile(path.join(directory, 'snapshot' + path.extname(from)), target, constants.COPYFILE_EXCL); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') { operation.status = 'cancelled'; await this.write(directory, operation); } throw e; }
      await this.finish(project, directory, operation);
      if (operation.status !== 'committed') throw new Error('重命名未写入，请重新检查');
      return to;
    });
  }
  /** Moves a chapter into another folder of the same novel. Old-path bindings are kept, so
   * summaries, confirmations and historical requests that reference the old path still resolve
   * to this file. Refuses to overwrite anything and never leaves the novel folder. */
  move(input: { projectId: string; path: string; expectedHash: string; folder: string }): Promise<string> {
    return this.serial(async () => {
      const request = z.object({ projectId: z.uuid(), path: z.string().min(1).max(2000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/), folder: z.string().max(1000) }).parse(input);
      const project = this.project(request.projectId), records = await this.load(project), from = this.relative(project, request.path);
      if (this.resolved(from, records) !== from) throw new Error('章节已经移动或重命名，请重新打开当前文件');
      const folder = request.folder.replace(/[\\/]+$/u, '');
      if (folder && (path.isAbsolute(folder) || folder.includes(':') || folder.split(/[\\/]/u).includes('..'))) throw new Error('目标文件夹路径越界，已拒绝移动');
      if (folder && folder.split(/[\\/]/u)[0].toLowerCase() === '小说资料'.toLowerCase()) throw new Error('不能把正文移动到小说资料目录');
      const to = path.join(folder, path.basename(from));
      if (key(from) === key(to)) throw new Error('章节已经在这个文件夹里');
      if (records.some(record => key(record.from) === key(to) || key(record.to) === key(to))) throw new Error('目标路径属于历史章节，请换一个文件夹，避免历史记录串稿');
      const source = await this.safeFile(project, from);
      const bytes = await this.bytes(source);
      if (!bytes || hash(bytes) !== request.expectedHash) throw new Error('原文已被其他程序修改，请重新打开后再移动');
      const directory = path.join(project.root, folder);
      await fs.mkdir(directory, { recursive: true });
      if (!inside(project.root, await fs.realpath(directory))) throw new Error('目标文件夹链接越界');
      if ((await fs.readdir(directory)).some(name => name.toLowerCase() === path.basename(to).toLowerCase())) throw new Error('目标文件夹已有同名文件，不能覆盖');
      const target = path.join(directory, path.basename(to));
      const id = randomUUID(), journal = path.join(await this.directory(project), id); await fs.mkdir(journal);
      await fs.writeFile(path.join(journal, 'snapshot' + path.extname(from)), bytes, { flag: 'wx' });
      const operation: Operation = { schemaVersion: 1, projectId: project.id, id, from, to, sourceHash: request.expectedHash, createdAt: new Date().toISOString(), status: 'prepared' };
      await this.write(journal, operation);
      try { await fs.copyFile(path.join(journal, 'snapshot' + path.extname(from)), target, constants.COPYFILE_EXCL); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') { operation.status = 'cancelled'; await this.write(journal, operation); } throw e; }
      await this.finish(project, journal, operation);
      if (operation.status !== 'committed') throw new Error('移动未完成，请重新检查文件');
      return to;
    });
  }
}
