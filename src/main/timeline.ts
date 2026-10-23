import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertTimelineSize, normalizeEntry, sortTimeline, type TimelineEntry } from '../core/timeline';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), entries: z.array(z.object({
  id: z.uuid(), when: z.string().min(1).max(60), title: z.string().min(1).max(120), note: z.string().max(2000), chapterPath: z.string().max(2000).optional()
})).max(500) });
export interface TimelineSnapshot { entries: TimelineEntry[]; updatedAt: string; hash: string }
/** Story timeline stored next to the book materials as plain JSON, with atomic writes and a
 * history copy of the previous version so an accidental edit can be reviewed later. */
export class TimelineStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly record: ProjectRecord<z.infer<typeof fileSchema>>;
  constructor(private readonly workspace: Workspace) { this.record = new ProjectRecord(workspace, '时间线', fileSchema); }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }

  async read(projectId: string): Promise<TimelineSnapshot> {
    const saved = await this.record.read(projectId);
    const data = saved.value; if (!data) { return { entries: [], updatedAt: "", hash: "" }; }
    const entries = sortTimeline(data.entries as TimelineEntry[]); return { entries, updatedAt: data.updatedAt, hash: saved.hash };
  }

  async save(projectId: string, entries: TimelineEntry[], expectedHash: string): Promise<TimelineSnapshot> {
    entries = structuredClone(entries);
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('时间线已被其他窗口修改，请刷新后重试');
      const normalized = entries.map(item => { const clean = normalizeEntry(item); return { ...clean, id: clean.id || randomUUID() }; });
      assertTimelineSize(normalized);
      const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: new Date().toISOString(), entries: normalized }, expectedHash);
      const data = saved.value!;
      return { entries: sortTimeline(data.entries as TimelineEntry[]), updatedAt: data.updatedAt, hash: saved.hash };

    });
  }
}
