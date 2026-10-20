export interface CharacterState {
  id: string; character: string; label: string; note: string;
  /** 1-based positions in the book's chapter order; empty means "from the start" / "until the end". */
  fromChapter?: number; toChapter?: number;
}
export const STATE_LIMITS = { count: 500, label: 40, note: 1000, name: 120 } as const;
const text = (value: unknown, limit: number, field: string) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`);
  const clean = value.replace(/\r\n?/gu, '\n').trim();
  if (clean.length > limit) throw new Error(`${field}过长（最多 ${limit} 字）`);
  return clean;
};
const position = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100_000) throw new Error(`${field}必须是正整数（第几章）`);
  return number;
};
export function normalizeState(input: Partial<CharacterState>): CharacterState {
  const character = text(input.character, STATE_LIMITS.name, '角色');
  const label = text(input.label, STATE_LIMITS.label, '状态名称');
  if (!character) throw new Error('请选择角色');
  if (!label) throw new Error('请填写状态名称（如「受伤」「失忆」「与主角结盟」）');
  const fromChapter = position(input.fromChapter, '起始章节'), toChapter = position(input.toChapter, '结束章节');
  if (fromChapter !== undefined && toChapter !== undefined && toChapter < fromChapter) throw new Error('结束章节不能早于起始章节');
  const id = typeof input.id === 'string' && /^[0-9a-f-]{8,64}$/u.test(input.id) ? input.id : '';
  return { id, character, label, note: text(input.note, STATE_LIMITS.note, '说明'), ...(fromChapter !== undefined ? { fromChapter } : {}), ...(toChapter !== undefined ? { toChapter } : {}) };
}
export function assertStates(states: CharacterState[]) {
  if (states.length > STATE_LIMITS.count) throw new Error(`人物状态最多 ${STATE_LIMITS.count} 条，请先整理`);
  const seen = new Set<string>();
  for (const state of states) {
    const key = `${state.character.toLowerCase()}|${state.label.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`「${state.character}」的「${state.label}」重复了`);
    seen.add(key);
  }
}
/** States that apply to one chapter position: open ranges include everything on that side. */
export function statesForChapter(states: CharacterState[], chapterPosition: number): CharacterState[] {
  if (!Number.isInteger(chapterPosition) || chapterPosition < 1) return [];
  return states.filter(state => (state.fromChapter === undefined || chapterPosition >= state.fromChapter)
    && (state.toChapter === undefined || chapterPosition <= state.toChapter))
    .sort((left, right) => left.character.localeCompare(right.character, 'zh-Hans-CN') || left.label.localeCompare(right.label, 'zh-Hans-CN'));
}
/** Human-readable range for lists, so authors see "第3章起" instead of raw numbers. */
export function describeRange(state: CharacterState): string {
  if (state.fromChapter === undefined && state.toChapter === undefined) return '全书适用';
  if (state.toChapter === undefined) return `第${state.fromChapter}章起`;
  if (state.fromChapter === undefined) return `第${state.toChapter}章前`;
  return state.fromChapter === state.toChapter ? `仅第${state.fromChapter}章` : `第${state.fromChapter}–${state.toChapter}章`;
}
