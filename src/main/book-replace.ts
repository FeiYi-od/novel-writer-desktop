import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { replaceInDocument } from '../core/replace-text';
import type { Workspace } from './workspace';

const requestSchema = z.object({
  projectId: z.uuid(), query: z.string().min(1).max(2000), replacement: z.string().max(2000),
  caseSensitive: z.boolean().optional(), paths: z.array(z.string().min(1).max(2000)).max(500).optional()
});
const batchSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.uuid(), batchId: z.uuid(), createdAt: z.string(),
  entries: z.array(z.object({ path: z.string().min(1).max(2000), beforeHash: z.string().regex(/^[a-f0-9]{64}$/u), afterHash: z.string().regex(/^[a-f0-9]{64}$/u), backup: z.string().regex(/^[a-f0-9-]{36}\.(docx|txt)$/u) })).max(500)
});
type Batch = z.infer<typeof batchSchema>;
export interface ReplaceChapterResult { path: string; count: number; status: 'replaced' | 'unchanged' | 'skipped'; message?: string }
export interface ReplaceOutcome { chapters: ReplaceChapterResult[]; total: number; replacedFiles: number; batchId?: string }
export interface UndoOutcome { restored: string[]; skipped: { path: string; reason: string }[] }
/** Whole-book text replacement. Every chapter is read, re-hashed and written through the normal
 * save path, so an externally edited chapter is skipped with a reason instead of being overwritten.
 * A batch journal keeps the previous bytes of every chapter so the whole run can be undone. */
export class BookReplace {
  constructor(private readonly workspace: Workspace, private readonly journalRoot: string) {}
  private async batchFile(projectId: string, batchId: string) {
    return path.join(this.journalRoot, 'replace-batches', projectId, `${batchId}.json`);
  }
  async run(input: { projectId: string; query: string; replacement: string; caseSensitive?: boolean; paths?: string[]; dryRun?: boolean }): Promise<ReplaceOutcome> {
    const request = requestSchema.parse(input);
    const listed = await this.workspace.chapters(request.projectId);
    const wanted = request.paths ? new Set(request.paths.map(item => item.replace(/\\/gu, '/'))) : null;
    const targets = listed.filter(chapter => !wanted || wanted.has(chapter.path.replace(/\\/gu, '/')));
    const root = this.workspace.getProject(request.projectId).root;
    const chapters: ReplaceChapterResult[] = [];
    const entries: Batch['entries'] = [];
    let total = 0, replacedFiles = 0;
    for (const chapter of targets) {
      let manuscript;
      try { manuscript = await this.workspace.readChapter(request.projectId, chapter.path); }
      catch { chapters.push({ path: chapter.path, count: 0, status: 'skipped', message: '无法读取该章节，已跳过' }); continue; }
      if (typeof manuscript.content === 'string') { chapters.push({ path: chapter.path, count: 0, status: 'skipped', message: '纯文本章节不支持整书替换，已跳过' }); continue; }
      const result = replaceInDocument(manuscript.content, request.query, request.replacement, { caseSensitive: request.caseSensitive });
      if (!result.count) { chapters.push({ path: chapter.path, count: 0, status: 'unchanged' }); continue; }
      if (input.dryRun) { chapters.push({ path: chapter.path, count: result.count, status: 'unchanged' }); total += result.count; continue; }
      const absolute = path.join(root, chapter.path);
      let before: Buffer;
      try { before = await fs.readFile(absolute); }
      catch { chapters.push({ path: chapter.path, count: 0, status: 'skipped', message: '读取原文件失败，已跳过' }); continue; }
      const backup = `${randomUUID()}${path.extname(chapter.path)}`;
      const backupFile = path.join(this.journalRoot, 'replace-batches', request.projectId, 'files', backup);
      await fs.mkdir(path.dirname(backupFile), { recursive: true });
      await fs.writeFile(backupFile, before, { flag: 'wx' });
      let saved;
      try {
        saved = await this.workspace.saveChapter({ projectId: request.projectId, path: chapter.path, expectedHash: manuscript.hash, content: result.document });
      } catch (error) {
        chapters.push({ path: chapter.path, count: 0, status: 'skipped', message: `保存前发现版本冲突，已跳过：${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      entries.push({ path: chapter.path, beforeHash: manuscript.hash, afterHash: saved.hash, backup });
      chapters.push({ path: chapter.path, count: result.count, status: 'replaced' });
      total += result.count; replacedFiles += 1;
    }
    let batchId: string | undefined;
    if (entries.length) {
      batchId = randomUUID();
      const batch: Batch = { schemaVersion: 1, projectId: request.projectId, batchId, createdAt: new Date().toISOString(), entries };
      const file = await this.batchFile(request.projectId, batchId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(batch));
    }
    return { chapters, total, replacedFiles, batchId };
  }
  /** Undo only touches chapters that still hold the exact bytes this batch wrote. */
  async undo(projectId: string, batchId: string): Promise<UndoOutcome> {
    const file = await this.batchFile(z.uuid().parse(projectId), z.uuid().parse(batchId));
    const batch = batchSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    if (batch.projectId !== projectId || batch.batchId !== batchId) throw new Error('该替换批次不属于当前小说或编号不符');
    const restored: string[] = []; const skipped: { path: string; reason: string }[] = [];
    for (const entry of batch.entries) {
      let current;
      try { current = await this.workspace.readChapter(projectId, entry.path); }
      catch { skipped.push({ path: entry.path, reason: '章节已不存在' }); continue; }
      if (current.hash !== entry.afterHash) { skipped.push({ path: entry.path, reason: '替换后又被修改过，已跳过以免覆盖' }); continue; }
      const backupFile = path.join(this.journalRoot, 'replace-batches', projectId, 'files', entry.backup);
      const bytes = await fs.readFile(backupFile).catch(() => null);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== entry.beforeHash) { skipped.push({ path: entry.path, reason: '备份文件缺失或版本已变化' }); continue; }
      try {
        const restoredChapter = await this.workspace.restoreOriginalChapter(projectId, entry.path, entry.afterHash, bytes);
        restored.push(restoredChapter.path.split(path.sep).join('/'));
      } catch (error) { skipped.push({ path: entry.path, reason: `撤销前版本或路径变化，已保留双方：${error instanceof Error ? error.message : String(error)}` }); }
    }
    return { restored, skipped };
  }
}
