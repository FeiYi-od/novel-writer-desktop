import * as fs from 'node:fs/promises';
import path from 'node:path';
import { copyableText } from '../core/typography';
import { summarizeChapters } from '../core/chapter-stats';
import type { Workspace } from './workspace';

/** 按章读取字数与段落数，并用文件修改时间判断"多久没动"。只读。 */
export async function collectChapterStats(workspace: Workspace, projectId: string, options: { staleDays?: number } = {}) {
  const project = workspace.getProject(projectId);
  const chapters = await workspace.chapters(projectId);
  const stats = [];
  for (const chapter of chapters) {
    const file = path.join(project.root, chapter.path);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    let characters = 0, paragraphs = 0;
    try {
      const manuscript = await workspace.readChapter(projectId, chapter.path);
      const text = typeof manuscript.content === 'string' ? manuscript.content.replace(/<[^>]+>/gu, '') : copyableText(manuscript.content);
      characters = text.replace(/\s/gu, '').length;
      paragraphs = text.split(/\n+/u).filter(line => line.trim()).length;
    } catch { /* 读不出来的章节只记时间，不猜字数 */ }
    stats.push({ path: chapter.path, characters, paragraphs, updatedAt: stat.mtime.toISOString() });
  }
  return summarizeChapters(stats, { staleDays: options.staleDays ?? 14 });
}
