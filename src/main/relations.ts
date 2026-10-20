import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertRelations, groupRelations, normalizeRelation, type Relation } from '../core/relations';
import type { Workspace } from './workspace';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), relations: z.array(z.object({
  id: z.uuid(), from: z.string().min(1).max(120), to: z.string().min(1).max(120), label: z.string().min(1).max(60),
  note: z.string().max(1000), mutual: z.boolean(), strength: z.number().int().min(1).max(5)
})).max(300) });
export interface RelationSnapshot { relations: Relation[]; groups: ReturnType<typeof groupRelations>; updatedAt: string; hash: string }
/** Character relations stored next to the book materials, with atomic writes, a history copy and a
 * hash so two windows cannot silently overwrite each other. */
export class RelationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(z.uuid().parse(projectId));
    return path.join(path.dirname(project.root), '创作资料', `人物关系-${project.name}.json`);
  }
  async read(projectId: string): Promise<RelationSnapshot> {
    const file = await this.file(projectId);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relations: [], groups: [], updatedAt: '', hash: '' }; throw error; }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('人物关系文件损坏或版本不受支持，原文件已保留');
    const relations = parsed.data.relations as Relation[];
    return { relations, groups: groupRelations(relations), updatedAt: parsed.data.updatedAt, hash: hashOf(relations) };
  }
  async save(projectId: string, input: Relation[], expectedHash: string): Promise<RelationSnapshot> {
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('人物关系已被其他窗口修改，请刷新后重试');
      const relations = input.map(item => { const clean = normalizeRelation(item); return { ...clean, id: clean.id || randomUUID() }; });
      assertRelations(relations);
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const previous = await fs.readFile(file, 'utf8').catch(() => null);
      if (previous !== null) {
        const history = path.join(path.dirname(file), '人物关系历史');
        await fs.mkdir(history, { recursive: true });
        await fs.writeFile(path.join(history, `${Date.now()}.json`), previous, { flag: 'wx' }).catch(() => {});
      }
      const updatedAt = new Date().toISOString();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, updatedAt, relations }), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return { relations, groups: groupRelations(relations), updatedAt, hash: hashOf(relations) };
    });
  }
}
function hashOf(relations: Relation[]) {
  const text = JSON.stringify(relations.map(item => [item.from, item.to, item.label, item.note, item.mutual, item.strength]));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
