import * as fs from 'node:fs/promises';
import path from 'node:path';
import { copyableText } from '../core/typography';
import type { Workspace } from './workspace';

/** 导出单章为纯文本或 Markdown：正文原样保留（含真实段首两个 U+3000），目标已存在时拒绝覆盖。 */
export async function exportChapterText(workspace: Workspace, projectId: string, chapterPath: string, target: string) {
  const manuscript = await workspace.readChapter(projectId, chapterPath);
  const paragraphs = (typeof manuscript.content === 'string' ? manuscript.content.replace(/<[^>]+>/gu, '') : copyableText(manuscript.content))
    .split(/\r?\n/u).map(line => line.replace(/\s+$/u, '')).filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1));
  const extension = path.extname(target).toLowerCase();
  const title = path.basename(chapterPath, path.extname(chapterPath));
  const body = extension === '.md' ? [`# ${title}`, '', ...paragraphs].join('\n') : paragraphs.join('\n');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, { encoding: 'utf8', flag: 'wx' });
  return { file: target, characters: paragraphs.join('').replace(/\s/gu, '').length, paragraphs: paragraphs.length, format: extension === '.md' ? 'md' as const : 'txt' as const };
}
/** 恢复区筛选：按章节名过滤备份列表（大小写不敏感）。 */
export function filterDrafts<T extends { sourcePath: string }>(drafts: T[], keyword: string): T[] {
  const query = keyword.trim().toLowerCase();
  if (!query) return drafts;
  return drafts.filter(draft => draft.sourcePath.toLowerCase().includes(query));
}
