import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertStates, normalizeState, type CharacterState } from '../core/character-states';
import type { Workspace } from './workspace';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), states: z.array(z.object({
  id: z.uuid(), character: z.string().min(1).max(120), label: z.string().min(1).max(40), note: z.string().max(1000),
  fromChapter: z.number().int().min(1).optional(), toChapter: z.number().int().min(1).optional()
})).max(500) });
export interface StateSnapshot { states: CharacterState[]; updatedAt: string; hash: string }
/** Character states with chapter ranges, stored as project material with a history copy. */
export class CharacterStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(z.uuid().parse(projectId));
    return path.join(path.dirname(project.root), '创作资料', `人物状态-${project.name}.json`);
  }
  async read(projectId: string): Promise<StateSnapshot> {
    const file = await this.file(projectId);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { states: [], updatedAt: '', hash: '' }; throw error; }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('人物状态文件损坏或版本不受支持，原文件已保留');
    const states = parsed.data.states as CharacterState[];
    return { states, updatedAt: parsed.data.updatedAt, hash: hashOf(states) };
  }
  async save(projectId: string, input: CharacterState[], expectedHash: string): Promise<StateSnapshot> {
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('人物状态已被其他窗口修改，请刷新后重试');
      const states = input.map(item => { const clean = normalizeState(item); return { ...clean, id: clean.id || randomUUID() }; });
      assertStates(states);
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const previous = await fs.readFile(file, 'utf8').catch(() => null);
      if (previous !== null) {
        const history = path.join(path.dirname(file), '人物状态历史');
        await fs.mkdir(history, { recursive: true });
        await fs.writeFile(path.join(history, `${Date.now()}.json`), previous, { flag: 'wx' }).catch(() => {});
      }
      const updatedAt = new Date().toISOString();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, updatedAt, states }), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return { states, updatedAt, hash: hashOf(states) };
    });
  }
}
function hashOf(states: CharacterState[]) {
  const text = JSON.stringify(states.map(item => [item.character, item.label, item.note, item.fromChapter ?? 0, item.toChapter ?? 0]));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
