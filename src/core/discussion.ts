export interface DiscussionMessage {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; at: string;
  /** 被压缩进哪条摘要（原文始终保留，只做标记）。 */
  compressedInto?: string;
}
export interface CompressionPlan {
  needed: boolean; usedTokens: number; budget: number;
  compressIds: string[]; keepIds: string[]; summaryPrompt: { role: 'system' | 'user'; content: string }[];
}
export const COMPRESSION = { threshold: 0.8, reserveTokens: 2048, keepRecent: 6, summaryLimit: 800 } as const;
/** Conservative byte budget, shared with writing tasks; never pretend this is provider billing. */
export function estimateTokens(text: string): number {
  return new TextEncoder().encode(text).length;
}
export function usedTokens(messages: DiscussionMessage[]): number {
  return messages.filter(message => !message.compressedInto).reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
}
export function discussionPrompt(messages: DiscussionMessage[], text: string, system = '') {
  const transcript = messages.filter(message => !message.compressedInto)
    .map(message => `${message.role === 'assistant' ? '助手' : message.role === 'system' ? '讨论摘要（非正式设定）' : '作者'}：${message.content}`).join('\n');
  return [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    { role: 'user' as const, content: transcript ? `已有讨论（含猜想，不视为作者确认的正史）：\n${transcript}\n\n作者新问题：${text}` : text }
  ];
}
export const discussionRequestTokens = (messages: { content: string }[]) => messages.reduce((sum, message) => sum + estimateTokens(message.content) + 16, 256);
/** Include summaries, wrappers, the new question, system prompt and the real output reservation.
 * Compress bounded prefixes; never cut a selected message's content to fit a request. */
export function planCompression(messages: DiscussionMessage[], contextWindow: number, options: { threshold?: number; reserveTokens?: number; keepRecent?: number; newText?: string; system?: string } = {}): CompressionPlan {
  const threshold = options.threshold ?? COMPRESSION.threshold;
  const reserve = options.reserveTokens ?? COMPRESSION.reserveTokens;
  const keepRecent = options.keepRecent ?? COMPRESSION.keepRecent;
  if (!Number.isInteger(contextWindow) || contextWindow < 1 || !Number.isInteger(reserve) || reserve < 0 || reserve >= contextWindow
    || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1 || !Number.isInteger(keepRecent) || keepRecent < 0)
    throw new Error('讨论上下文或输出预算无效，请调整模型设置');
  const budget = Math.max(0, Math.floor(contextWindow * threshold) - reserve);
  const hardBudget = contextWindow - reserve;
  const live = messages.filter(message => !message.compressedInto);
  const used = discussionRequestTokens(discussionPrompt(live, options.newText ?? '', options.system));
  const empty: CompressionPlan = { needed: false, usedTokens: used, budget, compressIds: [], keepIds: live.map(message => message.id), summaryPrompt: [] };
  if (used <= budget || !live.length) return empty;
  let count = Math.max(1, live.length - keepRecent);
  const summaryAllowance = Math.min(COMPRESSION.summaryLimit * 3, Math.max(256, Math.floor(hardBudget / 4)));
  while (count < live.length && discussionRequestTokens(discussionPrompt(live.slice(count), options.newText ?? '', options.system)) + summaryAllowance > budget) count++;
  while (count > 0 && discussionRequestTokens(buildSummaryPrompt(live.slice(0, count))) > hardBudget) count--;
  const compress = live.slice(0, count), keep = live.slice(count);
  return {
    needed: true, usedTokens: used, budget,
    compressIds: compress.map(message => message.id), keepIds: keep.map(message => message.id),
    summaryPrompt: count ? buildSummaryPrompt(compress) : []
  };
}
export function buildSummaryPrompt(messages: DiscussionMessage[]) {
  const transcript = messages.map(message => `${message.role === 'user' ? '作者' : message.role === 'system' ? '先前讨论摘要（仍非正式设定）' : '助手'}：${message.content}`).join('\n');
  return [
    { role: 'system' as const, content: `你是对话压缩器。把下面的讨论压缩成要点，要求：保留人物名、设定决定、已否决的选项、未决议题与数字；只写原文有的事实，不得补充推测或新剧情；用中文，不超过 ${COMPRESSION.summaryLimit} 字。` },
    { role: 'user' as const, content: transcript }
  ];
}
/** 摘要必须可用：空摘要、超长摘要都拒绝，避免把对话压成噪音。 */
export function normalizeSummary(text: string): string {
  const clean = text.replace(/\r\n?/gu, '\n').trim();
  if (!clean) throw new Error('压缩结果为空，已保留原始对话');
  if (clean.length > COMPRESSION.summaryLimit * 2) throw new Error('压缩摘要过长，已保留原始对话；请调整输出或手工整理后再试');
  return clean;
}
