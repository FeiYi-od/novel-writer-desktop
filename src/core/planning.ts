import type { PlanningData, PlanningKind } from '../shared/contracts';
export const planningKinds: PlanningKind[] = ['outline', 'world', 'character'];
export const planningLabels: Record<PlanningKind, string> = { outline: '故事大纲', world: '世界观', character: '角色卡' };
export const planningHeadings: Record<PlanningKind, string[]> = {
  outline: ['故事定位', '主线与冲突', '人物成长', '情节阶段', '结局方向', '待确认事项'],
  world: ['时代与地点', '世界规则', '组织与势力', '能力与限制', '待确认事项'],
  character: ['姓名', '角色描述', '性格与行为边界', '背景与场景']
};
export function emptyPlanning(projectId: string): PlanningData {
  return { schemaVersion: 1, projectId, prompts: {
    outline: '根据我的创作构想设计故事大纲，明确主线冲突、人物成长、阶段转折与结局方向。',
    world: '根据我的创作构想设计自洽的世界观，明确规则、代价、边界和矛盾来源。',
    character: '根据我的创作构想设计一位角色，明确动机、性格、说话方式、行为边界和背景。'
  }, briefs: { outline: '', world: '', character: '' }, drafts: { outline: '', world: '', character: '' }, originTasks: { outline: '', world: '', character: '' }, outline: '' };
}
export function planningInstruction(kind: PlanningKind) {
  return `你是小说创作筹备助手，协助作者设计${planningLabels[kind]}。可以提出新设想，但不得擅自更改已确认设定；冲突和不确定之处标明待作者确认。输出是未确认草稿，不宣称已写入设定。遵循作者提供的提示词与构想。只输出 Markdown，不要代码围栏；依次使用这些二级标题，每个恰好一次：${planningHeadings[kind].join('、')}。需要细分时用三级标题。角色姓名只能一行。`;
}
export function validateOutline(text: string) {
  const headings = [...text.matchAll(/^## (.+)$/gm)].map(match => match[1].trim());
  if (!text.trim() || text.length > 100000 || headings.length !== planningHeadings.outline.length || headings.some((h, i) => h !== planningHeadings.outline[i])) throw new Error('大纲请保留模板中的全部二级标题并填写内容');
  const bodies = text.split(/^## .+$/m).slice(1);
  if (bodies.some(body => !body.trim())) throw new Error('大纲字段不能为空，未确定内容请写待确认');
  return text.trim();
}
