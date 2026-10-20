export type SceneType = 'dialogue' | 'action' | 'daily' | 'mixed';
export interface SceneMetrics {
  type: SceneType; chars: number; dialogueChars: number; dialogueRatio: number;
  speechLines: number; speechTags: number; actionSentences: number; adverbs: number; hedges: number; averageParagraph: number;
}
export interface SceneReport { metrics: SceneMetrics; suggestions: string[] }
const DIALOGUE = /[“"「][^”"」]*[”"」]/gu;
const ACTION = /(冲|撞|挥|劈|踏|跃|闪|抓|推|拽|踢|斩|刺|挡|躲|扑|跑|奔|扭|摔)/gu;
const ADVERB = /地/gu;
const HEDGE = /(似乎|仿佛|好像|大概|可能|也许|或许)/gu;
const SPEECH_TAG = /(说道|问|答道|说|道：|低声道|喊道|笑道)/gu;
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;
const round = (value: number) => Math.round(value * 1000) / 1000;
/** Cheap, deterministic scene reading. Nothing here guesses: every number is counted from the text. */
export function analyzeScene(text: string): SceneReport {
  const chars = [...text.replace(/\s/gu, '')].length;
  const paragraphs = text.split(/\n+/u).map(line => line.trim()).filter(Boolean);
  const dialogueChars = [...text.matchAll(DIALOGUE)].reduce((sum, match) => sum + [...match[0]].length, 0);
  const dialogueRatio = chars ? round(dialogueChars / chars) : 0;
  const sentences = text.split(/[。！？!?…]+/u).map(part => part.trim()).filter(Boolean).length;
  const actionSentences = Math.min(sentences, count(text, ACTION));
  const metrics: SceneMetrics = {
    type: 'mixed', chars, dialogueChars, dialogueRatio,
    speechLines: Math.min(count(text, DIALOGUE), sentences),
    speechTags: count(text, SPEECH_TAG),
    actionSentences,
    adverbs: count(text, ADVERB),
    hedges: count(text, HEDGE),
    averageParagraph: paragraphs.length ? Math.round(chars / paragraphs.length) : 0
  };
  metrics.type = dialogueRatio >= 0.35 ? 'dialogue' : actionSentences >= Math.max(2, sentences * 0.3) ? 'action' : dialogueRatio < 0.1 && actionSentences < 2 ? 'daily' : 'mixed';
  const suggestions: string[] = [];
  if (metrics.type === 'dialogue' && metrics.dialogueRatio > 0.75) suggestions.push('对白占比超过四分之三：加一两处动作或环境反应，让读者看见人在哪里说话。');
  if (metrics.type === 'dialogue' && metrics.speechLines > 0 && metrics.speechTags / metrics.speechLines > 0.8) suggestions.push('几乎每句都带“说道/问道”：删掉一部分提示语，靠语气和动作区分说话人。');
  if (metrics.type === 'action' && metrics.averageParagraph > 220) suggestions.push('动作段落偏长：拆成更短的段落，让节奏跟上动作。');
  if (metrics.type === 'daily' && metrics.averageParagraph < 40) suggestions.push('段落过碎：日常场景可以合并同类动作，避免一句一段。');
  if (metrics.adverbs / Math.max(1, sentences) > 0.6) suggestions.push('“地”字状语偏多：把状语换成具体动作，画面会更实。');
  if (metrics.hedges >= 3) suggestions.push('模糊词（似乎/仿佛/可能）出现三次以上：挑一处改成确定的描写。');
  return { metrics, suggestions };
}
/** Picks the metric that most strongly characterises a scene, for a one-line summary. */
export function dominantTrait(metrics: SceneMetrics): string {
  if (metrics.dialogueRatio >= 0.5) return `对白为主（${Math.round(metrics.dialogueRatio * 100)}%）`;
  if (metrics.actionSentences >= 3) return `动作推进（${metrics.actionSentences} 句动作）`;
  if (metrics.averageParagraph >= 150) return `长段铺陈（段均 ${metrics.averageParagraph} 字）`;
  return `叙述为主（段均 ${metrics.averageParagraph} 字）`;
}
