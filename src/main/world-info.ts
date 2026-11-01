import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseWorldInfoFile, selectWorldEntries, type StWorldEntry, type StWorldInfo, type WorldCharacterContext } from '../core/st-cards';
import type { Workspace } from './workspace';

/** World info books stored as plain SillyTavern JSON files inside the book, so they can be shared
 * both ways without conversion. */
export class WorldInfoStore {
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
    const location = await this.directory(projectId), { directory } = location;
    const bytes = await this.readRegular(path.join(directory, this.safeName(name)));
    await this.unchanged(projectId, location);
    return parseWorldInfoFile(JSON.parse(bytes.toString('utf8')));
  }
  /** Text block injected into AI context: only entries triggered by the current chapter text. */
  async context(projectId: string, text: string, characterNames?: string[], options: { books?: string[]; maxCharacters?: number; extraWorlds?: StWorldInfo[]; characters?: WorldCharacterContext[] } = {}) {
    const listed = options.books?.length ? null : await this.list(projectId);
    if (listed?.some(book => book.error)) throw new Error('世界书文件损坏或无法安全读取，请先核对后再生成');
    const names = options.books?.length ? options.books : listed!.map(book => book.name);
    if (!text.trim()) return { text: '', entries: 0, books: [] as string[] };
    const hits = (await this.preview(projectId, names, text, characterNames, undefined, true, options.characters)) as (StWorldEntry & { book: string })[];
    for (const extra of options.extraWorlds ?? []) for (const entry of selectWorldEntries(extra, text, { characterNames, characters: options.characters, omitUnknownTagEntries: true, limit: 20 })) hits.push({ ...entry, book: extra.name || '角色卡世界书' });
    hits.sort((left, right) => right.order - left.order);
    if (!hits.length) return { text: '', entries: 0, books: [] as string[] };
    const max = Math.max(500, options.maxCharacters ?? 2000);
    const lines: string[] = ['世界书触发条目（按正文关键词命中，仅作设定参考）：'];
    let used = 0; const usedBooks = new Set<string>();
    for (const hit of hits) {
      const block = `- ${hit.content}`;
      if (used + block.length > max) break;
      used += block.length; lines.push(block); usedBooks.add(hit.book);
    }
    return { text: lines.length > 1 ? lines.join('\n') : '', entries: lines.length - 1, books: [...usedBooks] };
  }
  async remove(projectId: string, name: string, expectedHash: string) {
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
