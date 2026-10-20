import type { CharacterFields } from '../shared/contracts';
import { emptyCharacter } from './characters';
export type MaterialKind = 'character' | 'world';
const headings = { character: ['姓名', '角色描述', '性格与行为边界', '背景与场景'], world: ['时代与地点', '世界规则', '组织与势力', '能力与限制', '待确认事项'] };
export function materialTemplate(kind: MaterialKind, source: string, name = '未命名角色') {
  const values = kind === 'character' ? [name, source, '待补充', '待补充'] : ['待补充', source, '待补充', '待补充', '待补充'];
  return headings[kind].map((heading, i) => `## ${heading}\n\n${values[i]}`).join('\n\n');
}
export function conversionInstruction(kind: MaterialKind) {
  return `把用户提供的文段整理为${kind === 'character' ? '单个人物卡' : '世界观'}。仅提取文段中有依据的信息，不新增事实；无法确定写“待确认”。只输出 Markdown，不要代码围栏，必须依次使用这些二级标题，每个仅出现一次：${headings[kind].join('、')}。姓名字段只写一个名字，其他内容不能包含额外二级标题。多个人物时以主角为主，并在描述中标记待作者确认。`;
}
export function parseMaterial(kind: MaterialKind, markdown: string): CharacterFields | string {
  if (!markdown.trim() || markdown.length > 100000) throw new Error('转换资料需要有内容，且不能超过 10 万字符');
  const text = markdown.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/, '$1').replace(/\r\n/g, '\n').trim();
  const matches = [...text.matchAll(/^## (.+)$/gm)];
  if (matches.length !== headings[kind].length || matches.some((m, i) => m[1].trim() !== headings[kind][i])) throw new Error('资料标题不符合固定格式，请按模板修正后保存');
  const parts = matches.map((m, i) => text.slice(m.index! + m[0].length, matches[i + 1]?.index ?? text.length).trim());
  if (parts.some(part => !part)) throw new Error('资料字段不能留空，未知信息请写待确认');
  if (kind === 'world') return text;
  if (parts[0].length > 200 || parts[0].includes('\n')) throw new Error('姓名请填写单行，且不超过 200 字');
  return { ...emptyCharacter(), name: parts[0], description: parts[1], personality: parts[2], scenario: parts[3] };
}
