import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Workspace } from './workspace';

type Document = { schemaVersion: 1; projectId: string; updatedAt: string };
export interface ProjectRecordSnapshot<T> { value: T | null; hash: string; raw: string | null }
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const same = (a: string, b: string) => path.relative(a, b) === '';
const digest = (data: string) => createHash('sha256').update(data, 'utf8').digest('hex');
const queues = new Map<string, Promise<unknown>>();
const MAX_BYTES = 128 * 1024 * 1024; // Covers the bounded prompt library including its versions.

/** Per-book JSON records. Legacy name-based files are copied only after identity/schema checks;
 * raw-byte hashes, exclusive publication and a final recheck protect external edits. */
export class ProjectRecord<T extends Document> {
  constructor(private readonly workspace: Workspace, private readonly label: string, private readonly schema: z.ZodType<T>) {
    if (!/^[^\\/:*?"<>|.]+$/u.test(label)) throw new Error('非法资料类型');
  }
  private target(projectId: string) {
    const project = { ...this.workspace.getProject(z.uuid().parse(projectId)) };
    const directory = path.join(project.root, '小说资料');
    return { project, directory, file: path.join(directory, `${this.label}.json`) };
  }
  private async directory(directory: string, create = false): Promise<boolean> {
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (e) {
      if (!absent(e)) throw e;
      if (!create) return false;
      await fs.mkdir(directory).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; });
      stat = await fs.lstat(directory);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || !same(directory, await fs.realpath(directory))) throw new Error(`${this.label}资料目录不能使用链接或越界路径`);
    return true;
  }
  private async guard(root: string, directory: string, create = false): Promise<boolean> {
    if (!await this.directory(root)) throw new Error(`${this.label}小说目录不存在`);
    return this.directory(directory, create);
  }
  private parse(raw: string, projectId: string): T {
    let json: unknown;
    try { json = JSON.parse(raw.replace(/^\uFEFF/u, '')); } catch { throw new Error(`${this.label}文件损坏，原文件已保留`); }
    if (!json || typeof json !== 'object' || (json as Document).schemaVersion !== 1) throw new Error(`${this.label}文件版本不受支持，原文件已保留`);
    if ((json as Document).projectId !== projectId) throw new Error(`${this.label}文件归属与当前小说不符，原文件已保留`);
    const parsed = this.schema.safeParse(json);
    if (!parsed.success) throw new Error(`${this.label}文件损坏或版本不受支持，原文件已保留`);
    return parsed.data;
  }
  private async checkedRead(file: string, guard: () => Promise<unknown>): Promise<string | null> {
    await guard();
    let before;
    try { before = await fs.lstat(file); } catch (e) { if (absent(e)) return null; throw e; }
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_BYTES || !same(file, await fs.realpath(file))) throw new Error(`${this.label}文件不能使用链接或超限内容`);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_BYTES || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error(`${this.label}文件读取期间已修改`);
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length > MAX_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`${this.label}文件读取期间已修改`);
    } finally { await handle.close(); }
    await guard();
    const after = await fs.lstat(file);
    if (after.isSymbolicLink() || !after.isFile() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`${this.label}文件读取期间已修改`);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error(`${this.label}文件不是有效UTF-8，原文件已保留`); }
  }
  private async current(projectId: string): Promise<ProjectRecordSnapshot<T>> {
    const t = this.target(projectId);
    if (!await this.guard(t.project.root, t.directory)) return { value: null, hash: '', raw: null };
    const raw = await this.checkedRead(t.file, () => this.guard(t.project.root, t.directory));
    return raw === null ? { value: null, hash: '', raw: null } : { value: this.parse(raw, projectId), hash: digest(raw), raw };
  }
  async read(projectId: string): Promise<ProjectRecordSnapshot<T>> {
    const current = await this.current(projectId);
    if (current.value) return current;
    const t = this.target(projectId), legacyDirectory = path.join(path.dirname(t.project.root), '创作资料');
    // An edited project name is metadata, never a path component without validation.
    if (/[\\/:*?"<>|]/u.test(t.project.name) || t.project.name === '.' || t.project.name === '..') throw new Error(`${this.label}旧资料名称不是安全路径`);
    if (!await this.directory(legacyDirectory)) return current;
    const legacyFile = path.join(legacyDirectory, `${this.label}-${t.project.name}.json`);
    const legacyGuard = async () => { await this.directory(t.project.root); await this.directory(legacyDirectory); };
    const raw = await this.checkedRead(legacyFile, legacyGuard);
    if (raw === null) return current;
    this.parse(raw, projectId); // Wrong book/version is explicit, never treated as an empty book.
    await this.guard(t.project.root, t.directory, true);
    const temporary = path.join(t.directory, `.${this.label}-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, raw, { flag: 'wx' });
      const latest = await this.checkedRead(legacyFile, legacyGuard);
      if (latest === null || digest(latest) !== digest(raw)) throw new Error(`${this.label}旧资料迁移期间已修改，请刷新`);
      await this.guard(t.project.root, t.directory);
      try { await fs.link(temporary, t.file); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      return await this.current(projectId);
    } finally {
      if (await this.guard(t.project.root, t.directory).catch(() => false)) await fs.unlink(temporary).catch(e => { if (!absent(e)) throw e; });
    }
  }
  async save(projectId: string, value: T, expectedHash: string): Promise<ProjectRecordSnapshot<T>> {
    const target = this.target(projectId), frozen = structuredClone(value);
    // Validate before queuing; caller-owned objects cannot move an asynchronous write to another book.
    this.parse(JSON.stringify(frozen), projectId);
    const key = process.platform === 'win32' ? target.file.toLowerCase() : target.file;
    const previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.read(projectId);
      if (current.hash !== expectedHash) throw new Error(`${this.label}已被其他窗口修改，请刷新后重试`);
      // Preserve unknown top-level annotations within the known schema version.
      const combined = { ...(current.raw ? JSON.parse(current.raw.replace(/^\uFEFF/u, '')) as object : {}), ...frozen };
      const raw = JSON.stringify(combined, null, 2);
      this.parse(raw, projectId);
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error(`${this.label}文件过大`);
      await this.guard(target.project.root, target.directory, true);
      const temporary = path.join(target.directory, `.${this.label}-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, raw, { flag: 'wx' });
        if (current.raw !== null) {
          const history = path.join(target.directory, `${this.label}历史`);
          await this.guard(target.project.root, target.directory);
          await this.directory(history, true);
          await fs.writeFile(path.join(history, `${Date.now()}-${randomUUID()}.json`), current.raw, { flag: 'wx' });
        }
        // Recheck full bytes after temporary/history writes, immediately before publishing.
        const latest = await this.current(projectId);
        if (latest.hash !== expectedHash) throw new Error(`${this.label}已被其他窗口修改，请刷新后重试`);
        await this.guard(target.project.root, target.directory);
        if (current.raw === null) await fs.link(temporary, target.file);
        else await fs.rename(temporary, target.file);
        return { value: this.parse(raw, projectId), hash: digest(raw), raw };
      } finally {
        if (await this.guard(target.project.root, target.directory).catch(() => false)) await fs.unlink(temporary).catch(e => { if (!absent(e)) throw e; });
      }
    });
    queues.set(key, operation);
    void operation.finally(() => { if (queues.get(key) === operation) queues.delete(key); }).catch(() => {});
    return operation;
  }
}
