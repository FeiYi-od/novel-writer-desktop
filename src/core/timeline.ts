export interface TimelineEntry { id: string; when: string; title: string; note: string; chapterPath?: string }
export const TIMELINE_LIMITS = { entries: 500, when: 60, title: 120, note: 2000 } as const;
/** Sorts by the author's own time label. Labels are compared qualitatively: numbers inside the
 * label compare numerically ("第2天" < "第10天"), everything else compares as text, and equal
 * labels keep their original order so editing never shuffles the list. */
export function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const compare = compareLabels(left.entry.when, right.entry.when);
    return compare !== 0 ? compare : left.index - right.index;
  }).map(item => item.entry);
}
export function compareLabels(left: string, right: string): number {
  const pattern = /(\d+|\D+)/gu;
  const a = left.match(pattern) ?? [], b = right.match(pattern) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const x = a[index], y = b[index];
    if (x === y) continue;
    const nx = /^\d+$/u.test(x), ny = /^\d+$/u.test(y);
    if (nx && ny) { const diff = Number(x) - Number(y); if (diff) return diff; continue; }
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
/** Normalises and validates an entry; throws instead of silently truncating author input. */
export function normalizeEntry(input: Partial<TimelineEntry>): TimelineEntry {
  const clean = (value: unknown, limit: number, label: string) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
    const text = value.replace(/\r\n?/gu, '\n').trim();
    if (text.length > limit) throw new Error(`${label}过长（最多 ${limit} 字）`);
    return text;
  };
  const when = clean(input.when, TIMELINE_LIMITS.when, '时间点');
  const title = clean(input.title, TIMELINE_LIMITS.title, '事件标题');
  if (!when) throw new Error('请填写时间点（例如「第3天清晨」或「第一年·春」）');
  if (!title) throw new Error('请填写事件标题');
  const id = typeof input.id === 'string' && /^[a-f0-9-]{8,64}$/u.test(input.id) ? input.id : '';
  const chapterPath = clean(input.chapterPath, 2000, '关联章节');
  return { id, when, title, note: clean(input.note, TIMELINE_LIMITS.note, '备注'), ...(chapterPath ? { chapterPath } : {}) };
}
export function assertTimelineSize(entries: TimelineEntry[]) {
  if (entries.length > TIMELINE_LIMITS.entries) throw new Error(`时间线最多 ${TIMELINE_LIMITS.entries} 条，请归档已完成的事件`);
}
