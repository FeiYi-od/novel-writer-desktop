import { z } from 'zod';
export const reviewCategories = ['错别字', '标点', '语病', '大纲', '世界观', '角色', '连续性'] as const;
const reportSchema = z.object({ summary: z.string().max(10000), issues: z.array(z.object({ category: z.enum(reviewCategories), quote: z.string().min(1).max(4000), replacement: z.string().max(4000), reason: z.string().min(1).max(4000), evidence: z.string().max(4000) })).max(100) });
export const structuredReviewInstruction = '你是独立审稿人，检查错别字、标点、语病、大纲、世界观、角色和连续性。只输出 JSON：{"summary":"总结及资料不足未检查项","issues":[{"category":"错别字","quote":"逐字引用待审正文中的完整短句","replacement":"建议替换句","reason":"理由","evidence":"逐字引用所给本书设定；纯文字问题可为空"}]}。category 只能为错别字、标点、语病、大纲、世界观、角色、连续性。无问题用空 issues。不得编造引文或依据。每条修改限定一个段落，不要跨段；重复句应扩大引文直到可唯一定位。删除文本时 replacement 为空字符串。只给建议，不宣称已改写正文。';
export interface ReviewIssue { id: string; category: string; quote: string; replacement: string; reason: string; evidence: string; start: number | null; limitation: string }
export function parseReview(text: string, source: string, context: string): { summary: string; issues: ReviewIssue[] } {
  let value: z.infer<typeof reportSchema>;
  try { value = reportSchema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'))); }
  catch { throw new Error('模型未返回有效的结构化审稿报告；原始结果保留，可复制后人工核对'); }
  return { summary: value.summary, issues: value.issues.map((issue, index) => {
    const start = source.indexOf(issue.quote);
    let limitation = '';
    if (start < 0) limitation = '原句与送审正文不匹配';
    else if (source.indexOf(issue.quote, start + 1) >= 0) limitation = '原句重复，无法唯一定位';
    else if (/[\r\n]/.test(issue.quote + issue.replacement)) limitation = '跨段修改需手工处理';
    else if (issue.quote === issue.replacement) limitation = '建议与原文相同';
    else if (!['错别字', '标点', '语病'].includes(issue.category) && (!issue.evidence.trim() || !context.includes(issue.evidence))) limitation = '设定依据未能在发送资料中核对';
    return { ...issue, id: `issue-${index + 1}`, start: limitation ? null : start, limitation };
  }) };
}
export function applyReviewEdits(source: string, issues: ReviewIssue[], selected: string[]) {
  if (!selected.length || selected.length > 100 || new Set(selected).size !== selected.length) throw new Error('请选择不重复的修改项');
  const chosen = selected.map(id => { const issue = issues.find(i => i.id === id); if (!issue || issue.start === null || source.slice(issue.start, issue.start + issue.quote.length) !== issue.quote) throw new Error('选中建议没有有效原文定位'); return issue; }).sort((a, b) => a.start! - b.start!);
  for (let i = 1; i < chosen.length; i++) if (chosen[i].start! < chosen[i - 1].start! + chosen[i - 1].quote.length) throw new Error('选中建议互相重叠，请分别选择');
  let result = source;
  for (const issue of chosen.reverse()) result = result.slice(0, issue.start!) + issue.replacement + result.slice(issue.start! + issue.quote.length);
  if (!result.trim()) throw new Error('修改后正文为空，请保留内容');
  return result;
}
