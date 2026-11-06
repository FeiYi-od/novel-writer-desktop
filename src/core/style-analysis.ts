import type { BookDetails, LearnedStyle } from '../shared/contracts';
import { measureStyleText } from './style-metrics';

/** 从实际语料提取可复现的表面特征。不是语义理解或模型微调。 */
export function analyzeText(text: string): Pick<LearnedStyle, 'metrics' | 'rules' | 'method'> {
  const metrics = measureStyleText(text);
  if (!metrics || metrics.characters < 100) throw new Error('参考文本至少需要 100 个非空白字符，才能提炼文风');
  const rules = [
    (metrics.meanSentenceLength < 22 ? '句子偏短，表达直接；用适量短句推进节奏。' : metrics.meanSentenceLength > 45 ? '允许较长句式展开细节，注意主次和停顿。' : '长短句交替，兼顾叙事推进与必要的描写。') + `样本粗略均句 ${metrics.meanSentenceLength} 个非空白字符，仅作节奏参考，不要求逐句达标。`,
    (metrics.meanParagraphLength < 65 ? '段落短而清晰，每段集中表达一个动作、念头或对话。' : '用完整段落组织场景和心理变化，避免无意义拆段。') + `样本粗略均段 ${metrics.meanParagraphLength} 个非空白字符，按场景自然调整。`,
    (metrics.dialogueRatio > 35 ? '较多使用人物对白推进场景，穿插动作与反应。' : metrics.dialogueRatio < 10 ? '以叙述与描写为主，关键节点再使用对白。' : '平衡对白与叙述，对话之后保留适量行动和感受。') + `样本引号内文本约占 ${metrics.dialogueRatio}%，该统计不等同真实对白比例。`,
    '叙述人称服从当前小说设定；样本中的“我”也可能来自对白，不据此强行改为第一人称。',
    '只借鉴表达方式与节奏，人物、情节和世界规则全部取自当前小说。'
  ].join('\n');
  return { method: 'local-statistics-v1', metrics, rules };
}

export function selectedStylePrompt(book: BookDetails, projectId: string): string {
  if (book.projectId !== projectId) throw new Error('文风配置属于另一部小说');
  const style = book.styles.find(item => item.id === book.activeStyleId);
  if (!style) return '';
  const mergedHeader = style.mergedFrom ? style.rules.split('\n')[0] ?? '' : '';
  const weightNote = style.mergedFrom ? `\n合并权重：${mergedHeader}；多条规则冲突时以权重更高的来源为准，权重未覆盖的细节以作者本次要求为准。` : '';
  return `文风要求：${style.name}\n${style.rules}${weightNote}\n将这些规则落实到叙述节奏、对白、动作和描写的具体写法，根据当前场景自然取舍；不要在正文解释或逐条复述规则。文风只影响表达，不改变本书人物、视角与事实；不要复制参考作品的原句和专有内容。`;
}
