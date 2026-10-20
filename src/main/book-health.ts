import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Workspace } from './workspace';

export type HealthLevel = 'ok' | 'warn' | 'error';
export interface HealthIssue { level: Exclude<HealthLevel, 'ok'>; code: string; message: string; path?: string }
export interface HealthReport { ok: boolean; checked: number; issues: HealthIssue[] }
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** 只读体检：把"书目录看起来正常、但内部对不上"的情况找出来。
 * 不修、不改、不移动任何文件——报告交给作者决定。 */
export async function inspectBook(workspace: Workspace, projectId: string): Promise<HealthReport> {
  const project = workspace.getProject(projectId);
  const issues: HealthIssue[] = [];
  const metadata = path.join(project.root, '小说资料');
  const stateFiles = new Set<string>();
  for (const name of await fs.readdir(path.join(metadata, 'documents')).catch(() => [] as string[])) {
    if (name.endsWith('.json')) stateFiles.add(name.replace(/\.json$/u, ''));
  }
  const chapters = await workspace.chapters(projectId).catch(error => {
    issues.push({ level: 'error', code: 'chapters-unreadable', message: `章节列表读不出来：${String((error as Error).message).slice(0, 80)}` });
    return [] as { path: string }[];
  });
  let checked = 0;
  for (const chapter of chapters) {
    checked += 1;
    const file = path.join(project.root, chapter.path);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) { issues.push({ level: 'error', code: 'chapter-missing', message: '章节文件不存在', path: chapter.path }); continue; }
    if (stat.size === 0) { issues.push({ level: 'error', code: 'chapter-empty', message: '章节文件是 0 字节', path: chapter.path }); continue; }
    if (!chapter.path.toLowerCase().endsWith('.docx')) continue;
    const hash = digest(await fs.readFile(file));
    if (!stateFiles.has(hash)) {
      issues.push({ level: 'warn', code: 'no-managed-state', message: '这份 DOCX 没有本应用保存记录（可能被外部软件改过），保存前需要另存副本', path: chapter.path });
    }
  }
  // 冲突副本：同步软件留下的，应用不会自动处理
  const conflicts = chapters.filter(chapter => /冲突副本|conflicted copy|\.sync-conflict-|副本\s*[（(]\d/u.test(chapter.path));
  if (conflicts.length) issues.push({ level: 'warn', code: 'sync-conflicts', message: `发现 ${conflicts.length} 个同步冲突副本，需要人工核对` });
  // 小说资料本身
  const projectFile = path.join(metadata, 'project.json');
  const raw = await fs.readFile(projectFile, 'utf8').catch(() => null);
  if (raw === null) issues.push({ level: 'error', code: 'project-missing', message: '缺少 小说资料/project.json' });
  else {
    try { JSON.parse(raw); } catch { issues.push({ level: 'error', code: 'project-corrupt', message: '小说资料/project.json 无法解析', path: '小说资料/project.json' }); }
  }
  return { ok: issues.every(issue => issue.level !== 'error'), checked, issues };
}
