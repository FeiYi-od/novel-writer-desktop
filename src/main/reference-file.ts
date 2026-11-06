import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/** A bounded snapshot of one open file; the caller retains ownership of the handle. */
export async function readBoundedReferenceHandle(handle: Pick<FileHandle, 'stat' | 'read'>, limit: number, limitMessage: string): Promise<Buffer> {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error('参考文件不是普通文件');
  if (before.size > limit) throw new Error(limitMessage);
  const bytes = Buffer.allocUnsafe(before.size + 1); let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev) throw new Error('参考文件读取期间发生变化，请重新选择；原文件未修改');
  return bytes.subarray(0, offset);
}
export async function readBoundedReference(file: string, limit: number, limitMessage: string): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try { return await readBoundedReferenceHandle(handle, limit, limitMessage); }
  finally { await handle.close(); }
}
/** Bound a multi-file import before collecting all texts and compressed originals. */
export class ReferenceImportBudget {
  private bytes = 0;
  private characters = 0;
  addBytes(size: number) {
    this.bytes += size;
    if (this.bytes > 64 * 1024 * 1024) throw new Error('一次导入的参考文件合计不能超过 64 MiB，请分批导入');
  }
  addText(text: string) {
    if (text.length > 6000000) throw new Error('单份参考文本不能超过 600 万字符');
    this.characters += text.length;
    if (this.characters > 8000000) throw new Error('一次导入的参考文本合计不能超过 800 万字符，请分批导入');
  }
}
