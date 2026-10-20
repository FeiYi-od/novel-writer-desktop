import { execFile } from 'node:child_process';
import path from 'node:path';
import type { LocationKind } from '../core/sync-status';

export type DriveKind = 'fixed' | 'remote' | 'removable' | 'cdrom' | 'ramdisk' | 'unknown';
/** `fsutil fsinfo drivetype` prints one of these words (English on this machine, localised elsewhere). */
export function parseDriveType(output: string): DriveKind {
  const text = output.toLowerCase();
  if (/remote|网络/u.test(text)) return 'remote';
  if (/fixed|本地固定|固定/u.test(text)) return 'fixed';
  if (/removable|可移动/u.test(text)) return 'removable';
  if (/cd-?rom|光驱|光盘/u.test(text)) return 'cdrom';
  if (/ram ?disk|内存盘/u.test(text)) return 'ramdisk';
  return 'unknown';
}
export type Runner = (file: string, args: string[]) => Promise<string>;
/** fsutil writes in the OEM code page (GBK on this machine), so decode explicitly instead of
 * trusting Node's default UTF-8 conversion. */
export function decodeConsole(buf: Buffer): string {
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('utf8'); }
}
const runFsutil: Runner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 4000, encoding: 'buffer' }, (error, stdout) => error ? reject(error) : resolve(decodeConsole(stdout as unknown as Buffer)));
});
/** A mapped NAS share looks exactly like a local drive in the path string, so ask Windows for the
 * real drive type. Any failure degrades to `unknown` instead of guessing. */
export async function detectPathLocation(input: string, run: Runner = runFsutil): Promise<LocationKind> {
  const value = input.trim();
  if (!value) return 'unknown';
  if (/^\\\\[^\\]+\\/u.test(value)) return 'unc';
  const drive = /^([a-z]):[\\/]/iu.exec(value);
  if (!drive) return value.startsWith('/') ? 'local' : 'unknown';
  if (process.platform !== 'win32') return 'unknown';
  try {
    const output = await run('fsutil', ['fsinfo', 'drivetype', `${drive[1]!.toUpperCase()}:`]);
    const kind = parseDriveType(output);
    if (kind === 'remote') return 'network';
    if (kind === 'fixed' || kind === 'removable' || kind === 'ramdisk') return 'local';
    if (kind === 'cdrom') return 'unknown';
    return 'unknown';
  } catch { return 'unknown'; }
}
export function driveOf(input: string): string | null {
  const match = /^([a-z]):[\\/]/iu.exec(input.trim());
  return match ? `${match[1]!.toUpperCase()}:` : null;
}
export function shareNameOf(input: string): string | null {
  const match = /^\\\\([^\\]+)\\([^\\]+)/u.exec(input.trim());
  return match ? `${match[1]}\\${match[2]}` : null;
}
export function libraryRootHint(input: string): string {
  const drive = driveOf(input);
  if (drive) return path.win32.join(drive, path.win32.sep);
  return shareNameOf(input) ?? input;
}
