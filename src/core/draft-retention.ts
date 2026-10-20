export interface RetainableDraft { id: string; at: string }
/** 保留策略：永远保留最新的 keep 份，其余旧副本才会被清理；同时按天数兜底。
 * 纯函数，方便在不碰文件的情况下把规则测清楚。 */
export function selectDraftsToPrune<T extends RetainableDraft>(drafts: T[], options: { keep?: number; olderThanDays?: number; now?: Date } = {}): T[] {
  const keep = Math.max(1, options.keep ?? 20);
  const olderThanDays = options.olderThanDays ?? 30;
  const now = options.now ?? new Date();
  const stamp = (draft: T) => { const parsed = Date.parse(draft.at); return Number.isFinite(parsed) ? parsed : 0; };
  // 解析不了时间的旧副本排到最后（当作最旧），才有机会被清理。
  const sorted = [...drafts].sort((left, right) => stamp(right) - stamp(left));
  const cutoff = now.getTime() - olderThanDays * 24 * 60 * 60 * 1000;
  return sorted.slice(keep).filter(draft => {
    const at = Date.parse(draft.at);
    return Number.isFinite(at) ? at < cutoff : true;
  });
}
/** 给界面用的说明文案：清理多少份、保留多少份。 */
export function describePrune(total: number, prune: number, keep = 20) {
  if (!prune) return `当前 ${total} 份备份，都在保留范围内（最多保留 ${keep} 份，且不超过 30 天）`;
  return `当前 ${total} 份备份，将清理 ${prune} 份较旧的，保留最新 ${Math.min(keep, total - prune)} 份`;
}
