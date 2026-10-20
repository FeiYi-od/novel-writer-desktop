export interface PromptVersion { version: number; body: string; savedAt: string }
export interface PromptTemplate {
  id: string; name: string; kind: 'write' | 'review' | 'planning' | 'other'; body: string;
  version: number; updatedAt: string; versions: PromptVersion[];
}
export const PROMPT_LIMITS = { count: 200, name: 60, body: 20000, versions: 20 } as const;
const text = (value: unknown, limit: number, field: string) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`);
  const clean = value.replace(/\r\n?/gu, '\n').trim();
  if (clean.length > limit) throw new Error(`${field}过长（最多 ${limit} 字）`);
  return clean;
};
const kinds = ['write', 'review', 'planning', 'other'] as const;
export function normalizeTemplate(input: Partial<PromptTemplate>): PromptTemplate {
  const name = text(input.name, PROMPT_LIMITS.name, '模板名称');
  const body = text(input.body, PROMPT_LIMITS.body, '模板内容');
  if (!name) throw new Error('请填写模板名称');
  if (!body) throw new Error('提示词内容不能为空');
  const kind = kinds.includes(input.kind as never) ? input.kind as PromptTemplate['kind'] : 'other';
  const version = Number.isInteger(input.version) && (input.version as number) > 0 ? input.version as number : 1;
  const versions = Array.isArray(input.versions)
    ? input.versions.map(item => ({ version: Number(item.version), body: text(item.body, PROMPT_LIMITS.body, '历史内容'), savedAt: String(item.savedAt ?? '') }))
      .filter(item => Number.isInteger(item.version) && item.version > 0).slice(0, PROMPT_LIMITS.versions)
    : [];
  return { id: typeof input.id === 'string' && /^[0-9a-f-]{8,64}$/u.test(input.id) ? input.id : '', name, kind, body, version, updatedAt: String(input.updatedAt ?? ''), versions };
}
/** Saving the same text again must not create a new version; any change becomes version+1 and the
 * previous text is kept in the (capped) history so an author can go back. */
export function withNewVersion(template: PromptTemplate, body: string, savedAt: string): PromptTemplate {
  const nextBody = text(body, PROMPT_LIMITS.body, '模板内容');
  if (!nextBody) throw new Error('提示词内容不能为空');
  if (nextBody === template.body) return { ...template, updatedAt: savedAt };
  const versions = [{ version: template.version, body: template.body, savedAt: template.updatedAt || savedAt }, ...template.versions]
    .slice(0, PROMPT_LIMITS.versions);
  return { ...template, body: nextBody, version: template.version + 1, updatedAt: savedAt, versions };
}
export function assertTemplates(templates: PromptTemplate[]) {
  if (templates.length > PROMPT_LIMITS.count) throw new Error(`提示词模板最多 ${PROMPT_LIMITS.count} 个，请先归档`);
  const seen = new Set<string>();
  for (const template of templates) {
    const key = template.name.toLowerCase();
    if (seen.has(key)) throw new Error(`模板名称「${template.name}」重复了`);
    seen.add(key);
  }
}
export function templatesFor(templates: PromptTemplate[], kind: PromptTemplate['kind']): PromptTemplate[] {
  return templates.filter(item => item.kind === kind).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
}
