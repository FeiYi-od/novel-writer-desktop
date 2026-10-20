import type { BookDetails, LearnedStyle } from '../shared/contracts';

/** 从实际语料提取可复现的表面特征。不是语义理解或模型微调。 */
export function analyzeText(text: string): Pick<LearnedStyle, 'metrics' | 'rules' | 'method'> {
  const paragraphs = text.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  const compact = text.replace(/\s/g, '');
  if (compact.length < 100) throw new Error('参考文本至少需要 100 个非空白字符，才能提炼文风');
  const sentences = compact.split(/[。！？!?]+/).filter(Boolean);
  const quotes = [...compact.matchAll(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g)].reduce((sum, item) => sum + item[0].length, 0);
  const round = (value: number) => Math.round(value * 10) / 10;
  const metrics = {
    characters: compact.length, paragraphs: paragraphs.length,
    meanSentenceLength: round(compact.length / Math.max(sentences.length, 1)),
    meanParagraphLength: round(compact.length / Math.max(paragraphs.length, 1)),
    dialogueRatio: round(quotes / compact.length * 100),
    firstPersonPerThousand: round((compact.match(/我/g)?.length ?? 0) / compact.length * 1000)
  };
  const rules = [
    metrics.meanSentenceLength < 22 ? '句子偏短，表达直接；用适量短句推进节奏。' : metrics.meanSentenceLength > 45 ? '允许较长句式展开细节，注意主次和停顿。' : '长短句交替，兼顾叙事推进与必要的描写。',
    metrics.meanParagraphLength < 65 ? '段落短而清晰，每段集中表达一个动作、念头或对话。' : '用完整段落组织场景和心理变化，避免无意义拆段。',
    metrics.dialogueRatio > 35 ? '较多使用人物对白推进场景，穿插动作与反应。' : metrics.dialogueRatio < 10 ? '以叙述与描写为主，关键节点再使用对白。' : '平衡对白与叙述，对话之后保留适量行动和感受。',
    '叙述人称服从当前小说设定；样本中的“我”也可能来自对白，不据此强行改为第一人称。',
    '只借鉴表达方式与节奏，人物、情节和世界规则全部取自当前小说。'
  ].join('\n');
  return { method: 'local-statistics-v1', metrics, rules };
}

export function selectedStylePrompt(book: BookDetails, projectId: string): string {
  if (book.projectId !== projectId) throw new Error('文风配置属于另一部小说');
  const style = book.styles.find(item => item.id === book.activeStyleId);
  return style ? `文风要求：${style.name}\n${style.rules}\n文风只影响表达，不改变本书人物与事实。` : '';
}
