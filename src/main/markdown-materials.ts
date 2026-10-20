import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CharacterSnapshot, ProjectNotes, LearnedStyle } from '../shared/contracts';
import { hashText } from './ai-connections';

const marker = '<!-- nw-field:';
const labels: Record<string, string> = { characters: '人物笔记', world: '世界观', preset: '写作预设', style: '文风笔记', name: '姓名', description: '角色描述', personality: '性格与行为边界', scenario: '背景与场景', firstMessage: '开场白', examples: '示例对白', creatorNotes: '作者说明', systemPrompt: '卡片系统提示', postHistoryInstructions: '历史后指令', alternateGreetings: '其他开场白（JSON 数组）' };
const fields = ['name', 'description', 'personality', 'scenario', 'firstMessage', 'examples', 'creatorNotes', 'systemPrompt', 'postHistoryInstructions', 'alternateGreetings'] as const;
export const safeJson = (value: unknown) => JSON.stringify(value).replace(/--/g, '\\u002d\\u002d').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export function section(key: string, title: string, text: string) {
  if (text.includes('<!-- nw-')) throw new Error('资料正文包含保留的 nw 标记，请改写该标记后保存');
  return `## ${title}\n\n${marker}${key} -->\n${text}\n<!-- nw-end:${key} -->\n`;
}
export function metadata(raw: string, kind: string, projectId: string): any {
  const match = /^<!-- novel-writer ([^\r\n]+) -->\r?\n/.exec(raw);
  if (!match) throw new Error('Markdown 资料缺少版本信息，原文件已保留');
  const meta = JSON.parse(match[1]);
  if (meta.schemaVersion !== 1 || meta.kind !== kind || meta.projectId !== projectId) throw new Error('Markdown 资料版本或小说归属不匹配');
  return meta;
}
export function readSection(raw: string, key: string) {
  const start = `${marker}${key} -->\n`, end = `\n<!-- nw-end:${key} -->`;
  raw = raw.replace(/\r\n/g, '\n');
  const from = raw.indexOf(start), to = raw.indexOf(end, from + start.length);
  if (from < 0 || to < 0 || raw.indexOf(start, from + start.length) >= 0 || raw.indexOf(end, to + end.length) >= 0) throw new Error(`Markdown 字段 ${key} 缺失或重复，未覆盖文件`);
  return raw.slice(from + start.length, to);
}
export function notesMarkdown(notes: ProjectNotes) {
  return `<!-- novel-writer ${safeJson({ schemaVersion: 1, projectId: notes.projectId, kind: 'notes' })} -->\n# 创作笔记\n\n请保留字段标记，在标记之间编辑内容。\n\n` + (['characters', 'world', 'preset', 'style'] as const).map(key => section(key, labels[key], notes[key])).join('\n');
}
export function parseNotesMarkdown(raw: string, projectId: string): ProjectNotes {
  metadata(raw, 'notes', projectId);
  return { schemaVersion: 1, projectId, characters: readSection(raw, 'characters'), world: readSection(raw, 'world'), preset: readSection(raw, 'preset'), style: readSection(raw, 'style') };
}
export function charactersMarkdown(value: CharacterSnapshot['value']) {
  const cards = value.cards.map(card => { const meta = { ...card } as Record<string, unknown>; for (const field of fields) delete meta[field]; return meta; });
  return `<!-- novel-writer ${safeJson({ schemaVersion: 1, projectId: value.projectId, kind: 'characters', cards })} -->\n# 人物卡\n\n文件头保留导入扩展和资源引用；正文为可编辑字段。请保留字段标记。\n\n` + value.cards.map(card => `# ${card.name.replace(/\r?\n/g, ' ')}\n\n` + fields.map(key => section(`${card.id}:${key}`, labels[key], key === 'alternateGreetings' ? JSON.stringify(card[key], null, 2) : card[key])).join('\n')).join('\n');
}
export function parseCharactersMarkdown(raw: string, projectId: string): CharacterSnapshot['value'] {
  const meta = metadata(raw, 'characters', projectId);
  if (!Array.isArray(meta.cards) || meta.cards.length > 200) throw new Error('Markdown 角色索引无效');
  return { schemaVersion: 1, projectId, cards: meta.cards.map((card: any) => {
    z.uuid().parse(card.id);
    return { ...card, ...Object.fromEntries(fields.map(key => [key, key === 'alternateGreetings' ? JSON.parse(readSection(raw, `${card.id}:${key}`)) : readSection(raw, `${card.id}:${key}`)])) };
  }) };
}
export function stylesMarkdown(projectId: string, styles: LearnedStyle[]) {
  const metadata = styles.map(({ name, rules, ...style }) => style);
  return `<!-- novel-writer ${safeJson({ schemaVersion: 1, projectId, kind: 'styles', styles: metadata })} -->\n# 文风档案\n\n` + styles.map(style => section(`${style.id}:name`, '文风名称', style.name) + '\n' + section(`${style.id}:rules`, '文风规则', style.rules)).join('\n');
}
export function parseStylesMarkdown(raw: string, projectId: string): LearnedStyle[] {
  const meta = metadata(raw, 'styles', projectId);
  if (!Array.isArray(meta.styles) || meta.styles.length > 100) throw new Error('文风 Markdown 索引无效');
  return meta.styles.map((style: any) => { z.uuid().parse(style.id); return { ...style, name: readSection(raw, `${style.id}:name`), rules: readSection(raw, `${style.id}:rules`) }; });
}
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
export async function materialDirectory(root: string, projectId: string) {
  z.uuid().parse(projectId); await fs.mkdir(root, { recursive: true });
  const base = await fs.realpath(root), directory = path.join(base, projectId);
  await fs.mkdir(directory, { recursive: true });
  if (!inside(base, await fs.realpath(directory))) throw new Error('固定资料目录越界');
  return directory;
}
export async function readMarkdown(file: string) {
  try {
    if (!inside(await fs.realpath(path.dirname(file)), await fs.realpath(file))) throw new Error('Markdown 文件链接越界');
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error('Markdown 资料过大');
    return await fs.readFile(file, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function writeMarkdown(file: string, raw: string, expectedHash: string) {
  const previous = await readMarkdown(file);
  if ((previous === null ? '' : hashText(previous)) !== expectedHash) throw new Error('Markdown 资料已在外部更新，请重新读取后保存');
  if (previous !== null) {
    const directory = path.join(path.dirname(file), 'history'); await fs.mkdir(directory, { recursive: true });
    if (!inside(path.dirname(file), await fs.realpath(directory))) throw new Error('Markdown 备份目录越界');
    await fs.writeFile(path.join(directory, `${path.basename(file, '.md')}-${hashText(previous)}.md`), previous, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, raw, { flag: 'wx' });
    const current = await readMarkdown(file);
    if ((current === null ? '' : hashText(current)) !== expectedHash) throw new Error('Markdown 资料保存期间发生变化');
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
