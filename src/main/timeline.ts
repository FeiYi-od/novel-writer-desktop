import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertTimelineSize, normalizeEntry, sortTimeline, type TimelineEntry } from '../core/timeline';
import type { Workspace } from './workspace';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), entries: z.array(z.object({
  id: z.uuid(), when: z.string().min(1).max(60), title: z.string().min(1).max(120), note: z.string().max(2000), chapterPath: z.string().max(2000).optional()
})).max(500) });
export interface TimelineSnapshot { entries: TimelineEntry[]; updatedAt: string; hash: string }
/** Story timeline stored next to the book materials as plain JSON, with atomic writes and a
 * history copy of the previous version so an accidental edit can be reviewed later. */
export class TimelineStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(z.uuid().parse(projectId));
    const directory = path.join(path.dirname(project.root), '创作资料');
    return path.join(directory, `时间线-${project.name}.json`);
  }
  async read(projectId: string): Promise<TimelineSnapshot> {
    const file = await this.file(projectId);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], updatedAt: '', hash: '' }; throw error; }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('时间线文件损坏或版本不受支持，原文件已保留');
    const entries = sortTimeline(parsed.data.entries as TimelineEntry[]);
    return { entries, updatedAt: parsed.data.updatedAt, hash: hashOf(parsed.data.entries) };
  }
  async save(projectId: string, entries: TimelineEntry[], expectedHash: string): Promise<TimelineSnapshot> {
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('时间线已被其他窗口修改，请刷新后重试');
      const normalized = entries.map(item => { const clean = normalizeEntry(item); return { ...clean, id: clean.id || randomUUID() }; });
      assertTimelineSize(normalized);
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const previous = await fs.readFile(file, 'utf8').catch(() => null);
      if (previous !== null) {
        const history = path.join(path.dirname(file), '时间线历史');
        await fs.mkdir(history, { recursive: true });
        await fs.writeFile(path.join(history, `${Date.now()}.json`), previous, { flag: 'wx' }).catch(() => {});
      }
      const updatedAt = new Date().toISOString();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, updatedAt, entries: normalized }), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return { entries: sortTimeline(normalized), updatedAt, hash: hashOf(normalized) };
    });
  }
}
function hashOf(entries: TimelineEntry[]) {
  let text = JSON.stringify(entries.map(item => [item.when, item.title, item.note, item.chapterPath ?? '']));
  // FNV-1a keeps the token short and stable without pulling in a crypto dependency.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
