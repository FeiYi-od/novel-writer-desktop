import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BookDetails, BookSnapshot, Project } from '../shared/contracts';
import { analyzeText } from '../core/style-analysis';
import type { LearnedStyle } from '../shared/contracts';
import { sampleStyleText } from '../core/style-learning';
import mammoth from 'mammoth';
import { encodeDocx } from './docx';
import { textDocument } from './text-import';
import { materialDirectory, readMarkdown, writeMarkdown, stylesMarkdown, parseStylesMarkdown } from './markdown-materials';

const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const cover = z.string().regex(/^(?:[a-f0-9]{64}\.png)?$/);
const schema = z.object({
  schemaVersion: z.literal(1), projectId: z.uuid(), title: z.string().trim().min(1).max(200),
  introduction: z.string().max(20000), cover,
  volumes: z.array(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(200), introduction: z.string().max(20000), cover, chapters: z.array(z.string().max(1000)) })).max(1000),
  sources: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(300), characters: z.number().int().nonnegative(), format: z.enum(['docx', 'txt']).optional() })).max(500),
  styles: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(100), rules: z.string().min(1).max(20000), sourceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    createdAt: z.string(), method: z.enum(['local-statistics-v1', 'model-analysis-v1']), analysis: z.object({ taskId: z.uuid(), model: z.string(), sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)), sampled: z.boolean(), sampleCharacters: z.number().int().nonnegative(), totalCharacters: z.number().int().nonnegative() }).optional(), metrics: z.object({
      characters: z.number().nonnegative(), paragraphs: z.number().nonnegative(), meanSentenceLength: z.number().nonnegative(),
      meanParagraphLength: z.number().nonnegative(), dialogueRatio: z.number().min(0).max(100), firstPersonPerThousand: z.number().nonnegative()
    })
  })).max(100), activeStyleId: z.string()
});
const within = (root: string, target: string) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export class LibraryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly getProject: (id: string) => Project, private readonly materialsRoot?: string, private readonly resolveChapter?: (id: string, relative: string) => Promise<string>) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  private async directory(id: string, child = '') {
    const project = this.getProject(id);
    const directory = path.join(project.root, '小说资料', child);
    await fs.mkdir(directory, { recursive: true });
    if (!within(await fs.realpath(project.root), await fs.realpath(directory))) throw new Error('资料路径越界');
    return directory;
  }
  private async readFile(id: string, child: string, filename: string) {
    const directory = await this.directory(id, child);
    const file = path.join(directory, filename);
    if (!within(directory, await fs.realpath(file))) throw new Error('资料文件链接越界');
    return fs.readFile(file);
  }
  async read(id: string): Promise<BookSnapshot> {
    let value: BookDetails; let revision = '';
    try {
      const raw = await this.readFile(id, '', 'book.json'); revision = hash(raw);
      value = schema.parse(JSON.parse(raw.toString('utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      value = { schemaVersion: 1, projectId: id, title: this.getProject(id).name, introduction: '', cover: '', volumes: [], sources: [], styles: [], activeStyleId: '' };
    }
    if (value.projectId !== id) throw new Error('书架资料属于其他小说');
    if (this.materialsRoot) {
      const file = path.join(await materialDirectory(this.materialsRoot, id), '文风档案.md');
      let raw = await readMarkdown(file);
      if (raw === null) {
        await fs.writeFile(file, stylesMarkdown(id, value.styles), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        raw = (await readMarkdown(file))!;
      }
      value = schema.parse({ ...value, styles: parseStylesMarkdown(raw, id) });
      revision = hash(`${revision}:${hash(raw)}`);
    }
    if (this.resolveChapter) {
      const original = JSON.stringify(value.volumes);
      value.volumes = await Promise.all(value.volumes.map(async volume => ({ ...volume, chapters: await Promise.all(volume.chapters.map(p => this.resolveChapter!(id, p))) })));
      if (JSON.stringify(value.volumes) !== original) revision = hash(revision + ':paths:' + JSON.stringify(value.volumes));
    }
    const covers: Record<string, string> = {};
    for (const filename of new Set([value.cover, ...value.volumes.map(v => v.cover)].filter(Boolean))) {
      try { covers[filename] = `data:image/png;base64,${(await this.readFile(id, 'covers', filename)).toString('base64')}`; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return { value, hash: revision, covers };
  }
  private async write(id: string, input: BookDetails, expectedHash: string): Promise<BookSnapshot> {
    const value = schema.parse(input);
    if (this.resolveChapter) value.volumes = await Promise.all(value.volumes.map(async volume => ({ ...volume, chapters: await Promise.all(volume.chapters.map(p => this.resolveChapter!(id, p))) })));
    if (value.projectId !== id) throw new Error('不能把资料写入另一部小说');
    if ((await this.read(id)).hash !== expectedHash) throw new Error('书架或文风资料已更新，请重新打开后再修改');
    if (new Set(value.volumes.map(v => v.id)).size !== value.volumes.length || new Set(value.styles.map(v => v.id)).size !== value.styles.length) throw new Error('分集或文风 ID 重复');
    const assigned = value.volumes.flatMap(v => v.chapters);
    if (new Set(assigned).size !== assigned.length) throw new Error('同一章节只能属于一个分集');
    if (assigned.some(p => path.isAbsolute(p) || p.includes(':') || p.split(/[\\/]/).includes('..') || !/\.(docx|txt)$/i.test(p))) throw new Error('无效章节分集路径');
    if (value.activeStyleId && !value.styles.some(s => s.id === value.activeStyleId)) throw new Error('选择的文风不存在');
    if (value.styles.some(s => s.sourceIds.some(source => !value.sources.some(item => item.id === source)))) throw new Error('文风来源不属于当前小说');
    const directory = await this.directory(id);
    let previousBook: Buffer | null = null;
    try { previousBook = await this.readFile(id, '', 'book.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previousBook) {
      const backup = path.join(await this.directory(id, 'book-history'), `${hash(previousBook)}.json`);
      await fs.writeFile(backup, previousBook, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    if (this.materialsRoot) {
      const file = path.join(await materialDirectory(this.materialsRoot, id), '文风档案.md');
      const previous = (await readMarkdown(file))!;
      if ((await this.read(id)).hash !== expectedHash) throw new Error('书架或文风资料已更新');
      const next = stylesMarkdown(id, value.styles);
      if (next !== previous) await writeMarkdown(file, next, hash(previous));
    }
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
      let current: Buffer | null = null;
      try { current = await this.readFile(id, '', 'book.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if ((current ? hash(current) : '') !== (previousBook ? hash(previousBook) : '')) throw new Error('书架资料在保存期间被外部更新，已保留旧版备份');
      await fs.rename(temporary, path.join(directory, 'book.json'));
    }
    finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    return this.read(id);
  }
  save(id: string, value: BookDetails, expectedHash: string) { return this.serial(() => this.write(id, value, expectedHash)); }
  async addCover(id: string, png: Buffer) {
    if (png.length > 8 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('无效封面图片');
    const filename = `${hash(png)}.png`;
    const file = path.join(await this.directory(id, 'covers'), filename);
    await fs.writeFile(file, png, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    return filename;
  }
  addSources(id: string, texts: { name: string; text: string; original?: Buffer }[], expectedHash: string) {
    return this.serial(async () => {
      const current = await this.read(id);
      if (current.hash !== expectedHash) throw new Error('文风资料已更新，请重新打开');
      for (const { name, text, original } of texts) {
        if (!text.trim() || text.length > 2000000) throw new Error('每份参考文本需要包含内容，且不超过 200 万字符');
        const sourceId = hash(text);
        const format = /\.txt$/i.test(name) ? 'txt' : 'docx';
        const file = path.join(await this.directory(id, 'style-sources'), `${sourceId}.${format}`);
        const bytes = format === 'txt' ? Buffer.from(text, 'utf8') : original ?? await encodeDocx(textDocument(text));
        await fs.writeFile(file, bytes, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        if (!current.value.sources.some(source => source.id === sourceId)) current.value.sources.push({ id: sourceId, name, characters: text.replace(/\s/g, '').length, format });
      }
      return this.write(id, current.value, expectedHash);
    });
  }
  async readStyleSources(id: string, sourceIds: string[], forKnowledge = false) {
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(30).parse(sourceIds);
    if (new Set(ids).size !== ids.length) throw new Error('参考文本选择重复');
    const current = await this.read(id); const hashes: Record<string, string> = {}; const texts: { name: string; text: string }[] = []; const warnings: string[] = []; let total = 0;
    for (const sourceId of ids) {
      const source = current.value.sources.find(s => s.id === sourceId); if (!source) throw new Error('参考文本不属于当前小说');
      if (forKnowledge && (await fs.stat(path.join(await this.directory(id, 'style-sources'), `${sourceId}.${source.format ?? 'txt'}`))).size > 8 * 1024 * 1024) throw new Error('知识检索参考原件超过8MiB限制');
      const bytes = await this.readFile(id, 'style-sources', `${sourceId}.${source.format ?? 'txt'}`);
      if (forKnowledge && bytes.length > 8 * 1024 * 1024) throw new Error('知识检索参考原件超过8MiB限制');
      hashes[sourceId] = hash(bytes);
      let text: string;
      if (source.format === 'docx') { text = (await mammoth.extractRawText({ buffer: bytes })).value; if (forKnowledge) warnings.push('参考DOCX仅提取基础文字，图片、域和部分复杂内容可能不可见。'); }
      else if (forKnowledge) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('知识检索参考TXT不是有效UTF-8，请先另存兼容副本，原件保留'); } }
      else text = bytes.toString('utf8');
      if (forKnowledge && text.length > 200000) throw new Error('知识检索每份参考来源仅支持20万字符');
      total += text.length; if (total > 4000000) throw new Error('本次参考文本超过400万字符，请减少选择');
      texts.push({ name: source.name, text });
    }
    return { current, texts, hashes, warnings };
  }
  async styleSample(id: string, sourceIds: string[], expectedHash: string, maxEach: number) {
    const source = await this.readStyleSources(id, sourceIds);
    if (source.current.hash !== expectedHash) throw new Error('本书文风资料已变化，请刷新');
    const pieces = source.texts.map(item => ({ ...item, ...sampleStyleText(item.text, maxEach) }));
    const corpus = source.texts.map(item => item.text).join('\n');
    return { sourceText: pieces.map(item => `参考样本（${item.name}）：\n${item.text}`).join('\n\n'), sourceHashes: source.hashes,
      sampled: pieces.some(item => item.sampled), sampleCharacters: pieces.reduce((n, item) => n + item.text.length, 0),
      totalCharacters: corpus.length, metrics: analyzeText(corpus).metrics };
  }
  acceptModelStyle(id: string, name: string, rules: string, sourceIds: string[], analysis: NonNullable<LearnedStyle['analysis']>, metrics: LearnedStyle['metrics'], expectedHash: string) {
    return this.serial(async () => {
      const source = await this.readStyleSources(id, sourceIds);
      if (source.current.hash !== expectedHash) throw new Error('文风资料已更新，请保留规则并重新加载');
      if (sourceIds.some(sourceId => source.hashes[sourceId] !== analysis.sourceHashes[sourceId])) throw new Error('参考文本已变化，请重新分析');
      if (!name.trim() || source.current.value.styles.some(style => style.name === name.trim())) throw new Error('文风名称为空或与现有档案重名');
      source.current.value.styles.push({ id: randomUUID(), name: name.trim(), rules, sourceIds, createdAt: new Date().toISOString(), method: 'model-analysis-v1', analysis, metrics });
      return this.write(id, source.current.value, expectedHash);
    });
  }
  analyze(id: string, name: string, sourceIds: string[], expectedHash: string) {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!sourceIds.length || sourceIds.length > 30 || new Set(sourceIds).size !== sourceIds.length) throw new Error('请选择 1—30 份参考文本');
      if (sourceIds.some(source => !current.value.sources.some(item => item.id === source))) throw new Error('参考文本不属于当前小说');
      if (!name.trim()) throw new Error('请为文风命名');
      if (current.value.styles.some(s => s.name === name.trim())) throw new Error('已有同名文风，请换一个名称');
      let corpus = '';
      for (const sourceId of sourceIds) {
        const source = current.value.sources.find(item => item.id === sourceId)!;
        const bytes = await this.readFile(id, 'style-sources', `${sourceId}.${source.format ?? 'txt'}`);
        corpus += '\n' + (source.format === 'docx' ? (await mammoth.extractRawText({ buffer: bytes })).value : bytes.toString('utf8'));
        if (corpus.length > 4000000) throw new Error('本次参考文本过长，请减少选择的文件');
      }
      current.value.styles.push({ id: randomUUID(), name: name.trim(), sourceIds, createdAt: new Date().toISOString(), ...analyzeText(corpus) });
      return this.write(id, current.value, expectedHash);
    });
  }
}
