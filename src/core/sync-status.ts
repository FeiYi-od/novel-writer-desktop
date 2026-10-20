export type LocationKind = 'local' | 'unc' | 'network' | 'unknown';
export type SyncLevel = 'local' | 'unsynced' | 'failed' | 'unknown';
export interface SyncState { level: SyncLevel; text: string }
/** Windows can map a NAS share to a drive letter, so a plain `Z:\` path cannot be proven local.
 * Only a UNC path (`\\server\share`) is certain — everything else stays "unknown" rather than a
 * comfortable lie. */
export function classifyPath(input: string): LocationKind {
  const value = input.trim();
  if (!value) return 'unknown';
  if (/^\\\\[^\\]+\\/u.test(value)) return 'unc';
  if (/^[a-z]:[\\/]/iu.test(value)) return 'unknown';
  if (value.startsWith('/')) return 'local';
  return 'unknown';
}
/** The editor can only vouch for what it just did. Without a NAS-side check it must not claim
 * "synced"; the wording below keeps local save, unsynced network folder and outage apart. */
export function describeSyncState(input: { location: LocationKind; saved: boolean; error?: string; verifiedRemote?: boolean }): SyncState {
  if (!input.saved) {
    return { level: 'failed', text: input.error ? `保存失败：${input.error}` : '保存失败，正文仍在本机恢复区' };
  }
  if (input.verifiedRemote) return { level: 'unsynced', text: '本机已保存，远端已校验（仍未确认客户端同步完成）' };
  if (input.location === 'unc') return { level: 'unsynced', text: '已写入网络目录；是否同步到 NAS 由飞牛客户端决定，本机无法确认' };
  if (input.location === 'network') return { level: 'unsynced', text: '已写入网络盘（映射盘）；是否同步到 NAS 由飞牛客户端决定，本机无法确认' };
  if (input.location === 'local') return { level: 'local', text: '已保存到本机文件夹' };
  return { level: 'unknown', text: '已保存；无法确认该位置是本地还是同步目录（映射盘无法从路径判断）' };
}
export function needsAttention(state: SyncState): boolean { return state.level === 'failed' || state.level === 'unknown'; }
