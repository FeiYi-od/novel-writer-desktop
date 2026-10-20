import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AITask, Project, ReviewIssueDecision } from '../shared/contracts';
import { hashText } from './ai-connections';
import { reviewReportIdentityText } from '../core/review-identity';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.union([z.literal(''), fingerprint]);
const issueId = z.string().regex(/^issue-(?:[1-9]\d?)$|^issue-100$/);
const outputPath = z.string().min(1).max(2000).refine(value => !path.isAbsolute(value) && !/[<>:"|?*\u0000-\u001f\u007f]/u.test(value)
  && value.split(/[\\/]/u).every(part => !!part && part !== '.' && part !== '..')
  && value.split(/[\\/]/u)[0].toLowerCase() !== '小说资料' && /\.docx$/iu.test(value));
const decisionSchema = z.object({ issueId, status: z.enum(['pending', 'accepted', 'ignored', 'false-positive', 'applied']),
  updatedAt: z.iso.datetime(), outputPath: outputPath.optional(), outputHash: fingerprint.optional()
}).strict().superRefine((value, context) => {
  if ((value.status === 'applied') !== (value.outputPath !== undefined && value.outputHash !== undefined)
    || (value.status !== 'applied' && (value.outputPath !== undefined || value.outputHash !== undefined)))
    context.addIssue({ code: 'custom', message: '已采纳状态必须保存独立副本路径与版本' });
});
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), taskId: z.uuid(), reportFingerprint: fingerprint,
  items: z.array(decisionSchema).max(100)
}).strict();
export interface ReviewDecisionIdentity { projectId: string; taskId: string; reportFingerprint: string; issueIds: string[] }
const identitySchema = z.object({ projectId: z.uuid(), taskId: z.uuid(), reportFingerprint: fingerprint,
  issueIds: z.array(issueId).max(100).refine(items => new Set(items).size === items.length)
}).strict();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };

/** Immutable report identity: issue-1 in another report (or regenerated task)
 * can never inherit a decision. Credentials and mutable pipeline states are not
 * part of a review report, and are deliberately neither copied nor persisted. */
export function reviewReportFingerprint(task: AITask): string {
  return hashText(reviewReportIdentityText(task));
}

/** Local author choices only. This store never writes manuscripts, lore or the
 * report. It rejects unknown/corrupt records instead of replacing them. */
export class ReviewDecisionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private getProject: (id: string) => Project) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  private identity(input: ReviewDecisionIdentity) { const value = identitySchema.parse(input); this.getProject(value.projectId); return value; }
  private async location(identity: ReviewDecisionIdentity, create = false) {
    const base = await fs.realpath(this.directory);
    let parent = base;
    for (const part of ['review-decisions', identity.projectId]) {
      const target = path.join(parent, part);
      if (create) await fs.mkdir(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      try {
        const stat = await fs.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(base, await fs.realpath(target))) throw new Error('审稿处理记录目录或链接异常，原文件已保留');
      } catch (error) { if (!absent(error)) throw error; }
      parent = target;
    }
    return path.join(parent, `${identity.taskId}.json`);
  }
  private async raw(file: string): Promise<string | null> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('审稿处理记录类型、链接或大小异常，原文件已保留');
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('审稿处理记录过大，原文件已保留');
      return raw;
    } catch (error) { if (absent(error)) return null; throw error; }
  }
  private async load(identity: ReviewDecisionIdentity) {
    const file = await this.location(identity), raw = await this.raw(file);
    let items: ReviewIssueDecision[] = [];
    if (raw !== null) {
      let value: z.infer<typeof schema>;
      try { value = schema.parse(JSON.parse(raw)); }
      catch { throw new Error('审稿处理记录损坏或版本不受支持，原文件已保留'); }
      if (value.projectId !== identity.projectId || value.taskId !== identity.taskId || value.reportFingerprint !== identity.reportFingerprint)
        throw new Error('审稿处理记录与本书报告或版本不匹配，原记录已保留');
      if (new Set(value.items.map(item => item.issueId)).size !== value.items.length || value.items.some(item => !identity.issueIds.includes(item.issueId)))
        throw new Error('审稿处理记录的问题编号重复或不属于此报告，原记录已保留');
      items = value.items;
    }
    return { file, raw, hash: raw === null ? '' : hashText(raw), items: identity.issueIds.map(id => items.find(item => item.issueId === id) ?? { issueId: id, status: 'pending' as const, updatedAt: '' }) };
  }
  async read(input: ReviewDecisionIdentity) { const identity = this.identity(input), value = await this.load(identity); return { hash: value.hash, items: structuredClone(value.items) }; }
  async assertCurrent(input: ReviewDecisionIdentity, expectedHash: string) {
    const identity = this.identity(input), expected = revision.parse(expectedHash), value = await this.load(identity);
    if (value.hash !== expected) throw new Error('审稿处理状态已变化，请重新读取后核对');
    return { hash: value.hash, items: structuredClone(value.items) };
  }
  private async backup(file: string, raw: string) {
    const folder = path.join(path.dirname(file), 'history'); await fs.mkdir(folder).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(await fs.realpath(path.dirname(file)), await fs.realpath(folder))) throw new Error('审稿处理历史目录异常，原记录已保留');
    const target = path.join(folder, `${path.basename(file, '.json')}-${hashText(raw)}.json`), previous = await this.raw(target);
    if (previous !== null) { if (previous !== raw) throw new Error('审稿处理历史备份异常，原记录已保留'); return; }
    await fs.writeFile(target, raw, { flag: 'wx' }).catch(async error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await this.raw(target) !== raw) throw error; });
  }
  async save(input: ReviewDecisionIdentity, items: ReviewIssueDecision[], expectedHash: string, beforePublish?: () => Promise<void>) {
    const identity = this.identity(input), expected = revision.parse(expectedHash), frozen = structuredClone(items);
    // Default untouched items stay implicit; persisted decisions always carry an
    // author/system timestamp, including an explicit reset to pending.
    const stored = frozen.filter(item => item.updatedAt !== '');
    for (const item of frozen) {
      if (item.updatedAt !== '') decisionSchema.parse(item);
      else z.object({ issueId, status: z.literal('pending'), updatedAt: z.literal('') }).strict().parse(item);
    }
    schema.parse({ schemaVersion: 1, projectId: identity.projectId, taskId: identity.taskId, reportFingerprint: identity.reportFingerprint, items: stored });
    if (frozen.some(item => item.updatedAt === '' && (item.status !== 'pending' || item.outputPath !== undefined || item.outputHash !== undefined)))
      throw new Error('未处理问题不能携带已采纳状态');
    if (new Set(frozen.map(item => item.issueId)).size !== frozen.length || frozen.length !== identity.issueIds.length || frozen.some(item => !identity.issueIds.includes(item.issueId)))
      throw new Error('审稿处理问题编号不匹配');
    return this.serial(async () => {
      const current = await this.load(identity);
      if (current.hash !== expected) throw new Error('审稿处理状态已变化，请重新读取后核对');
      const file = await this.location(identity, true);
      if (current.raw !== null) await this.backup(file, current.raw);
      const raw = JSON.stringify({ schemaVersion: 1, projectId: identity.projectId, taskId: identity.taskId, reportFingerprint: identity.reportFingerprint, items: stored });
      if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('审稿处理记录过大，原记录已保留');
      const temporary = `${file}.${randomUUID()}.tmp`;
      const recheck = async () => {
        await beforePublish?.();
        if (await this.location(identity) !== file || await this.raw(file) !== current.raw) throw new Error('保存期间审稿处理状态已在外部变化，原记录已保留');
        await this.assertCurrent(identity, expected);
      };
      try {
        await fs.writeFile(temporary, raw, { flag: 'wx' });
        await recheck();
        if (current.raw === null) await fs.link(temporary, file);
        else {
          for (let attempt = 0; ; attempt++) {
            try { await fs.rename(temporary, file); break; }
            catch (error) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(resolve => setTimeout(resolve, 30 * 2 ** attempt)); await recheck(); }
          }
        }
      } finally { await fs.unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
      return { hash: hashText(raw), items: structuredClone(frozen) };
    });
  }
}
