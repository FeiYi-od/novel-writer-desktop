import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertBlueprints, blueprintFor, isStale, normalizeBlueprint, type BlueprintNode } from '../core/blueprint';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), nodes: z.array(z.object({
  id: z.uuid(), scope: z.enum(['volume', 'chapter']), ref: z.string().min(1).max(2000), title: z.string().min(1).max(120),
  goals: z.string().max(5000), beats: z.array(z.string().max(300)).max(50), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), updatedAt: z.string().max(40)
})).max(1000) });
export interface BlueprintSnapshot {
  nodes: BlueprintNode[]; updatedAt: string; hash: string;
  /** Chapter plans whose recorded source hash no longer matches the current text. */
  stale: { ref: string; title: string }[];
}
/** Volume/chapter plans stored as project material, with a history copy and a hash guard. */
export class BlueprintStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly record: ProjectRecord<z.infer<typeof fileSchema>>;
  constructor(private readonly workspace: Workspace) { this.record = new ProjectRecord(workspace, '蓝图', fileSchema); }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }

  private async staleList(projectId: string, nodes: BlueprintNode[]) {
    const chapters = await this.workspace.chapters(projectId).catch(() => []);
    const hashes = new Map<string, string>();
    for (const chapter of chapters) {
      try { hashes.set(chapter.path, (await this.workspace.readChapter(projectId, chapter.path)).hash); } catch { /* unreadable chapter cannot be compared */ }
    }
    return nodes.filter(node => node.scope === 'chapter' && isStale(node, hashes.get(node.ref))).map(node => ({ ref: node.ref, title: node.title }));
  }
  async read(projectId: string): Promise<BlueprintSnapshot> {
    const saved = await this.record.read(projectId);
    const data = saved.value; if (!data) { return { nodes: [], updatedAt: "", hash: "", stale: [] }; }
    const nodes = data.nodes as BlueprintNode[]; return { nodes, updatedAt: data.updatedAt, hash: saved.hash, stale: await this.staleList(projectId, nodes) };
  }

  async save(projectId: string, input: BlueprintNode[], expectedHash: string): Promise<BlueprintSnapshot> {
    input = structuredClone(input);
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('蓝图已被其他窗口修改，请刷新后重试');
      const nodes = input.map(item => { const clean = normalizeBlueprint(item); return { ...clean, id: clean.id || randomUUID(), updatedAt: new Date().toISOString() }; });
      assertBlueprints(nodes);
      const saved = await this.record.save(projectId, { schemaVersion: 1, projectId, updatedAt: new Date().toISOString(), nodes: nodes }, expectedHash);
      const data = saved.value!;
      return { nodes: data.nodes as BlueprintNode[], updatedAt: data.updatedAt, hash: saved.hash, stale: await this.staleList(projectId, data.nodes) };

    });
  }
  async forRef(projectId: string, scope: 'volume' | 'chapter', ref: string) {
    return blueprintFor((await this.read(projectId)).nodes, scope, ref);
  }
}
