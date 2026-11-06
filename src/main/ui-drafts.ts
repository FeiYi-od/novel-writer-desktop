import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workspace } from './workspace';

const PAGE = z.enum(['planning', 'materials', 'characters', 'summary', 'style', 'world-card']);
export type DraftPage = z.infer<typeof PAGE>;
const MAX_BYTES = 2 * 1024 * 1024;
const valueSchema = z.record(z.string().max(100), z.string().max(MAX_BYTES));
const entrySchema = z.object({
  schemaVersion: z.literal(1), projectId: z.uuid(), page: PAGE,
  values: valueSchema, updatedAt: z.string().min(1).max(40)
});
export interface UiDraft { page: DraftPage; values: Record<string, string>; updatedAt: string }

/** Unsaved editor text that must survive an exit, kept outside the novel folder so it never
 * looks like project content. Restoring is always an explicit author action. */
export class UiDraftStore {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly userData: string, private readonly workspace: Workspace) {}
  private serial<T>(projectId: string, page: DraftPage, action: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${page}`;
    const next = (this.queues.get(key) ?? Promise.resolve()).then(action);
    const tail = next.then(() => {}, () => {});
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return next;
  }
  private async file(projectId: string, page: DraftPage) {
    this.workspace.getProject(z.uuid().parse(projectId));
    const safePage = PAGE.parse(page);
    return path.join(this.userData, 'ui-drafts', projectId, `${safePage}.json`);
  }
  read(projectId: string, page: DraftPage): Promise<UiDraft | null> {
    return this.serial(projectId, page, () => this.readInner(projectId, page));
  }
  private async readInner(projectId: string, page: DraftPage): Promise<UiDraft | null> {
    const file = await this.file(projectId, page);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw); } catch { throw new Error('未保存草稿已损坏或版本不受支持，原文件已保留'); }
    const parsed = entrySchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.page !== page) throw new Error('未保存草稿已损坏或版本不受支持，原文件已保留');
    return { page, values: parsed.data.values, updatedAt: parsed.data.updatedAt };
  }
  save(projectId: string, page: DraftPage, values: Record<string, string>): Promise<UiDraft> {
    const frozen = { ...values };
    return this.serial(projectId, page, () => this.saveInner(projectId, page, frozen));
  }
  private async saveInner(projectId: string, page: DraftPage, values: Record<string, string>): Promise<UiDraft> {
    const file = await this.file(projectId, page);
    const validated = valueSchema.safeParse(values);
    if (!validated.success) throw new Error('未保存草稿格式或长度不受支持，请保留当前内容并先保存');
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(validated.data)) { if (value.trim()) clean[key] = value; }
    const draft: UiDraft = { page, values: clean, updatedAt: new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(draft.values), 'utf8') > MAX_BYTES) throw new Error('未保存草稿超过 2 MiB，请先精简内容');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, projectId, ...draft }), { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return draft;
  }
  /** Empty drafts remove the file so a later launch does not offer a stale restore. */
  clear(projectId: string, page: DraftPage) {
    return this.serial(projectId, page, async () => this.clearInner(projectId, page));
  }
  private async clearInner(projectId: string, page: DraftPage) {
    await fs.rm(await this.file(projectId, page), { force: true });
  }
}
