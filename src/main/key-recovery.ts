import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { SecretCodec } from './ai-connections';

export interface KeyStateReport { file: string; backup: string; connections: { id: string; name: string; state: 'ok' | 'missing' | 'unreadable' }[]; backupUsable: boolean }
/** Reads stored connections and reports, per connection, whether the encrypted key can still be
 * decrypted on this machine. A force-quit or an OS keyring reset leaves ciphertext that no longer
 * decrypts; the UI must show "需要重新填写" instead of pretending a key exists. */
export async function inspectKeys(file: string, codec: SecretCodec): Promise<KeyStateReport> {
  const backup = `${file}.backup`;
  const read = async (target: string) => JSON.parse(await fs.readFile(target, 'utf8')) as { connections?: { id: string; name: string; encryptedKey?: string }[] };
  const stored = await read(file).catch(async error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { connections: [] };
    // Main file unreadable: fall back to the backup purely for the report, never silently overwrite.
    const restored = await read(backup).catch(() => ({ connections: [] }));
    return restored;
  });
  const connections = (stored.connections ?? []).map(item => {
    if (!item.encryptedKey) return { id: item.id, name: item.name, state: 'missing' as const };
    try { codec.decrypt(Buffer.from(item.encryptedKey, 'base64')); return { id: item.id, name: item.name, state: 'ok' as const }; }
    catch { return { id: item.id, name: item.name, state: 'unreadable' as const }; }
  });
  const backupUsable = await read(backup).then(value => (value.connections ?? []).length > 0).catch(() => false);
  return { file, backup, connections, backupUsable };
}
/** Every successful save leaves the previous file next to it, so a crash mid-write never leaves the
 * author without a readable copy. */
export async function keepPreviousCopy(file: string) {
  const previous = await fs.readFile(file).catch(() => null);
  if (previous) await fs.writeFile(`${file}.backup`, previous).catch(() => {});
}
export async function restoreFromBackup(file: string) {
  const backup = `${file}.backup`;
  const raw = await fs.readFile(backup, 'utf8').catch(() => {
    throw new Error('没有可用的连接备份文件');
  });
  JSON.parse(raw); // 先确认备份本身可解析
  await fs.writeFile(file, raw, 'utf8');
  return true;
}
export function describeKeyState(state: 'ok' | 'missing' | 'unreadable'): string {
  if (state === 'ok') return '密钥可用';
  if (state === 'missing') return '未填写密钥';
  return '密钥无法解密，需要重新填写（系统凭据已变化或被强制退出中断）';
}
export function keyDirOf(userData: string) { return path.join(userData, 'ai-connections.json'); }
