import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readCharx } from '../core/charx';
import { z } from 'zod';
import type { CharacterCard, CharacterEdit, CharacterPreview, CharacterSnapshot, Project } from '../shared/contracts';
import { emptyCharacter } from '../core/characters';
import { parseCardJson, pngCardJson } from './card-parser';
import { charactersMarkdown, parseCharactersMarkdown, materialDirectory, readMarkdown, writeMarkdown } from './markdown-materials';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(100000), personality: z.string().max(100000), scenario: z.string().max(100000),
  firstMessage: z.string().max(100000), examples: z.string().max(100000), creatorNotes: z.string().max(100000), systemPrompt: z.string().max(100000),
  postHistoryInstructions: z.string().max(100000), alternateGreetings: z.array(z.string().max(100000)).max(100)
});
const cardSchema = fieldsSchema.extend({
  id: z.uuid(), projectId: z.uuid(), enabled: z.boolean(), portrait: z.string().regex(/^(?:[a-f0-9]{64}\.png)?$/),
  source: z.object({ name: z.string().max(300), format: z.string().max(40), original: z.string().regex(/^(?:[a-f0-9]{64}\.(?:png|jpg|jpeg|webp|json|txt|docx|charx))?$/) }),
  raw: z.record(z.string(), z.unknown()).nullable(), warnings: z.array(z.string().max(2000)).max(100)
});
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), cards: z.array(cardSchema).max(200) });
const editSchema = z.object({ id: z.uuid().optional(), fields: fieldsSchema, enabled: z.boolean(), importToken: z.uuid().optional(), portraitToken: z.uuid().optional(), removePortrait: z.boolean().optional() });
type ParsedCard = Omit<ReturnType<typeof parseCardJson>, 'raw'> & { raw: Record<string, unknown> | null };
interface Pending {
  projectId: string; created: number; kind: 'import' | 'portrait';
  bytes: Buffer; extension: string; avatar: Buffer | null;
  parsed: ParsedCard; name: string;
}

export class CharacterStore {
  private pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly project: (id: string) => Project, private readonly materialsRoot?: string) {}
  private async directory(id: string, child = '') {
    const root = await fs.realpath(this.project(id).root);
    const meta = this.materialsRoot ? await materialDirectory(this.materialsRoot, id) : path.join(root, '小说资料');
    await fs.mkdir(meta, { recursive: true });
    if (!this.materialsRoot && !inside(root, await fs.realpath(meta))) throw new Error('角色资料目录越界');
    const directory = path.join(meta, child);
    await fs.mkdir(directory, { recursive: true });
    if (!inside(meta, await fs.realpath(directory))) throw new Error('角色资源目录越界');
    return directory;
  }
  private async bytes(id: string, child: string, filename: string, limit = 32 * 1024 * 1024) {
    const directory = await this.directory(id, child); const file = path.join(directory, filename);
    if (!inside(directory, await fs.realpath(file))) throw new Error('角色文件链接越界');
    if ((await fs.stat(file)).size > limit) throw new Error('角色资料超过大小限制');
    return fs.readFile(file);
  }
  async read(id: string): Promise<CharacterSnapshot> {
    let value: CharacterSnapshot['value']; let revision = '';
    if (this.materialsRoot) {
      const file = path.join(await this.directory(id), '人物卡.md');
      let raw = await readMarkdown(file);
      if (raw === null) {
        // Migration reads the old store through its original path guards. Never delete it.
        const legacy = new CharacterStore(this.project); const old = await legacy.read(id);
        if (old.hash) {
          for (const card of old.value.cards) {
            for (const [directory, name] of [['character-originals', card.source.original], ['character-assets', card.portrait]]) {
              if (name) { const bytes = await legacy.bytes(id, directory, name); await this.asset(id, directory, bytes, path.extname(name).slice(1)); }
            }
          }
        }
        const initial = charactersMarkdown(old.value);
        await fs.writeFile(file, initial, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        raw = (await readMarkdown(file))!;
      }
      value = schema.parse(parseCharactersMarkdown(raw, id)); revision = hash(raw);
    } else {
      try { const bytes = await this.bytes(id, '', 'characters.json'); value = schema.parse(JSON.parse(bytes.toString('utf8'))); revision = hash(bytes); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; value = { schemaVersion: 1, projectId: id, cards: [] }; }
    }
    if (value.projectId !== id || value.cards.some(card => card.projectId !== id)) throw new Error('角色资料属于另一部小说');
    if (new Set(value.cards.map(card => card.id)).size !== value.cards.length) throw new Error('角色 ID 重复');
    const portraits: Record<string, string> = {};
    for (const asset of new Set(value.cards.map(card => card.portrait).filter(Boolean))) {
      try { portraits[asset] = `data:image/png;base64,${(await this.bytes(id, 'character-assets', asset, 8 * 1024 * 1024)).toString('base64')}`; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return { value, hash: revision, portraits };
  }
  private stage(item: Pending) {
    this.project(item.projectId);
    for (const [token, pending] of this.pending) if (Date.now() - pending.created > 30 * 60 * 1000) this.pending.delete(token);
    if (this.pending.size >= 8) throw new Error('待确认导入过多，请关闭其他预览后重试');
    const token = randomUUID(); this.pending.set(token, item); return token;
  }
  prepare(id: string, name: string, bytes: Buffer, avatar: Buffer | null, extractedText?: string): CharacterPreview {
    if (bytes.length > 12 * 1024 * 1024) throw new Error('角色文件不能超过 12 MB');
    const extension = path.extname(name).slice(1).toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'webp', 'json', 'txt', 'docx', 'charx'].includes(extension)) throw new Error('不支持此角色文件格式');
    let parsed: ParsedCard;
    const json = extension === 'png' ? pngCardJson(bytes) : extension === 'json' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null;
    if (json !== null) parsed = parseCardJson(json);
    else {
      const fields = emptyCharacter(); fields.name = path.basename(name, path.extname(name));
      const text = extension === 'txt' || extension === 'docx' ? extractedText ?? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '';
      if (text.length > 100000) throw new Error('文字角色描述不能超过 10 万字符');
      if ((extension === 'txt' || extension === 'docx') && !text.trim()) throw new Error('文字角色卡内容为空');
      fields.description = text;
      parsed = { fields, raw: null, format: text ? '文字' : '头像', loreEntries: 0,
        warnings: text ? ['原文作为角色描述导入，可在确认前整理字段。'] : ['图片没有内嵌角色数据，仅用作头像；请补充角色设定。此处不进行 OCR。'] };
    }
    const token = this.stage({ projectId: id, created: Date.now(), kind: 'import', bytes, avatar, extension, parsed, name });
    return { projectId: id, token, fields: parsed.fields, image: avatar ? `data:image/png;base64,${avatar.toString('base64')}` : '', sourceName: name, format: parsed.format, warnings: parsed.warnings, loreEntries: parsed.loreEntries };
  }
  /** CHARX bundles are ZIP archives, so this one has to be async; the card fields are staged like any
   * other import and the archive itself is kept as the original file. */
  async prepareCharx(id: string, name: string, bytes: Buffer, avatar: Buffer | null): Promise<CharacterPreview> {
    if (bytes.length > 32 * 1024 * 1024) throw new Error('CHARX 包不能超过 32 MB');
    const result = await readCharx(new Uint8Array(bytes));
    const book = result.card.characterBook;
    const fields = { ...emptyCharacter(), ...result.card.data, examples: result.card.data.exampleDialogue };
    const warnings = result.assets.length ? [`包内另有 ${result.assets.length} 个资源（表情/背景），本应用暂不导入，只保留原包。`] : [];
    const parsed: ParsedCard = { fields, raw: result.cardJson as Record<string, unknown>, format: 'CHARX', loreEntries: book?.entries.length ?? 0, warnings };
    const token = this.stage({ projectId: id, created: Date.now(), kind: 'import', bytes, avatar: result.icon ? Buffer.from(result.icon) : avatar, extension: 'charx', parsed, name });
    return { projectId: id, token, fields, image: result.icon ? `data:image/png;base64,${Buffer.from(result.icon).toString('base64')}` : '', sourceName: name, format: 'CHARX', warnings, loreEntries: parsed.loreEntries };
  }
  preparePortrait(id: string, avatar: Buffer) {
    const token = this.stage({ projectId: id, created: Date.now(), kind: 'portrait', bytes: Buffer.alloc(0), avatar, extension: 'png', name: '', parsed: { fields: emptyCharacter(), raw: {}, format: '', warnings: [], loreEntries: 0 } });
    return { token, image: `data:image/png;base64,${avatar.toString('base64')}` };
  }
  release(id: string, token: string) { if (this.pending.get(token)?.projectId === id) this.pending.delete(token); }
  private pendingItem(id: string, token: string, kind: Pending['kind']) {
    const item = this.pending.get(token);
    if (!item || item.projectId !== id || item.kind !== kind || Date.now() - item.created > 30 * 60 * 1000) throw new Error('导入预览已过期或属于另一部小说，请重新导入');
    return item;
  }
  private async asset(id: string, directory: string, bytes: Buffer, extension: string) {
    const filename = `${hash(bytes)}.${extension}`;
    const file = path.join(await this.directory(id, directory), filename);
    try { await fs.writeFile(file, bytes, { flag: 'wx' }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (hash(await this.bytes(id, directory, filename)) !== hash(bytes)) throw new Error('已有角色资源内容与哈希不符'); }
    return filename;
  }
  /** Publishes a whole card list (delete/merge) with the same hash guard and history copy as save. */
  replaceAll(id: string, cards: CharacterCard[], expectedHash: string): Promise<CharacterSnapshot> {
    const task = this.queue.then(async () => {
      const snapshot = await this.read(id);
      if (snapshot.hash !== expectedHash) throw new Error('角色库已在外部更新，请关闭编辑并重新载入，当前修改未覆盖原文件');
      if (new Set(cards.map(card => card.id)).size !== cards.length) throw new Error('角色 ID 重复');
      if (cards.some(card => card.projectId !== id)) throw new Error('角色资料属于另一部小说');
      const next = schema.parse({ schemaVersion: 1, projectId: id, cards });
      if (this.materialsRoot) {
        await writeMarkdown(path.join(await this.directory(id), '人物卡.md'), charactersMarkdown(next), expectedHash);
        return this.read(id);
      }
      const directory = await this.directory(id); const file = path.join(directory, 'characters.json'); const temp = path.join(directory, `${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx' });
        let previous: Buffer | null = null;
        try { previous = await this.bytes(id, '', 'characters.json'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if ((previous ? hash(previous) : '') !== expectedHash) throw new Error('角色库已在外部更新，保存已取消');
        if (previous) await this.asset(id, 'character-history', previous, 'json');
        await fs.rename(temp, file);
      } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      return this.read(id);
    });
    this.queue = task.catch(() => {}); return task;
  }
  /** Materials directory of this book, used by export/backup helpers. */
  async materials(id: string) { return this.directory(id); }
  /** Copies one stored asset (portrait/original) without leaving the project directory. */
  async readAsset(id: string, kind: 'character-assets' | 'character-originals' | 'character-history', name: string) { return this.bytes(id, kind, name); }
  async writeMaterial(id: string, child: string, name: string, bytes: Buffer) {
    // 同一类路径越界加固：文件名不允许带分隔符/上级目录，写入目标必须落在本书资料目录内。
    if (!name || /[\\/]/u.test(name) || name === '.' || name === '..') throw new Error('资料文件名不合法');
    const directory = await this.directory(id, child);
    const target = path.join(directory, name);
    if (!inside(directory, target)) throw new Error('资料写入路径越界');
    await fs.writeFile(target, bytes, { flag: 'wx' });
    return path.join(child, name);
  }
  save(id: string, input: CharacterEdit, expectedHash: string): Promise<CharacterSnapshot> {
    const task = this.queue.then(async () => {
      const edit = editSchema.parse(input); const snapshot = await this.read(id);
      if (snapshot.hash !== expectedHash) throw new Error('角色库已在外部更新，请关闭编辑并重新载入，当前修改未覆盖原文件');
      if (edit.id && edit.importToken) throw new Error('导入卡片只能新建角色');
      const old = edit.id ? snapshot.value.cards.find(card => card.id === edit.id) : undefined;
      if (edit.id && !old) throw new Error('角色不存在于当前小说');
      const imported = edit.importToken ? this.pendingItem(id, edit.importToken, 'import') : undefined;
      const portrait = edit.portraitToken ? this.pendingItem(id, edit.portraitToken, 'portrait') : undefined;
      const card: CharacterCard = old ? { ...old, ...edit.fields, enabled: edit.enabled } : {
        ...edit.fields, id: randomUUID(), projectId: id, enabled: edit.enabled, portrait: '',
        source: { name: imported?.name ?? '手工填写', format: imported?.parsed.format ?? '文字', original: '' },
        raw: imported?.parsed.raw ?? null, warnings: imported?.parsed.warnings ?? []
      };
      if (imported) card.source.original = await this.asset(id, 'character-originals', imported.bytes, imported.extension);
      const avatar = portrait?.avatar ?? imported?.avatar;
      if (avatar) card.portrait = await this.asset(id, 'character-assets', avatar, 'png');
      if (edit.removePortrait) card.portrait = '';
      snapshot.value.cards = old ? snapshot.value.cards.map(item => item.id === old.id ? card : item) : [...snapshot.value.cards, card];
      const raw = JSON.stringify(schema.parse(snapshot.value), null, 2);
      if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('角色库过大，请减少单卡内容');
      if (this.materialsRoot) {
        await writeMarkdown(path.join(await this.directory(id), '人物卡.md'), charactersMarkdown(snapshot.value), expectedHash);
        if (edit.importToken) this.release(id, edit.importToken);
        if (edit.portraitToken) this.release(id, edit.portraitToken);
        return this.read(id);
      }
      const directory = await this.directory(id); const file = path.join(directory, 'characters.json'); const temp = path.join(directory, `${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temp, raw, { flag: 'wx' });
        // 写完临时文件再次比较，并保留旧版，方便外部同步和误操作恢复。
        let previous: Buffer | null = null;
        try { previous = await this.bytes(id, '', 'characters.json'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if ((previous ? hash(previous) : '') !== expectedHash) throw new Error('角色库已在外部更新，保存已取消');
        if (previous) await this.asset(id, 'character-history', previous, 'json');
        await fs.rename(temp, file);
      } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      if (edit.importToken) this.release(id, edit.importToken);
      if (edit.portraitToken) this.release(id, edit.portraitToken);
      return this.read(id);
    });
    this.queue = task.catch(() => {}); return task;
  }
}
