import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertTemplates, normalizeTemplate, withNewVersion, type PromptTemplate } from '../core/prompt-library';
import type { Workspace } from './workspace';

const versionSchema = z.object({ version: z.number().int().min(1), body: z.string().max(20000), savedAt: z.string().max(40) });
const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), templates: z.array(z.object({
  id: z.uuid(), name: z.string().min(1).max(60), kind: z.enum(['write', 'review', 'planning', 'other']),
  body: z.string().min(1).max(20000), version: z.number().int().min(1), updatedAt: z.string().max(40), versions: z.array(versionSchema).max(20)
})).max(200) });
export interface PromptSnapshot { templates: PromptTemplate[]; updatedAt: string; hash: string }
/** Named prompt templates with versions, stored as project material next to the book. */
export class PromptLibraryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(z.uuid().parse(projectId));
    return path.join(path.dirname(project.root), '创作资料', `提示词库-${project.name}.json`);
  }
  async read(projectId: string): Promise<PromptSnapshot> {
    const file = await this.file(projectId);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { templates: [], updatedAt: '', hash: '' }; throw error; }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('提示词库文件损坏或版本不受支持，原文件已保留');
    const templates = parsed.data.templates as PromptTemplate[];
    return { templates, updatedAt: parsed.data.updatedAt, hash: hashOf(templates) };
  }
  async save(projectId: string, input: PromptTemplate[], expectedHash: string): Promise<PromptSnapshot> {
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
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const old = await fs.readFile(file, 'utf8').catch(() => null);
      if (old !== null) {
        const history = path.join(path.dirname(file), '提示词库历史');
        await fs.mkdir(history, { recursive: true });
        await fs.writeFile(path.join(history, `${Date.now()}.json`), old, { flag: 'wx' }).catch(() => {});
      }
      const updatedAt = now;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, updatedAt, templates }), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return { templates, updatedAt, hash: hashOf(templates) };
    });
  }
}
function hashOf(templates: PromptTemplate[]) {
  const text = JSON.stringify(templates.map(item => [item.name, item.kind, item.body, item.version]));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
