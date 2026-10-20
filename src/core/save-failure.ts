export interface SaveFailure { code: string; network: boolean; message: string }
const NETWORK_CODES = new Set(['ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'EIO', 'ENOTCONN', 'EACCES', 'EPERM', 'EBUSY']);
/** Turns a filesystem error into words the author can act on. Network folders (mapped NAS drives)
 * fail with a different code set than local disks, and the draft is already in the local recovery
 * area — the message must say both facts and never suggest the file was saved. */
export function describeSaveFailure(error: unknown): SaveFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN';
  const network = NETWORK_CODES.has(code);
  if (code === 'ENOSPC') return { code, network, message: '保存失败：磁盘空间不足，本机稿件仍在恢复区，原文件未改动' };
  if (code === 'EROFS') return { code, network: true, message: '保存失败：目标为只读位置，本机稿件仍在恢复区，原文件未改动' };
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { code, network: true, message: '保存失败：文件被占用或没有写权限，本机稿件仍在恢复区，原文件未改动' };
  if (network) return { code, network: true, message: '保存失败：网络目录不可用（可能已断线或同步客户端未就绪），本机稿件仍在恢复区，原文件未改动' };
  return { code, network: false, message: '保存失败：目标文件无法写入，本机稿件仍在恢复区，原文件未改动' };
}
