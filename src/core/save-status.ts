export interface SaveFailure { at: string; message: string; draftKept: boolean }
export interface SaveState { lastSuccessAt?: string; lastFailure?: SaveFailure; unsaved?: boolean }
export interface SaveBadge { label: string; tone: 'ok' | 'warn' | 'danger'; detail: string }
/** 保存状态必须是"最近一次结果"，失败后不能被上一次成功掩盖——否则作者会以为稿子已经落盘。 */
export function describeSaveBadge(state: SaveState, now = new Date()): SaveBadge {
  const failedAt = state.lastFailure ? Date.parse(state.lastFailure.at) : 0;
  const savedAt = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
  if (state.lastFailure && failedAt >= savedAt) {
    const minutes = Math.max(0, Math.round((now.getTime() - failedAt) / 60000));
    return {
      label: state.lastFailure.draftKept ? '上次保存失败（草稿在本机恢复区）' : '上次保存失败',
      tone: 'danger',
      detail: `${state.lastFailure.message}${minutes ? `（${minutes} 分钟前）` : ''}`
    };
  }
  if (state.unsaved) return { label: '正文有未保存修改', tone: 'warn', detail: '' };
  if (state.lastSuccessAt) return { label: '已保存到所选文件夹', tone: 'ok', detail: '' };
  return { label: '尚未保存', tone: 'warn', detail: '' };
}
/** 只有暂存确实成功或错误明确说已保留草稿，才显示恢复提示。 */
export function toFailure(message: string, at = new Date(), draftKept?: boolean): SaveFailure {
  return { at: at.toISOString(), message: message.trim().slice(0, 300), draftKept: draftKept ?? /(?:草稿已(?:保存|保留)|本机稿件仍在恢复区)/u.test(message) };
}
