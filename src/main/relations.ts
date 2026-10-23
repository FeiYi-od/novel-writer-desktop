import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertRelations, groupRelations, normalizeRelation, type Relation } from '../core/relations';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), relations: z.array(z.object({
  id: z.uuid(), from: z.string().min(1).max(120), to: z.string().min(1).max(120), label: z.string().min(1).max(60),
  note: z.string().max(1000), mutual: z.boolean(), strength: z.number().int().min(1).max(5)
})).max(300) });
export interface RelationSnapshot { relations: Relation[]; groups: ReturnType<typeof groupRelations>; updatedAt: string; hash: string }
/** Character relations stored next to the book materials, with atomic writes, a history copy and a
 * hash so two windows cannot silently overwrite each other. */
export class RelationStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly record: ProjectRecord<z.infer<typeof fileSchema>>;
  constructor(private readonly workspace: Workspace) { this.record = new ProjectRecord(workspace, '人物关系', fileSchema); }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }

  async read(projectId: string): Promise<RelationSnapshot> {
    const saved = await this.record.read(projectId);
    const data = saved.value; if (!data) { return { relations: [], groups: [], updatedAt: "", hash: "" }; }
    const relations = data.relations as Relation[]; return { relations, groups: groupRelations(relations), updatedAt: data.updatedAt, hash: saved.hash };
  }

  async save(projectId: string, input: Relation[], expectedHash: string): Promise<RelationSnapshot> {
    input = structuredClone(input);
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('人物关系已被其他窗口修改，请刷新后重试');
      const relations = input.map(item => { const clean = normalizeRelation(item); return { ...clean, id: clean.id || randomUUID() }; });
      assertRelations(relations);
      const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: new Date().toISOString(), relations: relations }, expectedHash);
      const data = saved.value!;
      return { relations: data.relations as Relation[], groups: groupRelations(data.relations), updatedAt: data.updatedAt, hash: saved.hash };

    });
  }
}
