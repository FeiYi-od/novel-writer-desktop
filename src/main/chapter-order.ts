import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChapterOrderSnapshot } from '../shared/contracts';
import type { Workspace } from './workspace';

const digest = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, target: string) => { const r = path.relative(root, target); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const key = (relative: string) => path.normalize(relative).toLowerCase();
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), paths: z.array(z.string().min(1).max(2000)).max(10000) }).strict();

export class ChapterOrderStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async location(id: string) {
    const project = this.workspace.getProject(z.uuid().parse(id));
    const directory = path.join(project.root, '小说资料');
    if (!inside(project.root, await fs.realpath(directory))) throw new Error('章节顺序资料目录链接越界');
    return { directory, file: path.join(directory, 'chapter-order.json') };
  }
  private async raw(id: string): Promise<Buffer | null> {
    const { file } = await this.location(id);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('章节顺序文件类型、链接或大小不受支持');
      return await fs.readFile(file);
    } catch (e) { if (absent(e)) return null; throw e; }
  }
  private async snapshot(id: string): Promise<ChapterOrderSnapshot> {
    const raw = await this.raw(id); let stored: z.infer<typeof schema>;
    try { stored = raw === null ? { schemaVersion: 1, projectId: id, paths: [] } : schema.parse(JSON.parse(raw.toString('utf8'))); }
    catch { throw new Error('章节顺序损坏或版本不支持，原文件已保留'); }
    if (stored.projectId !== id) throw new Error('章节顺序属于其他小说');
    const paths = await this.workspace.resolveChapterPaths(id, stored.paths);
    if (new Set(paths.map(key)).size !== paths.length) throw new Error('章节顺序存在重复路径或重复历史名称，请核对原文件');
    const scanned = await this.workspace.chapters(id);
    if (scanned.length > 10000) throw new Error('章节数量超过当前排序上限');
    if (new Set(scanned.map(chapter => key(chapter.path))).size !== scanned.length) throw new Error('章节目录存在大小写重复名称，请核对文件');
    const current = new Map(scanned.map(chapter => [key(chapter.path), chapter]));
    const ordered = paths.map(p => current.get(key(p))?.path ?? p);
    const seen = new Set(ordered.map(key));
    for (const chapter of scanned) if (!seen.has(key(chapter.path))) { ordered.push(chapter.path); seen.add(key(chapter.path)); }
    if (ordered.length > 10000) throw new Error('章节顺序超过当前上限，请核对缺失记录');
    const value = { schemaVersion: 1 as const, projectId: id, paths: ordered };
    // Filename inventory participates in the revision. Body edits do not.
    const hash = digest(JSON.stringify({ record: raw === null ? '' : digest(raw), value, current: scanned.map(c => c.path) }));
    return { value, hash, entries: ordered.map(p => ({ path: p, name: path.basename(p), present: current.has(key(p)) })) };
  }
  read(id: string) { return this.serial(() => this.snapshot(id)); }
  save(id: string, input: string[], expectedHash: string): Promise<ChapterOrderSnapshot> {
    return this.serial(async () => {
      z.string().regex(/^[a-f0-9]{64}$/).parse(expectedHash);
      const requested = z.array(z.string().min(1).max(2000)).max(10000).parse(input);
      const current = await this.snapshot(id);
      if (current.hash !== expectedHash) throw new Error('章节目录或顺序已变化，请刷新后核对；本次排列仍保留');
      const normalized = await this.workspace.resolveChapterPaths(id, requested);
      const actual = new Map(current.value.paths.map(p => [key(p), p]));
      if (normalized.length !== actual.size || new Set(normalized.map(key)).size !== normalized.length || normalized.some(p => !actual.has(key(p)))) throw new Error('请提交完整章节排列，包含缺失项；不能重复、遗漏或加入其他路径');
      const paths = normalized.map(p => actual.get(key(p))!);
      const nextRaw = JSON.stringify({ schemaVersion: 1, projectId: id, paths }, null, 2);
      if (Buffer.byteLength(nextRaw, 'utf8') > 2 * 1024 * 1024) throw new Error('章节顺序记录超过2MiB，请核对过长路径与缺失记录');
      const { directory, file } = await this.location(id), old = await this.raw(id);
      if (old) {
        const history = path.join(directory, 'chapter-order-history'); await fs.mkdir(history, { recursive: true });
        if (!inside(directory, await fs.realpath(history))) throw new Error('章节顺序备份目录链接越界');
        const backup = path.join(history, digest(old) + '.json');
        try { await fs.writeFile(backup, old, { flag: 'wx' }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; const stat = await fs.lstat(backup); if (!stat.isFile() || stat.isSymbolicLink() || !(await fs.readFile(backup)).equals(old)) throw new Error('章节顺序备份存在异常，原文件已保留'); }
      }
      const temp = path.join(directory, randomUUID() + '.order.tmp');
      try {
        await fs.writeFile(temp, nextRaw, { flag: 'wx' });
        if ((await this.snapshot(id)).hash !== expectedHash) throw new Error('保存期间章节目录或顺序变化，请刷新核对；本次排列仍保留');
        if (old === null) {
          // First creation must not overwrite a concurrently created record.
          await fs.link(temp, file);
        } else {
          for (let attempt = 0; ; attempt++) {
            try { await fs.rename(temp, file); break; }
            catch (e) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; await new Promise(r => setTimeout(r, 30 * 2 ** attempt)); if ((await this.snapshot(id)).hash !== expectedHash) throw new Error('章节顺序已在外部更新，本次排列仍保留'); }
          }
        }
      } finally { await fs.unlink(temp).catch(e => { if (!absent(e)) throw e; }); }
      return this.snapshot(id);
    });
  }
}
