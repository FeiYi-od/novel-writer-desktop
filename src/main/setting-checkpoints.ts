import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const fileSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.uuid(), connectionId: z.uuid(),
  template: z.enum(['character', 'world', 'both']), chunkCharacters: z.number().int().min(2000).max(20000),
  chapters: z.array(z.object({ path: z.string().min(1).max(2000), hash: z.string().min(1).max(200) })).min(1).max(10000),
  inventory: z.array(z.string().min(1).max(2000)).min(1).max(10000),
  sourceHash: digest, total: z.number().int().min(1).max(10000),
  fingerprint: digest, salt: z.uuid(), instructionVersion: z.literal(1),
  segments: z.array(z.unknown()).max(10000), updatedAt: z.string().min(1).max(40)
}).strict().refine(value => value.segments.length <= value.total);
export type SettingCheckpoint = z.infer<typeof fileSchema>;
const MAX_BYTES = 32 * 1024 * 1024;

/** Local-only unconfirmed model output. Unknown or corrupted files are never replaced. */
export class SettingCheckpointStore {
  constructor(private readonly userData: string) {}
  private file(projectId: string) { return path.join(this.userData, 'setting-checkpoints', `${z.uuid().parse(projectId)}.json`); }
  async read(projectId: string): Promise<{ value: SettingCheckpoint; hash: string } | null> {
    let raw: string;
    try {
      const file = this.file(projectId), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('断点文件不受支持，原文件已保留');
      raw = await fs.readFile(file, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const value = fileSchema.parse(JSON.parse(raw));
      if (value.projectId !== projectId) throw new Error('project mismatch');
      return { value, hash: hash(raw) };
    } catch { throw new Error('全文整理断点已损坏或版本不支持，原文件已保留'); }
  }
  async write(projectId: string, input: SettingCheckpoint, expectedHash: string | null) {
    const value = fileSchema.parse(input);
    if (value.projectId !== projectId) throw new Error('断点小说不匹配');
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('本机断点超过 32 MiB，已停止保存；已有断点保留');
    const file = this.file(projectId); await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, raw, { flag: 'wx' });
      if (expectedHash === null) {
        try { await fs.link(temp, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('本书已有本机整理断点，请先处理已有断点'); throw error; }
      } else {
        const current = await this.read(projectId);
        if (!current || current.hash !== expectedHash) throw new Error('本机整理断点已变化，未覆盖');
        await fs.rename(temp, file);
      }
      return hash(raw);
    } finally { await fs.rm(temp, { force: true }); }
  }
  async remove(projectId: string, expectedHash: string) {
    const current = await this.read(projectId);
    if (!current || current.hash !== expectedHash) throw new Error('本机整理断点已变化，请刷新后再处理');
    await fs.unlink(this.file(projectId));
  }
  private async rawForQuarantine(projectId: string) {
    const file = this.file(projectId), directory = path.dirname(file), parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw new Error('断点目录包含链接，不能自动隔离');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('断点不是普通文件或超过 64 MiB，原文件已保留，请手动核对');
    const bytes = await fs.readFile(file), after = await fs.lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes.length !== stat.size) throw new Error('断点读取期间发生变化，请重新核对');
    return { file, directory, stat, bytes };
  }
  async inspectCheckpointFile(projectId: string) {
    const raw = await this.rawForQuarantine(projectId);
    return { hash: hash(raw.bytes), bytes: raw.bytes.length };
  }
  async quarantineCheckpointFile(projectId: string, expectedHash: string) {
    digest.parse(expectedHash);
    const original = await this.rawForQuarantine(projectId);
    if (hash(original.bytes) !== expectedHash) throw new Error('断点已变化，请重新查看后再隔离');
    const directory = path.join(original.directory, 'quarantine'); await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await fs.realpath(directory)) !== path.resolve(directory)) throw new Error('断点隔离目录包含链接，原文件已保留');
    const backup = path.join(directory, `${projectId}-${randomUUID()}.json`);
    await fs.link(original.file, backup);
    const backupStat = await fs.lstat(backup), current = await this.rawForQuarantine(projectId);
    if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.dev !== original.stat.dev || backupStat.ino !== original.stat.ino || current.stat.dev !== original.stat.dev || current.stat.ino !== original.stat.ino || hash(current.bytes) !== expectedHash) throw new Error(`断点在隔离期间发生变化，原文件及备份已保留：${backup}`);
    try { await fs.unlink(original.file); }
    catch { throw new Error(`断点备份已保留，但无法移除原位置，请手动核对：${backup}`); }
    return { backup, bytes: original.bytes.length, hash: expectedHash };
  }
}
