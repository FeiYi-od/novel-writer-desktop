export interface ChapterStat { path: string; characters: number; paragraphs: number; updatedAt: string }
export interface ChapterSummary {
  chapters: ChapterStat[]; totalCharacters: number; totalParagraphs: number;
  stale: string[]; longest: ChapterStat | null; shortest: ChapterStat | null;
}
/** 纯统计：总字数、总段落、长期没动的章节、最长/最短章节。 */
export function summarizeChapters(chapters: ChapterStat[], options: { staleDays?: number; now?: Date } = {}): ChapterSummary {
  const staleDays = options.staleDays ?? 14;
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const sorted = [...chapters].sort((left, right) => left.characters - right.characters);
  const stale = chapters.filter(chapter => {
    const at = Date.parse(chapter.updatedAt);
    return Number.isFinite(at) && at < cutoff;
  }).map(chapter => chapter.path);
  return {
    chapters,
    totalCharacters: chapters.reduce((sum, chapter) => sum + chapter.characters, 0),
    totalParagraphs: chapters.reduce((sum, chapter) => sum + chapter.paragraphs, 0),
    stale,
    longest: sorted.length ? sorted[sorted.length - 1]! : null,
    shortest: sorted.length ? sorted[0]! : null
  };
}
/** 给界面用的一句话进度。 */
export function describeProgress(summary: ChapterSummary, staleDays = 14) {
  if (!summary.chapters.length) return '还没有章节';
  const base = `${summary.chapters.length} 章 · ${summary.totalCharacters} 字 · ${summary.totalParagraphs} 段`;
  return summary.stale.length ? `${base}；其中 ${summary.stale.length} 章超过 ${staleDays} 天没动` : `${base}；${staleDays} 天内都动过`;
}
