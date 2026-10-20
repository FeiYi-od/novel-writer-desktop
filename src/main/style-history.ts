import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emptyHistory, recordEffect, restoreVersion, reviseRules, type EffectRecord, type StyleHistory } from '../core/style-history';
import type { Workspace } from './workspace';

const versionSchema = z.object({ version: z.number().int().min(1), rules: z.string().min(1).max(20000), savedAt: z.string().max(40) });
const effectSchema = z.object({ at: z.string().max(40), source: z.enum(['trial', 'chapter']), characters: z.number().int().min(0), averageSentence: z.number().min(0), dialogueRatio: z.number().min(0).max(1), note: z.string().max(200).optional() });
const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), entries: z.array(z.object({
  styleId: z.string().min(1).max(120), current: versionSchema, history: z.array(versionSchema).max(10), effects: z.array(effectSchema).max(50)
})).max(200) });
export interface StyleHistorySnapshot { entries: StyleHistory[]; updatedAt: string; hash: string }
/** Style rule versions and effect records, stored as project material with history copies. */
export class StyleHistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(z.uuid().parse(projectId));
    return path.join(path.dirname(project.root), '创作资料', `文风版本-${project.name}.json`);
  }
  async read(projectId: string): Promise<StyleHistorySnapshot> {
    const file = await this.file(projectId);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], updatedAt: '', hash: '' }; throw error; }
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('文风版本文件损坏或版本不受支持，原文件已保留');
    const entries = parsed.data.entries as StyleHistory[];
    return { entries, updatedAt: parsed.data.updatedAt, hash: hashOf(entries) };
  }
  /** Applies one operation under the same hash guard, so two windows cannot overwrite each other. */
  async mutate(projectId: string, expectedHash: string, action: (entries: StyleHistory[]) => StyleHistory[], savedAt = new Date().toISOString()): Promise<StyleHistorySnapshot> {
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('文风版本已被其他窗口修改，请刷新后重试');
      const entries = action(current.entries.map(entry => ({ ...entry, current: { ...entry.current }, history: entry.history.map(item => ({ ...item })), effects: entry.effects.map(item => ({ ...item })) })));
      const file = await this.file(projectId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const previous = await fs.readFile(file, 'utf8').catch(() => null);
      if (previous !== null) {
        const history = path.join(path.dirname(file), '文风版本历史');
        await fs.mkdir(history, { recursive: true });
        await fs.writeFile(path.join(history, `${Date.now()}.json`), previous, { flag: 'wx' }).catch(() => {});
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, updatedAt: savedAt, entries }), { flag: 'wx' });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      return { entries, updatedAt: savedAt, hash: hashOf(entries) };
    });
  }
  async ensure(projectId: string, hash: string, styleId: string, rules: string) {
    return this.mutate(projectId, hash, entries => entries.some(entry => entry.styleId === styleId) ? entries
      : [...entries, emptyHistory(styleId, rules, new Date().toISOString())]);
  }
  async revise(projectId: string, hash: string, styleId: string, rules: string) {
    return this.mutate(projectId, hash, entries => entries.map(entry => entry.styleId === styleId ? reviseRules(entry, rules, new Date().toISOString()) : entry));
  }
  async restore(projectId: string, hash: string, styleId: string, version: number) {
    return this.mutate(projectId, hash, entries => entries.map(entry => entry.styleId === styleId ? restoreVersion(entry, version, new Date().toISOString()) : entry));
  }
  async record(projectId: string, hash: string, styleId: string, effect: Omit<EffectRecord, 'at'> & { at?: string }) {
    return this.mutate(projectId, hash, entries => entries.map(entry => entry.styleId === styleId
      ? recordEffect(entry, { ...effect, at: effect.at ?? new Date().toISOString() }) : entry));
  }
  /** Pulls the current rules out of the book snapshot so rule edits made elsewhere (the studio)
   * still create versions. Missing entries are created; unchanged rules create nothing. */
  async sync(projectId: string, styles: { id: string; rules: string }[]) {
    const current = await this.read(projectId);
    const now = new Date().toISOString();
    return this.mutate(projectId, current.hash, entries => {
      const next = entries.map(entry => ({ ...entry }));
      for (const style of styles) {
        const existing = next.find(entry => entry.styleId === style.id);
        if (!existing) { next.push(emptyHistory(style.id, style.rules, now)); continue; }
        const index = next.findIndex(entry => entry.styleId === style.id);
        next[index] = reviseRules(existing, style.rules, now);
      }
      return next;
    });
  }
}
function hashOf(entries: StyleHistory[]) {
  const text = JSON.stringify(entries.map(entry => [entry.styleId, entry.current.version, entry.current.rules, entry.history.length, entry.effects.length]));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
