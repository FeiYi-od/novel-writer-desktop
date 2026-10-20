export interface StylePromptInput { brief: string; styleName: string; rules: string; targetChars?: number }
export interface StylePromptMessage { role: 'system' | 'user'; content: string }
export const STYLE_PROMPT_LIMITS = { brief: 4000, rules: 4000, targetChars: 1200 } as const;
/** Builds the request used by the style trial: rules go to the system message, the brief to the
 * user message, and the answer is constrained to one scene so versions stay comparable. */
export function buildStylePrompt(input: StylePromptInput): StylePromptMessage[] {
  const brief = input.brief.replace(/\r\n?/gu, '\n').trim();
  const rules = input.rules.replace(/\r\n?/gu, '\n').trim();
  if (!brief) throw new Error('请先写清楚这段剧情要求');
  if (brief.length > STYLE_PROMPT_LIMITS.brief) throw new Error('剧情要求过长（最多 4000 字）');
  if (rules.length > STYLE_PROMPT_LIMITS.rules) throw new Error('文风规则过长（最多 4000 字）');
  const target = Math.max(200, Math.min(STYLE_PROMPT_LIMITS.targetChars, Math.round(input.targetChars ?? 600)));
  const system = [
    `你将按「${input.styleName || '指定'}」这一文风写作。`,
    rules ? `文风规则：\n${rules}` : '文风规则：保持该文风一贯的句式、词汇密度与叙述距离。',
    '只输出这一段正文，不要标题、不要解释、不要提纲、不要评论。',
    `篇幅约 ${target} 字，保持在同一个场景内，不新增剧情要求以外的情节。`
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: brief }];
}
