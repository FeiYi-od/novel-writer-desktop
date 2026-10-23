import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
const resultSchema = z.object({ schemaVersion: z.literal(1), status: z.enum(['skipped', 'imported', 'preserved']), files: z.number().int().min(0), backupDirectory: z.string().optional() }).passthrough();
/** One guard is shared by the installer and startup; it never overwrites existing data. */
export async function protectLegacyMaterials(sourceInstall: string, userData: string, script: string, allowProcessId = process.pid) {
  const source = path.join(path.resolve(sourceInstall), '创作资料');
  try { await fs.lstat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1 as const, status: 'skipped' as const, files: 0 }; throw error; }
  if (process.platform !== 'win32') throw new Error('旧版创作资料需要在 Windows 上安全迁移，原件已保留');
  try {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script),
      '-SourceInstall', path.resolve(sourceInstall), '-UserData', path.resolve(userData), '-AllowProcessId', String(allowProcessId)],
      { windowsHide: true, timeout: 300000, maxBuffer: 128 * 1024, encoding: 'utf8' });
    return resultSchema.parse(JSON.parse(stdout.trim().replace(/^\uFEFF/u, '')));
  } catch {
    // Do not relay child command lines, paths or material contents into an error log.
    throw new Error('旧版创作资料迁移未完成，原件及已创建的升级备份保留。请先保存退出旧版，再核对应用数据目录的 material-upgrade-backups；不要卸载旧版或覆盖资料');
  }
}
