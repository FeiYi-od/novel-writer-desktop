import { measureStyleText } from './style-metrics';
/** 全文分段统计：把长文按字符预算切块，逐块计算表面特征，再按字符加权汇总。
 * 只做可复现的表面统计，不调用模型、不做语义理解；用于"这篇到底覆盖了多少字"的诚实展示。 */
export interface StyleChunkMetrics {
  characters: number; paragraphs: number; meanSentenceLength: number; meanParagraphLength: number; dialogueRatio: number; firstPersonPerThousand: number;
}
export interface StyleCoverage {
  mode: 'full'; characters: number; chunks: number; chunkCharacters: number;
  sentenceLength: { min: number; max: number }; dialogueRatio: { min: number; max: number };
}

/** 章节标题行：优先在这些位置分段，避免把一章从中间切开。 */
const CHAPTER_HEADING = /^(?:第[0-9〇零一二三四五六七八九十百千万两]+[章节回卷部篇](?:\s|$|[^\n]{0,40})|Chapter\s+\d+[^\n]{0,40}|序章|楔子|尾声|后记|番外)(?:\s|$|[^\n]{0,40})$/u;

/** 在尽量不切断段落的前提下切块；有章节标题时优先在标题行前切开，
 * 没有标题才退回换行处，最后才是硬切。拼回去必须与原文完全一致。 */
export function splitForAnalysis(text: string, chunkCharacters: number): string[] {
  const size = Math.max(2000, Math.min(200000, Math.floor(chunkCharacters)));
  const normalized = text.replace(/\r\n?/gu, '\n');
  if (normalized.length <= size) return [normalized];
  // 记录每个章节标题行的起始偏移，供切块时对齐。
  const headings: number[] = [];
  let lineStart = 0;
  for (const line of normalized.split('\n')) {
    if (line.trim() && CHAPTER_HEADING.test(line.replace(/^\u3000+/u, '').trim())) headings.push(lineStart);
    lineStart += line.length + 1;
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const limit = Math.min(normalized.length, cursor + size);
    if (limit >= normalized.length) { chunks.push(normalized.slice(cursor)); break; }
    let end = -1;
    // 1) 章节边界：优先选预算内、且不早于一半预算的最后一个标题。
    // The last heading at or before the limit can be found in logarithmic time;
    // scanning all headings for every chunk is quadratic for chapter-heavy books.
    let left = 0, right = headings.length;
    while (left < right) { const middle = Math.floor((left + right) / 2); if (headings[middle]! <= limit) left = middle + 1; else right = middle; }
    const heading = headings[left - 1];
    if (heading !== undefined && heading > cursor + size / 2) end = heading;
    // 2) 段落边界
    if (end < 0) {
      const breakAt = normalized.lastIndexOf('\n', limit);
      if (breakAt > cursor + size / 2) end = breakAt + 1;
    }
    // 3) 硬切
    if (end <= cursor) end = limit;
    chunks.push(normalized.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export function analyzeFullText(text: string, options: { chunkCharacters?: number } = {}): { metrics: StyleChunkMetrics; coverage: StyleCoverage } {
  const chunkCharacters = options.chunkCharacters ?? 20000;
  const chunks = splitForAnalysis(text, chunkCharacters);
  const measured: StyleChunkMetrics[] = [];
  for (const chunk of chunks) { const metrics = measureStyleText(chunk); if (metrics) measured.push(metrics); }
  // Overall metrics are computed from the entire text, not averages of artificial chunk boundaries.
  const metrics = measureStyleText(text);
  if (!metrics || metrics.characters < 100) throw new Error('参考文本至少需要 100 个非空白字符，才能提炼文风');
  return { metrics, coverage: {
    mode: 'full', characters: metrics.characters, chunks: chunks.length, chunkCharacters,
    sentenceLength: { min: Math.min(...measured.map(item => item.meanSentenceLength)), max: Math.max(...measured.map(item => item.meanSentenceLength)) },
    dialogueRatio: { min: Math.min(...measured.map(item => item.dialogueRatio)), max: Math.max(...measured.map(item => item.dialogueRatio)) }
  } };
}
