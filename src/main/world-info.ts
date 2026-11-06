import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseWorldInfoFile, selectWorldEntries, type StWorldEntry, type StWorldInfo, type WorldCharacterContext } from '../core/st-cards';
import type { Workspace } from './workspace';
import { z } from 'zod';

const trashFields = { id: z.uuid(), projectId: z.uuid(), book: z.string().min(1).max(60), entryId: z.string().min(1).max(500), removedAt: z.string().datetime(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), entry: z.custom<Record<string, unknown>>(value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)) };
const worldTrashSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(1), ...trashFields }).strict(),
  z.object({ schemaVersion: z.literal(2), ...trashFields, container: z.literal('array'), afterEntriesHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
]);
const entriesHash = (entries: unknown[]) => createHash('sha256').update(JSON.stringify(entries)).digest('hex');

/** World info books stored as plain SillyTavern JSON files inside the book, so they can be shared
 * both ways without conversion. */
export class WorldInfoStore {
  private editQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private async checkedDirectory(directory: string) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') throw new Error('世界书目录不能使用链接或越界路径');
    return { dev: stat.dev, ino: stat.ino };
  }
  private async readRegular(file: string) {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || path.relative(file, await fs.realpath(file)) !== '') throw new Error('世界书文件不能使用链接或越界路径');
    const handle = await fs.open(file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error('世界书文件读取前已变化');
      const bytes = await handle.readFile();
      const after = await handle.stat(), latest = await fs.lstat(file);
      if (!latest.isFile() || latest.isSymbolicLink() || latest.dev !== opened.dev || latest.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || latest.size !== after.size || latest.mtimeMs !== after.mtimeMs || latest.ctimeMs !== after.ctimeMs) throw new Error('世界书文件读取期间已变化');
      return bytes;
    } finally { await handle.close(); }
  }
  private async directory(projectId: string) {
    const project = this.workspace.getProject(projectId);
    const root = project.root, metadata = path.join(root, '小说资料'), directory = path.join(metadata, '世界书');
    const rootIdentity = await this.checkedDirectory(root);
    const metadataIdentity = await this.checkedDirectory(metadata);
    let record: { schemaVersion?: unknown; id?: unknown };
    let recordBytes: Buffer;
    try { recordBytes = await this.readRegular(path.join(metadata, 'project.json')); record = JSON.parse(recordBytes.toString('utf8')); }
    catch { throw new Error('小说归属资料缺失、损坏或包含链接'); }
    if (record.schemaVersion !== 1 || record.id !== projectId) throw new Error('世界书小说归属已变化');
    await fs.mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const directoryIdentity = await this.checkedDirectory(directory);
    return { directory, identity: JSON.stringify({ rootIdentity, metadataIdentity, directoryIdentity, recordHash: createHash('sha256').update(recordBytes).digest('hex') }) };
  }
  private async unchanged(projectId: string, expected: { directory: string; identity: string }) {
    const latest = await this.directory(projectId);
    if (latest.directory !== expected.directory || latest.identity !== expected.identity) throw new Error('世界书目录或小说归属已变化');
  }
  private safeName(name: string) {
    const clean = name.replace(/[\\/:*?"<>|]/gu, '_').trim().slice(0, 60);
    if (!clean) throw new Error('世界书需要一个名字');
    return `${clean}.json`;
  }
  async list(projectId: string) {
    const location = await this.directory(projectId), { directory } = location;
    const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
    const books = [];
    for (const file of files) {
      try {
        const bytes = await this.readRegular(path.join(directory, file));
        const world = parseWorldInfoFile(JSON.parse(bytes.toString('utf8')));
        books.push({ name: path.basename(file, '.json'), entries: world.entries.length, keys: world.entries.reduce((sum, entry) => sum + entry.keys.length, 0), hash: createHash('sha256').update(bytes).digest('hex') });
      } catch { books.push({ name: path.basename(file, '.json'), entries: 0, keys: 0, error: '文件损坏，已跳过' }); }
    }
    await this.unchanged(projectId, location);
    return books.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }
  async import(projectId: string, name: string, json: unknown) {
    const world = parseWorldInfoFile(json);
    if (!world.entries.length) throw new Error('这本世界书没有任何条目');
    const location = await this.directory(projectId), { directory } = location;
    const file = path.join(directory, this.safeName(name || world.name || '世界书'));
    await this.unchanged(projectId, location);
    await fs.writeFile(file, JSON.stringify(json, null, 2), { flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名世界书已存在，请换个名字或先删除');
      throw error;
    });
    await this.unchanged(projectId, location);
    return { name: path.basename(file, '.json'), entries: world.entries.length };
  }
  async read(projectId: string, name: string): Promise<StWorldInfo> {
    return (await this.readSnapshot(projectId, name)).value;
  }
  async readSnapshot(projectId: string, name: string) {
    const location = await this.directory(projectId), { directory } = location;
    const bytes = await this.readRegular(path.join(directory, this.safeName(name)));
    await this.unchanged(projectId, location);
    const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return { value: parseWorldInfoFile(raw), container: Array.isArray(raw.entries) ? 'array' as const : 'object' as const, hash: createHash('sha256').update(bytes).digest('hex') };
  }
  private async trashDirectory(projectId: string) {
    const location = await this.directory(projectId);
    const directory = path.join(path.dirname(location.directory), '世界设定卡回收站');
    await fs.mkdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const identity = await this.checkedDirectory(directory);
    await this.unchanged(projectId, location);
    return { location, directory, identity };
  }
  private async checkTrash(projectId: string, trash: Awaited<ReturnType<WorldInfoStore['trashDirectory']>>) {
    await this.unchanged(projectId, trash.location);
    if (JSON.stringify(await this.checkedDirectory(trash.directory)) !== JSON.stringify(trash.identity)) throw new Error('设定卡回收站目录已变化');
  }
  private async readTrash(projectId: string, trash: Awaited<ReturnType<WorldInfoStore['trashDirectory']>>, id: string) {
    z.uuid().parse(id);
    const file = path.join(trash.directory, `${id}.json`);
    const stat = await fs.lstat(file);
    if (stat.size > 4 * 1024 * 1024) throw new Error('设定卡备份超过 4 MiB，无法安全读取');
    const bytes = await this.readRegular(file);
    if (bytes.length > 4 * 1024 * 1024) throw new Error('设定卡备份超过 4 MiB，无法安全读取');
    const record = worldTrashSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (record.projectId !== projectId || record.id !== id) throw new Error('设定卡备份归属不匹配');
    await this.checkTrash(projectId, trash);
    return { file, bytes, record };
  }
  /** Publish with a verified full-book backup. Extra guard binds a card backup to this change. */
  private async publishCardChange(projectId: string, location: Awaited<ReturnType<WorldInfoStore['directory']>>, file: string, original: Buffer, next: Buffer, checkExtra: () => Promise<void>) {
    const backupDirectory = path.join(path.dirname(location.directory), '世界书修改备份');
    await fs.mkdir(backupDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const backupIdentity = await this.checkedDirectory(backupDirectory);
    await this.unchanged(projectId, location);
    const backup = path.join(backupDirectory, `${randomUUID()}.json`);
    await fs.writeFile(backup, original, { flag: 'wx' });
    const temp = path.join(location.directory, `.${randomUUID()}.tmp`);
    const checkBackup = async () => {
      if (JSON.stringify(await this.checkedDirectory(backupDirectory)) !== JSON.stringify(backupIdentity) || !(await this.readRegular(backup)).equals(original)) throw new Error('世界书备份已变化，原文件保留');
    };
    try {
      await fs.writeFile(temp, next, { flag: 'wx' });
      await this.unchanged(projectId, location); await checkBackup(); await checkExtra();
      if (!(await this.readRegular(file)).equals(original)) throw new Error('世界书已在操作期间变化，请刷新后重试');
      await checkBackup(); await checkExtra(); await this.unchanged(projectId, location);
      if (!(await this.readRegular(file)).equals(original)) throw new Error('世界书已在操作期间变化，请刷新后重试');
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    return { hash: createHash('sha256').update(next).digest('hex'), backup: path.basename(backup) };
  }
  async listEntryTrash(projectId: string) {
    const trash = await this.trashDirectory(projectId);
    const files = (await fs.readdir(trash.directory)).filter(name => /^[0-9a-f-]{36}\.json$/iu.test(name));
    if (files.length > 10000) throw new Error('设定卡回收站超过 10000 条，请先手动备份并整理');
    const items: { id: string; book: string; entryId: string; name: string; removedAt: string; container: 'object' | 'array'; hash: string }[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const { record, bytes } = await this.readTrash(projectId, trash, file.slice(0, -5));
        const keywords = record.entry.key ?? record.entry.keys;
        const firstKey = Array.isArray(keywords) ? keywords.find(value => typeof value === 'string' && value.trim()) : undefined;
        const name = typeof record.entry.comment === 'string' && record.entry.comment.trim() ? record.entry.comment : typeof record.entry.name === 'string' && record.entry.name.trim() ? record.entry.name : typeof firstKey === 'string' ? firstKey : record.entryId;
        items.push({ id: record.id, book: record.book, entryId: record.entryId, name, removedAt: record.removedAt, container: record.schemaVersion === 2 ? 'array' : 'object', hash: createHash('sha256').update(bytes).digest('hex') });
      } catch { errors.push(file); }
    }
    await this.checkTrash(projectId, trash);
    return { items: items.sort((a, b) => b.removedAt.localeCompare(a.removedAt)), errors };
  }
  async previewEntryTrash(input: { projectId: string; trashId: string; expectedHash: string }) {
    const request = z.object({ projectId: z.uuid(), trashId: z.uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(input);
    const trash = await this.trashDirectory(request.projectId), saved = await this.readTrash(request.projectId, trash, request.trashId);
    if (createHash('sha256').update(saved.bytes).digest('hex') !== request.expectedHash) throw new Error('设定卡备份已变化，请刷新回收站后查看');
    const entry = saved.record.entry;
    const keys = entry.key ?? entry.keys;
    return {
      id: saved.record.id, book: saved.record.book, entryId: saved.record.entryId,
      comment: typeof entry.comment === 'string' ? entry.comment : typeof entry.name === 'string' ? entry.name : '',
      content: typeof entry.content === 'string' ? entry.content : '',
      keys: Array.isArray(keys) ? keys.filter((value): value is string => typeof value === 'string') : typeof keys === 'string' ? [keys] : []
    };
  }
  purgeEntryTrash(input: { projectId: string; trashId: string; expectedHash: string }) {
    const request = z.object({ projectId: z.uuid(), trashId: z.uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(input);
    const task = this.editQueue.then(async () => {
      const trash = await this.trashDirectory(request.projectId);
      const saved = await this.readTrash(request.projectId, trash, request.trashId);
      if (createHash('sha256').update(saved.bytes).digest('hex') !== request.expectedHash) throw new Error('设定卡备份已变化，请刷新回收站后重试');
      await this.checkTrash(request.projectId, trash);
      if (!(await this.readRegular(saved.file)).equals(saved.bytes)) throw new Error('设定卡备份在清理前变化，原文件已保留');
      await this.checkTrash(request.projectId, trash);
      await fs.unlink(saved.file);
    });
    this.editQueue = task.catch(() => {});
    return task;
  }
  deleteEntry(input: { projectId: string; book: string; entryId: string; expectedHash: string }) {
    const request = z.object({ projectId: z.uuid(), book: z.string().min(1).max(60), entryId: z.string().min(1).max(500), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(input);
    const task = this.editQueue.then(async () => {
      const trash = await this.trashDirectory(request.projectId), { location } = trash;
      const file = path.join(location.directory, this.safeName(request.book));
      const original = await this.readRegular(file);
      if (createHash('sha256').update(original).digest('hex') !== request.expectedHash) throw new Error('世界书已在外部变化，请刷新后重试');
      const json = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
      parseWorldInfoFile(json);
      if (!json.entries || typeof json.entries !== 'object') throw new Error('世界书条目格式不支持删除');
      const entries = json.entries as Record<string, unknown> | unknown[];
      if (Array.isArray(entries) && (!/^(0|[1-9]\d*)$/u.test(request.entryId) || Number(request.entryId) >= entries.length)) throw new Error('设定卡编号无效，请刷新后重试');
      if (!Object.prototype.hasOwnProperty.call(entries, request.entryId)) throw new Error('设定卡已不存在，请刷新后重试');
      const rawEntry = (entries as Record<string, unknown>)[request.entryId];
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) throw new Error('设定卡格式不支持删除');
      const after = Array.isArray(entries) ? entries.filter((_, index) => index !== Number(request.entryId)) : undefined;
      const common = { id: randomUUID(), projectId: request.projectId, book: request.book, entryId: request.entryId, removedAt: new Date().toISOString(), sourceHash: request.expectedHash, entry: rawEntry };
      const record = worldTrashSchema.parse(after ? { schemaVersion: 2, ...common, container: 'array', afterEntriesHash: entriesHash(after) } : { schemaVersion: 1, ...common });
      const bytes = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
      if (bytes.length > 4 * 1024 * 1024) throw new Error('设定卡超过 4 MiB，暂不能放入回收站');
      await this.checkTrash(request.projectId, trash);
      const recordFile = path.join(trash.directory, `${record.id}.json`);
      await fs.writeFile(recordFile, bytes, { flag: 'wx' });
      if (Array.isArray(entries)) entries.splice(Number(request.entryId), 1);
      else delete entries[request.entryId];
      const next = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
      const checkRecord = async () => { await this.checkTrash(request.projectId, trash); if (!(await this.readRegular(recordFile)).equals(bytes)) throw new Error('设定卡备份已变化，原文件保留'); };
      const result = await this.publishCardChange(request.projectId, location, file, original, next, checkRecord);
      return { ...result, trashId: record.id };
    });
    this.editQueue = task.catch(() => {});
    return task;
  }
  restoreEntry(input: { projectId: string; trashId: string; expectedHash: string; mode?: 'original' | 'append' }) {
    const request = z.object({ projectId: z.uuid(), trashId: z.uuid(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), mode: z.enum(['original', 'append']).default('original') }).strict().parse(input);
    const task = this.editQueue.then(async () => {
      const trash = await this.trashDirectory(request.projectId), { location } = trash;
      const saved = await this.readTrash(request.projectId, trash, request.trashId);
      const file = path.join(location.directory, this.safeName(saved.record.book));
      const original = await this.readRegular(file);
      if (createHash('sha256').update(original).digest('hex') !== request.expectedHash) throw new Error('世界书已在外部变化，请刷新后重试');
      const json = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
      parseWorldInfoFile(json);
      if (!json.entries || typeof json.entries !== 'object') throw new Error('世界书条目格式不支持恢复');
      const entries = json.entries;
      if (saved.record.schemaVersion === 2) {
        if (!Array.isArray(entries)) throw new Error('世界书条目格式已变化，无法安全恢复数组条目');
        if (request.mode === 'append') {
          const originalEntry = saved.record.entry;
          for (const field of ['uid', 'id']) {
            const value = originalEntry[field];
            if (value === undefined || value === null) continue;
            if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new Error('备份条目标识格式不支持追加恢复，请手动核对');
            if (entries.some(item => item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>)[field] !== undefined && String((item as Record<string, unknown>)[field]) === String(value))) throw new Error(`世界书已有相同 ${field} 标识的条目，未追加；请手动核对`);
          }
          if (entries.some(item => isDeepStrictEqual(item, originalEntry))) throw new Error('世界书已有相同内容的条目，未追加；请手动核对');
          entries.push(originalEntry);
        } else {
          if (entriesHash(entries) !== saved.record.afterEntriesHash) throw new Error('数组条目在删除后发生变化，无法安全恢复；备份仍保留');
          const index = Number(saved.record.entryId);
          if (!/^(0|[1-9]\d*)$/u.test(saved.record.entryId) || index > entries.length) throw new Error('备份条目位置无效，未修改世界书');
          entries.splice(index, 0, saved.record.entry);
        }
      } else {
        if (request.mode === 'append') throw new Error('只有数组格式世界书可追加恢复');
        if (Array.isArray(entries)) throw new Error('世界书条目格式已变化，无法安全恢复对象条目');
        if (Object.prototype.hasOwnProperty.call(entries, saved.record.entryId)) throw new Error('原位置已有同 ID 条目，未覆盖；请先核对世界书');
        Object.defineProperty(entries, saved.record.entryId, { value: saved.record.entry, enumerable: true, configurable: true, writable: true });
      }
      const next = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
      const checkRecord = async () => { await this.checkTrash(request.projectId, trash); if (!(await this.readRegular(saved.file)).equals(saved.bytes)) throw new Error('设定卡备份已变化，原文件保留'); };
      const result = await this.publishCardChange(request.projectId, location, file, original, next, checkRecord);
      return { ...result, book: saved.record.book };
    });
    this.editQueue = task.catch(() => {});
    return task;
  }
  mergeEntryTrash(input: { projectId: string; trashId: string; expectedTrashHash: string; targetEntryId: string; expectedBookHash: string; fields: { comment: 'current' | 'backup'; content: 'current' | 'backup'; keys: 'current' | 'backup' } }) {
    const choice = z.enum(['current', 'backup']);
    const request = z.object({ projectId: z.uuid(), trashId: z.uuid(), expectedTrashHash: z.string().regex(/^[a-f0-9]{64}$/u), targetEntryId: z.string().min(1).max(500), expectedBookHash: z.string().regex(/^[a-f0-9]{64}$/u), fields: z.object({ comment: choice, content: choice, keys: choice }).strict().refine(value => Object.values(value).includes('backup'), '请至少选择一个备份字段') }).strict().parse(input);
    const task = this.editQueue.then(async () => {
      const trash = await this.trashDirectory(request.projectId), { location } = trash;
      const saved = await this.readTrash(request.projectId, trash, request.trashId);
      if (createHash('sha256').update(saved.bytes).digest('hex') !== request.expectedTrashHash) throw new Error('设定卡备份已变化，请重新查看');
      const file = path.join(location.directory, this.safeName(saved.record.book)), original = await this.readRegular(file);
      if (createHash('sha256').update(original).digest('hex') !== request.expectedBookHash) throw new Error('世界书已在外部变化，请刷新后重新比较');
      const json = JSON.parse(original.toString('utf8')) as Record<string, unknown>; parseWorldInfoFile(json);
      const entries = json.entries;
      if (!entries || typeof entries !== 'object' || !Object.prototype.hasOwnProperty.call(entries, request.targetEntryId)) throw new Error('目标设定卡已不存在，请刷新后重试');
      const value = (entries as Record<string, unknown>)[request.targetEntryId];
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('目标设定卡格式不支持合并');
      const target = value as Record<string, unknown>, source = saved.record.entry;
      if (request.fields.comment === 'backup') {
        const comment = source.comment ?? source.name ?? '';
        if (typeof comment !== 'string') throw new Error('备份名称格式不支持合并，原资料已保留');
        target.comment = comment;
      }
      if (request.fields.content === 'backup') {
        const content = source.content ?? '';
        if (typeof content !== 'string') throw new Error('备份正文格式不支持合并，原资料已保留');
        target.content = content;
      }
      if (request.fields.keys === 'backup') {
        const raw = source.key ?? source.keys ?? [];
        const keys = typeof raw === 'string' ? [raw] : raw;
        if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) throw new Error('备份关键词格式不支持合并，原资料已保留');
        if ('key' in target || !('keys' in target)) target.key = keys;
        if ('keys' in target) target.keys = keys;
      }
      const next = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
      const checkRecord = async () => { await this.checkTrash(request.projectId, trash); if (!(await this.readRegular(saved.file)).equals(saved.bytes)) throw new Error('设定卡备份已变化，原文件保留'); };
      const result = await this.publishCardChange(request.projectId, location, file, original, next, checkRecord);
      return { ...result, book: saved.record.book };
    });
    this.editQueue = task.catch(() => {}); return task;
  }
  /** Edit only the requested display fields in the original JSON; keep every other field intact. */
  saveEntry(input: { projectId: string; book: string; entryId: string; expectedHash: string; comment: string; content: string; keys: string[] }) {
    const request = z.object({ projectId: z.uuid(), book: z.string().min(1).max(60), entryId: z.string().min(1).max(500), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), comment: z.string().trim().min(1).max(200), content: z.string().max(100000), keys: z.array(z.string().trim().min(1).max(200)).max(100) }).strict().parse(input);
    const task = this.editQueue.then(async () => {
      const location = await this.directory(request.projectId), { directory } = location;
      const file = path.join(directory, this.safeName(request.book));
      const original = await this.readRegular(file);
      if (createHash('sha256').update(original).digest('hex') !== request.expectedHash) throw new Error('世界书已在外部变化，未保存修改；请复制草稿并重新读取');
      const json = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
      parseWorldInfoFile(json);
      const entries = json.entries;
      if (!entries || typeof entries !== 'object' || !Object.prototype.hasOwnProperty.call(entries, request.entryId)) throw new Error('世界书条目不存在，请重新读取');
      const entry = (entries as Record<string, unknown>)[request.entryId];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('世界书条目格式不支持编辑，原文件保留');
      const record = entry as Record<string, unknown>;
      record.comment = request.comment; record.content = request.content;
      if ('key' in record || !('keys' in record)) record.key = request.keys;
      if ('keys' in record) record.keys = request.keys;
      const next = Buffer.from(JSON.stringify(json, null, 2), 'utf8');
      const backupDirectory = path.join(path.dirname(directory), '世界书修改备份');
      await fs.mkdir(backupDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const backupIdentity = await this.checkedDirectory(backupDirectory);
      await this.unchanged(request.projectId, location);
      const backup = path.join(backupDirectory, `${randomUUID()}.json`);
      await fs.writeFile(backup, original, { flag: 'wx' });
      const temp = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, next, { flag: 'wx' });
        await this.unchanged(request.projectId, location);
        if (JSON.stringify(await this.checkedDirectory(backupDirectory)) !== JSON.stringify(backupIdentity) || !(await this.readRegular(backup)).equals(original)) throw new Error('世界书备份已变化，原文件保留');
        if (!(await this.readRegular(file)).equals(original)) throw new Error('世界书已在保存期间变化，未覆盖外部修改');
        if (JSON.stringify(await this.checkedDirectory(backupDirectory)) !== JSON.stringify(backupIdentity) || !(await this.readRegular(backup)).equals(original)) throw new Error('世界书备份已变化，原文件保留');
        await this.unchanged(request.projectId, location);
        if (!(await this.readRegular(file)).equals(original)) throw new Error('世界书已在保存期间变化，未覆盖外部修改');
        await fs.rename(temp, file);
      } finally { await fs.unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
      return { hash: createHash('sha256').update(next).digest('hex'), backup: path.basename(backup) };
    });
    this.editQueue = task.catch(() => {});
    return task;
  }
  /** Text block injected into AI context: only entries triggered by the current chapter text. */
  async context(projectId: string, text: string, characterNames?: string[], options: { books?: string[]; maxCharacters?: number; extraWorlds?: StWorldInfo[]; characters?: WorldCharacterContext[] } = {}) {
    const listed = options.books?.length ? null : await this.list(projectId);
    if (listed?.some(book => book.error)) throw new Error('世界书文件损坏或无法安全读取，请先核对后再生成');
    const names = options.books?.length ? options.books : listed!.map(book => book.name);
    const hits = (await this.preview(projectId, names, text, characterNames, undefined, true, options.characters)) as (StWorldEntry & { book: string })[];
    for (const extra of options.extraWorlds ?? []) for (const entry of selectWorldEntries(extra, text, { characterNames, characters: options.characters, omitUnknownTagEntries: true, limit: 20 })) hits.push({ ...entry, book: extra.name || '角色卡世界书' });
    hits.sort((left, right) => right.order - left.order);
    if (!hits.length) return { text: '', entries: 0, books: [] as string[] };
    const max = Math.max(500, options.maxCharacters ?? 2000);
    const header = '世界书触发条目（按正文关键词或常驻规则命中，仅作设定参考）：';
    const warning = (count: number) => `注意：${count} 条已命中设定因预算不足未提供，不应推断其内容。`;
    const lines: string[] = []; let used = header.length + warning(hits.length).length + 2; let omitted = 0;
    const usedBooks = new Set<string>();
    for (const hit of hits) {
      const block = `- ${hit.content}`;
      if (used + block.length + 1 > max) { omitted++; continue; }
      used += block.length + 1; lines.push(block); usedBooks.add(hit.book);
    }
    return { text: [header, ...(omitted ? [warning(omitted)] : []), ...lines].join('\n'), entries: lines.length, books: [...usedBooks] };
  }
  remove(projectId: string, name: string, expectedHash: string) {
    const task = this.editQueue.then(async () => {
    const location = await this.directory(projectId), { directory } = location;
    const file = path.join(directory, this.safeName(name));
    let before: Buffer;
    try { before = await this.readRegular(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash) || createHash('sha256').update(before).digest('hex') !== expectedHash) throw new Error('世界书版本已变化，请刷新列表后重新核对');
    await this.unchanged(projectId, location);
    const backupDirectory = path.join(path.dirname(directory), '世界书删除备份');
    await fs.mkdir(backupDirectory).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const backupIdentity = await this.checkedDirectory(backupDirectory);
    await this.unchanged(projectId, location);
    const backup = path.join(backupDirectory, `${randomUUID()}.json`);
    await fs.writeFile(backup, before, { flag: 'wx' });
    if (!(await this.readRegular(backup)).equals(before)) throw new Error('世界书备份已变化，原文件保留');
    if (JSON.stringify(await this.checkedDirectory(backupDirectory)) !== JSON.stringify(backupIdentity)) throw new Error('世界书备份目录已变化，原文件保留');
    await this.unchanged(projectId, location);
    if (!(await this.readRegular(file)).equals(before)) throw new Error('世界书删除前已变化，请重新核对');
    // Reading the source may overlap an external edit of the backup. Recheck the
    // retained copy and its directory after that read before removing the source.
    if (JSON.stringify(await this.checkedDirectory(backupDirectory)) !== JSON.stringify(backupIdentity)
      || !(await this.readRegular(backup)).equals(before)) throw new Error('世界书备份已变化，原文件保留');
    await this.unchanged(projectId, location);
    await fs.rm(file, { force: true });
    return true;
    });
    this.editQueue = task.catch(() => {});
    return task;
  }
  /** Which entries would be injected for this text, across the selected books. */
  async preview(projectId: string, names: string[], text: string, characterNames?: string[], characterTagIds?: string[], omitUnknownTagEntries = false, characters?: WorldCharacterContext[]) {
    const hits: (StWorldEntry & { book: string })[] = [];
    for (const name of names) {
      const world = await this.read(projectId, name);
      for (const entry of selectWorldEntries(world, text, { characterNames, characterTagIds, characters, omitUnknownTagEntries, limit: 20 })) hits.push({ ...entry, book: name });
    }
    return hits.sort((left, right) => right.order - left.order).slice(0, 20);
  }
}
