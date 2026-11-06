/** 合并前的差异比较：找出多份档案的共同规则行与各自独有规则行，并给出指标区间。
 * 纯函数，便于单测；不读磁盘、不改档案。与 compareStyles（文风相似度）不同，这里面向"合并"。 */
export interface MergeCompareInput {
  id: string; name: string; rules: string;
  metrics: { meanSentenceLength: number; meanParagraphLength: number; dialogueRatio: number; firstPersonPerThousand: number; characters: number };
}
export interface MergeComparison {
  shared: string[];
  perStyle: { id: string; name: string; unique: string[]; metrics: MergeCompareInput['metrics'] }[];
  ranges: { sentenceLength: { min: number; max: number }; paragraphLength: { min: number; max: number }; dialogueRatio: { min: number; max: number } };
}

const lines = (rules: string) => [...new Set(rules.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))];

export function compareForMerge(styles: MergeCompareInput[]): MergeComparison {
  if (styles.length < 2) throw new Error('至少需要两份文风档案才能比较');
  const perLines = styles.map(style => ({ id: style.id, name: style.name, lines: lines(style.rules) }));
  const counts = new Map<string, number>();
  for (const item of perLines) for (const line of item.lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const shared = [...counts.entries()].filter(([, count]) => count >= 2).map(([line]) => line);
  const perStyle = perLines.map((item, index) => ({
    id: item.id, name: item.name,
    unique: item.lines.filter(line => (counts.get(line) ?? 0) === 1),
    metrics: styles[index]!.metrics
  }));
  const pick = (field: keyof MergeCompareInput['metrics']) => styles.map(style => style.metrics[field]);
  return {
    shared, perStyle,
    ranges: {
      sentenceLength: { min: Math.min(...pick('meanSentenceLength')), max: Math.max(...pick('meanSentenceLength')) },
      paragraphLength: { min: Math.min(...pick('meanParagraphLength')), max: Math.max(...pick('meanParagraphLength')) },
      dialogueRatio: { min: Math.min(...pick('dialogueRatio')), max: Math.max(...pick('dialogueRatio')) }
    }
  };
}
