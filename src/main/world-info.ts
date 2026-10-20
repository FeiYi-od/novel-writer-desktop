import * as fs from 'node:fs/promises';
import path from 'node:path';
import { parseWorldInfoFile, selectWorldEntries, type StWorldEntry, type StWorldInfo } from '../core/st-cards';
import type { Workspace } from './workspace';

/** World info books stored as plain SillyTavern JSON files inside the book, so they can be shared
 * both ways without conversion. */
export class WorldInfoStore {
  constructor(private readonly workspace: Workspace) {}
  private async directory(projectId: string) {
    const project = this.workspace.getProject(projectId);
    const directory = path.join(project.root, '小说资料', '世界书');
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }
  private safeName(name: string) {
    const clean = name.replace(/[\\/:*?"<>|]/gu, '_').trim().slice(0, 60);
    if (!clean) throw new Error('世界书需要一个名字');
    return `${clean}.json`;
  }
  async list(projectId: string) {
    const directory = await this.directory(projectId);
    const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
    const books = [];
    for (const file of files) {
      try {
        const world = parseWorldInfoFile(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')));
        books.push({ name: path.basename(file, '.json'), entries: world.entries.length, keys: world.entries.reduce((sum, entry) => sum + entry.keys.length, 0) });
      } catch { books.push({ name: path.basename(file, '.json'), entries: 0, keys: 0, error: '文件损坏，已跳过' }); }
    }
    return books.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }
  async import(projectId: string, name: string, json: unknown) {
    const world = parseWorldInfoFile(json);
    if (!world.entries.length) throw new Error('这本世界书没有任何条目');
    const directory = await this.directory(projectId);
    const file = path.join(directory, this.safeName(name || world.name || '世界书'));
    await fs.writeFile(file, JSON.stringify(json, null, 2), { flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('同名世界书已存在，请换个名字或先删除');
      throw error;
    });
    return { name: path.basename(file, '.json'), entries: world.entries.length };
  }
  async read(projectId: string, name: string): Promise<StWorldInfo> {
    const directory = await this.directory(projectId);
    return parseWorldInfoFile(JSON.parse(await fs.readFile(path.join(directory, this.safeName(name)), 'utf8')));
  }
  /** Text block injected into AI context: only entries triggered by the current chapter text. */
  async context(projectId: string, text: string, characterNames?: string[], options: { books?: string[]; maxCharacters?: number; extraWorlds?: StWorldInfo[] } = {}) {
    const names = options.books?.length ? options.books : (await this.list(projectId)).filter(book => !book.error).map(book => book.name);
    if (!text.trim()) return { text: '', entries: 0, books: [] as string[] };
    const hits = (await this.preview(projectId, names, text, characterNames)) as (StWorldEntry & { book: string })[];
    for (const extra of options.extraWorlds ?? []) for (const entry of selectWorldEntries(extra, text, { characterNames, limit: 20 })) hits.push({ ...entry, book: extra.name || '角色卡世界书' });
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
  async remove(projectId: string, name: string) {
    const directory = await this.directory(projectId);
    await fs.rm(path.join(directory, this.safeName(name)), { force: true });
    return true;
  }
  /** Which entries would be injected for this text, across the selected books. */
  async preview(projectId: string, names: string[], text: string, characterNames?: string[]) {
    const hits: (StWorldEntry & { book: string })[] = [];
    for (const name of names) {
      const world = await this.read(projectId, name).catch(() => null);
      if (!world) continue;
      for (const entry of selectWorldEntries(world, text, { characterNames, limit: 20 })) hits.push({ ...entry, book: name });
    }
    return hits.sort((left, right) => right.order - left.order).slice(0, 20);
  }
}
