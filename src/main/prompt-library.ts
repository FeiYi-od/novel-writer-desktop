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
export interface PromptSnapshot { templates: PromptTemplate[]; updatedAt: string; hash: string }
/** Named prompt templates with versions, stored as project material next to the book. */
export class PromptLibraryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly record: ProjectRecord<z.infer<typeof fileSchema>>;
  constructor(private readonly workspace: Workspace) { this.record = new ProjectRecord(workspace, '提示词库', fileSchema); }
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
      const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: now, templates: templates }, expectedHash);
      const data = saved.value!;
      return { templates: data.templates as PromptTemplate[], updatedAt: data.updatedAt, hash: saved.hash };

    });
  }
}
