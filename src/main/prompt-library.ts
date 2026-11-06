import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertTemplates, normalizeTemplate, withNewVersion, type PromptTemplate } from '../core/prompt-library';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const versionSchema = z.object({ version: z.number().int().min(1), body: z.string().max(20000), savedAt: z.string().max(40) });
const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), templates: z.array(z.object({
  id: z.uuid(), name: z.string().min(1).max(60), kind: z.enum(['write', 'review', 'planning', 'other']),
  body: z.string().min(1).max(20000), version: z.number().int().min(1), updatedAt: z.string().max(40), versions: z.array(versionSchema).max(20)
})).max(200) });
const deletionSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), items: z.array(z.object({
  id: z.uuid(), name: z.string().max(60), kind: z.enum(['write', 'review', 'planning', 'other']), versions: z.number().int().min(1), removedAt: z.string().max(40)
})).max(200) });
export interface PromptDeletionEntry { id: string; name: string; kind: 'write' | 'review' | 'planning' | 'other'; versions: number; removedAt: string }
/** 删除审计：模板被移除时记下名称、类型、版本数与时间，最多保留 200 条（丢最旧）。 */
export class PromptDeletionLog {
  private readonly record: ProjectRecord<z.infer<typeof deletionSchema>>;
  constructor(workspace: Workspace) { this.record = new ProjectRecord(workspace, '提示词删除记录', deletionSchema); }
  async read(projectId: string): Promise<{ items: PromptDeletionEntry[]; hash: string }> {
    const saved = await this.record.read(projectId);
    return { items: (saved.value?.items ?? []) as PromptDeletionEntry[], hash: saved.hash };
  }
  async append(projectId: string, removed: { id: string; name: string; kind: 'write' | 'review' | 'planning' | 'other'; versions: number }[]) {
    if (!removed.length) return this.read(projectId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.read(projectId);
      const now = new Date().toISOString();
      const items = [...current.items, ...removed.map(item => ({ ...item, removedAt: now }))].slice(-200);
      try {
        const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: now, items }, current.hash);
        return { items: saved.value!.items as PromptDeletionEntry[], hash: saved.hash };
      } catch (error) { if (!/已被其他窗口修改|重新读取/u.test(String(error)) || attempt === 2) throw error; }
    }
    return this.read(projectId);
  }
}

export interface PromptSnapshot { templates: PromptTemplate[]; updatedAt: string; hash: string }
/** Named prompt templates with versions, stored as project material next to the book. */
export class PromptLibraryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly record: ProjectRecord<z.infer<typeof fileSchema>>;
  private readonly deletions: PromptDeletionLog;
  constructor(private readonly workspace: Workspace) { this.record = new ProjectRecord(workspace, '提示词库', fileSchema); this.deletions = new PromptDeletionLog(workspace); }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }

  async read(projectId: string): Promise<PromptSnapshot> {
    const saved = await this.record.read(projectId);
    const data = saved.value; if (!data) { return { templates: [], updatedAt: "", hash: "" }; }
    return { templates: data.templates as PromptTemplate[], updatedAt: data.updatedAt, hash: saved.hash };
  }

  async save(projectId: string, input: PromptTemplate[], expectedHash: string): Promise<PromptSnapshot> {
    input = structuredClone(input);
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('提示词库已被其他窗口修改，请刷新后重试');
      const now = new Date().toISOString();
      const previous = new Map(current.templates.map(item => [item.id, item]));
      const templates = input.map(item => {
        const clean = normalizeTemplate(item);
        const id = clean.id || randomUUID();
        const before = previous.get(id);
        const base: PromptTemplate = before ? { ...before, name: clean.name, kind: clean.kind } : { ...clean, id, updatedAt: now };
        return { ...withNewVersion(base, clean.body, now), id };
      });
      assertTemplates(templates);
      const keep = new Set(templates.map(item => item.id));
      const removed = current.templates.filter(item => !keep.has(item.id)).map(item => ({ id: item.id, name: item.name, kind: item.kind, versions: (item.versions?.length ?? 0) + 1 }));
      const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: now, templates: templates }, expectedHash);
      await this.deletions.append(projectId, removed);
      const data = saved.value!;
      return { templates: data.templates as PromptTemplate[], updatedAt: data.updatedAt, hash: saved.hash };

    });
  }

  /** 读取删除审计记录（界面展示用）。 */
  readDeletionLog(projectId: string) { return this.deletions.read(projectId); }
}
