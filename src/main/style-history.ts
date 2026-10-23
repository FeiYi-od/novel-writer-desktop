import { z } from 'zod';
import { emptyHistory, recordEffect, restoreVersion, reviseRules, type EffectRecord, type StyleHistory } from '../core/style-history';
import type { Workspace } from './workspace';
import { ProjectRecord } from './project-record';

const versionSchema = z.object({ version: z.number().int().min(1), rules: z.string().min(1).max(20000), savedAt: z.string().max(40) });
const effectSchema = z.object({ at: z.string().max(40), source: z.enum(['trial', 'chapter']), characters: z.number().int().min(0), averageSentence: z.number().min(0), dialogueRatio: z.number().min(0).max(1), note: z.string().max(200).optional() });
const fileSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), updatedAt: z.string(), entries: z.array(z.object({
  styleId: z.string().min(1).max(120), current: versionSchema, history: z.array(versionSchema).max(10), effects: z.array(effectSchema).max(50)
})).max(200) });
export interface StyleHistorySnapshot { entries: StyleHistory[]; updatedAt: string; hash: string }
/** Style rule versions and effect records, stored as project material with history copies. */
export class StyleHistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly storage: ProjectRecord<z.infer<typeof fileSchema>>;
  constructor(private readonly workspace: Workspace) { this.storage = new ProjectRecord(workspace, '文风版本', fileSchema); }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  async read(projectId: string): Promise<StyleHistorySnapshot> {
    const saved = await this.storage.read(projectId);
    return { entries: saved.value?.entries ?? [], updatedAt: saved.value?.updatedAt ?? '', hash: saved.hash };
  }

  /** Applies one operation under the same hash guard, so two windows cannot overwrite each other. */
  async mutate(projectId: string, expectedHash: string, action: (entries: StyleHistory[]) => StyleHistory[], savedAt = new Date().toISOString()): Promise<StyleHistorySnapshot> {
    return this.serial(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error('文风版本已被其他窗口修改，请刷新后重试');
      const entries = action(current.entries.map(entry => ({ ...entry, current: { ...entry.current }, history: entry.history.map(item => ({ ...item })), effects: entry.effects.map(item => ({ ...item })) })));
      if (JSON.stringify(entries) === JSON.stringify(current.entries)) return current;
      const saved = await this.storage.save(projectId, { schemaVersion: 1, projectId, updatedAt: savedAt, entries }, expectedHash);
      return { entries: saved.value!.entries, updatedAt: savedAt, hash: saved.hash };

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
