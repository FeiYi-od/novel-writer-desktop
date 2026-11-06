import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workspace } from './workspace';

const digest = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const key = (value: string) => path.normalize(value).toLowerCase();
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), entries: z.array(z.object({ path: z.string().min(1).max(2000), name: z.string().min(1).max(120) }).strict()).max(10000) }).strict();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Local presentation only: paths remain the chapter identity; text and filenames are never written. */
export class ChapterDisplayNames {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string, private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private file(projectId: string) { this.workspace.getProject(z.uuid().parse(projectId)); return path.join(this.userData, 'chapter-display-names', `${projectId}.json`); }
  private async checkedDirectory(directory: string) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw new Error('章节显示名目录包含链接或已变化，原资料已保留');
  }
  private async raw(projectId: string): Promise<Buffer | null> {
    try {
      const file = this.file(projectId); await this.checkedDirectory(path.dirname(file)); const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('章节显示名文件类型或大小不受支持，原文件已保留');
      return await fs.readFile(file);
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private async snapshot(projectId: string) {
    const raw = await this.raw(projectId);
    let value: z.infer<typeof schema>;
    try { value = raw ? schema.parse(JSON.parse(raw.toString('utf8'))) : { schemaVersion: 1, projectId, entries: [] }; }
    catch { throw new Error('章节显示名资料损坏或版本不支持，原文件已保留'); }
    if (value.projectId !== projectId) throw new Error('章节显示名属于其他小说');
    const paths = await this.workspace.resolveChapterPaths(projectId, value.entries.map(entry => entry.path));
    const entries = value.entries.map((entry, index) => ({ path: paths[index]!, name: entry.name }));
    if (new Set(entries.map(entry => key(entry.path))).size !== entries.length) throw new Error('章节显示名映射冲突，原文件已保留');
    return { entries, hash: raw ? digest(raw) : '' };
  }
  read(projectId: string) { return this.serial(() => this.snapshot(projectId)); }
  set(input: { projectId: string; path: string; expectedChapterHash: string; expectedNamesHash: string; name: string }) {
    const request = z.object({ projectId: z.uuid(), path: z.string().min(1).max(2000), expectedChapterHash: z.string().regex(/^[a-f0-9]{64}$/u), expectedNamesHash: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/u)]), name: z.string().max(120) }).strict().parse(input);
    if (request.name !== request.name.trim() || /[\x00-\x1f\x7f]/u.test(request.name)) throw new Error('显示名不能以空白开头或结尾，也不能包含控制字符');
    return this.serial(async () => {
      const current = await this.snapshot(request.projectId);
      if (current.hash !== request.expectedNamesHash) throw new Error('章节显示名已变化，请关闭窗口后重新打开');
      const resolved = await this.workspace.resolveChapterPath(request.projectId, request.path);
      if (resolved !== path.normalize(request.path)) throw new Error('章节路径已变化，请重新打开章节');
      if (!(await this.workspace.chapters(request.projectId)).some(chapter => key(chapter.path) === key(resolved))) throw new Error('章节不存在，请重新打开章节');
      if (await this.workspace.chapterHash(request.projectId, resolved) !== request.expectedChapterHash) throw new Error('章节内容已变化，请重新打开后修改显示名');
      const entries = current.entries.filter(entry => key(entry.path) !== key(resolved));
      if (request.name) entries.push({ path: resolved, name: request.name });
      const next = Buffer.from(JSON.stringify(schema.parse({ schemaVersion: 1, projectId: request.projectId, entries }), null, 2));
      if (next.length > 2 * 1024 * 1024) throw new Error('章节显示名资料超过 2 MiB');
      const file = this.file(request.projectId), directory = path.dirname(file); await fs.mkdir(directory, { recursive: true });
      await this.checkedDirectory(directory);
      const before = await this.raw(request.projectId);
      if ((before ? digest(before) : '') !== request.expectedNamesHash) throw new Error('章节显示名已变化，请重新打开');
      if (before) {
        const history = path.join(directory, `${request.projectId}-history`); await fs.mkdir(history, { recursive: true });
        await this.checkedDirectory(history);
        const backup = path.join(history, `${digest(before)}.json`);
        try { await fs.writeFile(backup, before, { flag: 'wx' }); }
        catch (error) { if (!((error as NodeJS.ErrnoException).code === 'EEXIST')) throw error; const stat = await fs.lstat(backup); if (!stat.isFile() || stat.isSymbolicLink() || !(await fs.readFile(backup)).equals(before)) throw new Error('显示名备份异常，原文件已保留'); }
      }
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, next, { flag: 'wx' });
        await this.checkedDirectory(directory);
        if ((await this.snapshot(request.projectId)).hash !== request.expectedNamesHash) throw new Error('显示名保存期间已变化，原文件已保留');
        if (await this.workspace.resolveChapterPath(request.projectId, request.path) !== resolved || await this.workspace.chapterHash(request.projectId, resolved) !== request.expectedChapterHash) throw new Error('章节在保存显示名期间变化，原文件已保留');
        if (before) await fs.rename(temp, file); else await fs.link(temp, file);
      } finally { await fs.rm(temp, { force: true }); }
      return this.snapshot(request.projectId);
    });
  }
}
