import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertBlueprints, blueprintFor, isStale, normalizeBlueprint, type BlueprintNode } from '../core/blueprint';
import type { Workspace } from './workspace';

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
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(z.uuid().parse(projectId));
    return path.join(path.dirname(project.root), '创作资料', `蓝图-${project.name}.json`);
  }
  private async staleList(projectId: string, nodes: BlueprintNode[]) {
    const chapters = await this.workspace.chapters(projectId).catch(() => []);
    const hashes = new Map<string, string>();
    for (const chapter of chapters) {
      try { hashes.set(chapter.path, (await this.workspace.readChapter(projectId, chapter.path)).hash); } catch { /* unreadable chapter cannot be compared */ }
    }
    return nodes.filter(node => node.scope === 'chapter' && isStale(node, hashes.get(node.ref))).map(node => ({ ref: node.ref, title: node.title }));
  }
  async read(projectId: string): Promise<BlueprintSnapshot> {
    const file = await this.file(projectId);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nodes: [], updatedAt: '', hash: '', stale: [] }; throw error; }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('蓝图文件损坏或版本不受支持，原文件已保留');
    const nodes = parsed.data.nodes as BlueprintNode[];
    return { nodes, updatedAt: parsed.data.updatedAt, hash: hashOf(nodes), stale: await this.staleList(projectId, nodes) };
  }
  async save(projectId: string, input: BlueprintNode[], expectedHash: string): Promise<BlueprintSnapshot> {
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('蓝图已被其他窗口修改，请刷新后重试');
      const nodes = input.map(item => { const clean = normalizeBlueprint(item); return { ...clean, id: clean.id || randomUUID(), updatedAt: new Date().toISOString() }; });
      assertBlueprints(nodes);
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const previous = await fs.readFile(file, 'utf8').catch(() => null);
      if (previous !== null) {
        const history = path.join(path.dirname(file), '蓝图历史');
        await fs.mkdir(history, { recursive: true });
        await fs.writeFile(path.join(history, `${Date.now()}.json`), previous, { flag: 'wx' }).catch(() => {});
      }
      const updatedAt = new Date().toISOString();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, updatedAt, nodes }), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return { nodes, updatedAt, hash: hashOf(nodes), stale: await this.staleList(projectId, nodes) };
    });
  }
  async forRef(projectId: string, scope: 'volume' | 'chapter', ref: string) {
    return blueprintFor((await this.read(projectId)).nodes, scope, ref);
  }
}
function hashOf(nodes: BlueprintNode[]) {
  const text = JSON.stringify(nodes.map(item => [item.scope, item.ref, item.title, item.goals, item.beats.join('\u0001'), item.sourceHash ?? '']));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
