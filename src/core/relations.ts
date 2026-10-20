export interface Relation { id: string; from: string; to: string; label: string; note: string; mutual: boolean; strength: number }
export const RELATION_LIMITS = { count: 300, label: 60, note: 1000, name: 120, strengthMin: 1, strengthMax: 5 } as const;
const clean = (value: unknown, limit: number, field: string) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`);
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if (text.length > limit) throw new Error(`${field}过长（最多 ${limit} 字）`);
  return text;
};
/** Validates one relation. A character cannot relate to itself, and the pair+label must be unique
 * so the graph never shows two identical edges. */
export function normalizeRelation(input: Partial<Relation>): Relation {
  const from = clean(input.from, RELATION_LIMITS.name, '起点角色');
  const to = clean(input.to, RELATION_LIMITS.name, '目标角色');
  const label = clean(input.label, RELATION_LIMITS.label, '关系名称');
  if (!from || !to) throw new Error('请选择关系两端的角色');
  if (from.toLowerCase() === to.toLowerCase()) throw new Error('角色不能与自己建立关系');
  if (!label) throw new Error('请填写关系名称（如「师徒」「宿敌」）');
  const strength = Number(input.strength ?? 3);
  if (!Number.isInteger(strength) || strength < RELATION_LIMITS.strengthMin || strength > RELATION_LIMITS.strengthMax)
    throw new Error(`关系强度需为 ${RELATION_LIMITS.strengthMin}–${RELATION_LIMITS.strengthMax} 的整数`);
  const id = typeof input.id === 'string' && /^[0-9a-f-]{8,64}$/u.test(input.id) ? input.id : '';
  return { id, from, to, label, note: clean(input.note, RELATION_LIMITS.note, '备注'), mutual: input.mutual === true, strength };
}
export function assertRelations(relations: Relation[]) {
  if (relations.length > RELATION_LIMITS.count) throw new Error(`人物关系最多 ${RELATION_LIMITS.count} 条，请先整理`);
  const seen = new Set<string>();
  for (const relation of relations) {
    const key = [relation.from.toLowerCase(), relation.to.toLowerCase()].sort().join('→') + '|' + relation.label.toLowerCase();
    if (seen.has(key)) throw new Error(`「${relation.from}」与「${relation.to}」的「${relation.label}」重复了`);
    seen.add(key);
  }
}
/** Groups edges per character for display; each character lists its relations sorted by strength. */
export function groupRelations(relations: Relation[]): { name: string; items: { relation: Relation; other: string; outgoing: boolean }[] }[] {
  const map = new Map<string, { relation: Relation; other: string; outgoing: boolean }[]>();
  for (const relation of relations) {
    const push = (owner: string, other: string, outgoing: boolean) => {
      const list = map.get(owner) ?? []; list.push({ relation, other, outgoing }); map.set(owner, list);
    };
    push(relation.from, relation.to, true);
    if (relation.mutual || relation.from !== relation.to) push(relation.to, relation.from, false);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items: items.sort((left, right) => right.relation.strength - left.relation.strength || left.other.localeCompare(right.other, 'zh-Hans-CN')) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
}
