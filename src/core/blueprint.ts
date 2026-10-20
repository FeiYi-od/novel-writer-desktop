export type BlueprintScope = 'volume' | 'chapter';
export interface BlueprintNode {
  id: string; scope: BlueprintScope;
  /** Volume id for volumes, chapter path for chapters. */
  ref: string; title: string; goals: string; beats: string[];
  /** Chapter hash the plan was written against; used to flag a stale plan after the text changed. */
  sourceHash?: string; updatedAt: string;
}
export const BLUEPRINT_LIMITS = { nodes: 1000, title: 120, goals: 5000, beats: 50, beat: 300 } as const;
const clean = (value: unknown, limit: number, field: string) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`);
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if (text.length > limit) throw new Error(`${field}过长（最多 ${limit} 字）`);
  return text;
};
export function normalizeBlueprint(input: Partial<BlueprintNode>): BlueprintNode {
  const scope = input.scope === 'volume' ? 'volume' : input.scope === 'chapter' ? 'chapter' : null;
  if (!scope) throw new Error('蓝图必须属于分卷或章节');
  const ref = clean(input.ref, 2000, '关联对象');
  if (!ref) throw new Error('请先选择要写蓝图的分卷或章节');
  const title = clean(input.title, BLUEPRINT_LIMITS.title, '蓝图标题') || (scope === 'volume' ? '分卷蓝图' : '章节蓝图');
  const goals = clean(input.goals, BLUEPRINT_LIMITS.goals, '目标与要点');
  const beats = Array.isArray(input.beats)
    ? input.beats.map(item => clean(item, BLUEPRINT_LIMITS.beat, '情节点')).filter(Boolean).slice(0, BLUEPRINT_LIMITS.beats)
    : [];
  if (!goals && !beats.length) throw new Error('蓝图为空：至少写一条目标或情节点');
  const id = typeof input.id === 'string' && /^[0-9a-f-]{8,64}$/u.test(input.id) ? input.id : '';
  const sourceHash = typeof input.sourceHash === 'string' && /^[a-f0-9]{64}$/u.test(input.sourceHash) ? input.sourceHash : undefined;
  return { id, scope, ref, title, goals, beats, ...(sourceHash ? { sourceHash } : {}), updatedAt: String(input.updatedAt ?? '') };
}
export function assertBlueprints(nodes: BlueprintNode[]) {
  if (nodes.length > BLUEPRINT_LIMITS.nodes) throw new Error(`蓝图最多 ${BLUEPRINT_LIMITS.nodes} 条，请先归档`);
  const seen = new Set<string>();
  for (const node of nodes) {
    const key = `${node.scope}|${node.ref}`;
    if (seen.has(key)) throw new Error('同一个分卷或章节只能有一份蓝图');
    seen.add(key);
  }
}
/** A chapter plan goes stale when the text it was written against has changed. Volume plans have no
 * source hash, so they never report stale. */
export function isStale(node: BlueprintNode, currentHash?: string): boolean {
  if (node.scope !== 'chapter' || !node.sourceHash) return false;
  return currentHash !== undefined && currentHash !== node.sourceHash;
}
export function blueprintFor(nodes: BlueprintNode[], scope: BlueprintScope, ref: string): BlueprintNode | null {
  return nodes.find(node => node.scope === scope && node.ref === ref) ?? null;
}
