import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertStates, normalizeState, type CharacterState } from '../core/character-states';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), states: z.array(z.object({
  id: z.uuid(), character: z.string().min(1).max(120), label: z.string().min(1).max(40), note: z.string().max(1000),
  fromChapter: z.number().int().min(1).optional(), toChapter: z.number().int().min(1).optional()
})).max(500) });
export interface StateSnapshot { states: CharacterState[]; updatedAt: string; hash: string }
/** Character states with chapter ranges, stored as project material with a history copy. */
export class CharacterStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly record: ProjectRecord<z.infer<typeof fileSchema>>;
  constructor(private readonly workspace: Workspace) { this.record = new ProjectRecord(workspace, '人物状态', fileSchema); }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }

  async read(projectId: string): Promise<StateSnapshot> {
    const saved = await this.record.read(projectId);
    const data = saved.value; if (!data) { return { states: [], updatedAt: "", hash: "" }; }
    return { states: data.states as CharacterState[], updatedAt: data.updatedAt, hash: saved.hash };
  }

  async save(projectId: string, input: CharacterState[], expectedHash: string): Promise<StateSnapshot> {
    input = structuredClone(input);
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('人物状态已被其他窗口修改，请刷新后重试');
      const states = input.map(item => { const clean = normalizeState(item); return { ...clean, id: clean.id || randomUUID() }; });
      assertStates(states);
      const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: new Date().toISOString(), states: states }, expectedHash);
      const data = saved.value!;
      return { states: data.states as CharacterState[], updatedAt: data.updatedAt, hash: saved.hash };

    });
  }
}
