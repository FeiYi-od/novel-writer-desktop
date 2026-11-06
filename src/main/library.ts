import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BookDetails, BookSnapshot, Project } from '../shared/contracts';
import { analyzeText } from '../core/style-analysis';
import { compareForMerge } from '../core/style-merge-compare';
import { analyzeFullText } from '../core/style-fulltext';
import { splitModelStyleText } from '../core/style-model-split';
import type { LearnedStyle } from '../shared/contracts';
import { sampleStyleText } from '../core/style-learning';
import mammoth from 'mammoth';
import { encodeDocx } from './docx';
import { validateDocxForTextExtraction } from './docx-copy-service';
import { textDocument } from './text-import';
import { materialDirectory, readMarkdown, writeMarkdown, stylesMarkdown, parseStylesMarkdown } from './markdown-materials';

const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const cover = z.string().regex(/^(?:[a-f0-9]{64}\.png)?$/);
const schema = z.object({
  schemaVersion: z.literal(1), projectId: z.uuid(), title: z.string().trim().min(1).max(200),
  introduction: z.string().max(20000), cover,
  volumes: z.array(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(200), introduction: z.string().max(20000), cover, chapters: z.array(z.string().max(1000)) })).max(1000),
  sources: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(300), characters: z.number().int().nonnegative(), format: z.enum(['docx', 'txt']).optional(), author: z.string().max(120).optional(), work: z.string().max(200).optional() })).max(500),
  styles: z.array(z.object({
    id: z.uuid(), name: z.string().trim().min(1).max(100), rules: z.string().min(1).max(20000), sourceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    createdAt: z.string(), method: z.enum(['local-statistics-v1', 'model-analysis-v1']), mergedFrom: z.object({ styleIds: z.array(z.uuid()), mode: z.enum(['equal', 'characters']), weights: z.record(z.string(), z.number()) }).optional(), coverage: z.object({ mode: z.enum(['full', 'sample']), characters: z.number().int().nonnegative(), chunks: z.number().int().nonnegative(), chunkCharacters: z.number().int().nonnegative(), sentenceLength: z.object({ min: z.number(), max: z.number() }), dialogueRatio: z.object({ min: z.number(), max: z.number() }) }).optional(), analysis: z.object({ taskId: z.uuid(), model: z.string(), sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)), sampled: z.boolean(), sampleCharacters: z.number().int().nonnegative(), totalCharacters: z.number().int().nonnegative() }).optional(), metrics: z.object({
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
        const format = /\.txt$/i.test(name) ? 'txt' : 'docx';
        if (!text.trim()) throw new Error('参考文本需要包含内容');
        if (text.length > 6000000) throw new Error('单份参考文本不能超过 600 万字符');
        const sourceId = hash(text);
        const file = path.join(await this.directory(id, 'style-sources'), `${sourceId}.${format}`);
        const bytes = format === 'txt' ? Buffer.from(text, 'utf8') : original ?? await encodeDocx(textDocument(text));
        await fs.writeFile(file, bytes, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        if (!current.value.sources.some(source => source.id === sourceId)) current.value.sources.push({ id: sourceId, name, characters: text.replace(/\s/g, '').length, format });
      }
      return this.write(id, current.value, expectedHash);
    });
  }
  /** 删除参考文本：被文风档案引用时拒绝并列出档案名，避免删除后档案悬空。
   * 先写书籍资料再删文件；文件删除失败只留下无害孤儿，不影响正确性。 */
  removeSources(id: string, sourceIds: string[], expectedHash: string) {
    return this.serial(async () => {
      const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(30).parse(sourceIds);
      if (new Set(ids).size !== ids.length) throw new Error('参考文本选择重复');
      const current = await this.read(id);
      if (current.hash !== expectedHash) throw new Error('文风资料已更新，请重新打开');
      const missing = ids.filter(source => !current.value.sources.some(item => item.id === source));
      if (missing.length) throw new Error('参考文本不属于当前小说');
      const referencing = current.value.styles.filter(style => style.sourceIds.some(source => ids.includes(source)));
      if (referencing.length) throw new Error('这些参考文本仍被文风档案引用：' + referencing.map(style => style.name).join('、') + '；请先删除或重新生成对应档案');
      const removed = current.value.sources.filter(source => ids.includes(source.id));
      const next = { ...current.value, sources: current.value.sources.filter(source => !ids.includes(source.id)) };
      const snapshot = await this.write(id, next, expectedHash);
      const directory = await this.directory(id, 'style-sources');
      for (const source of removed) {
        await fs.unlink(path.join(directory, `${source.id}.${source.format ?? 'txt'}`)).catch(() => {});
      }
      return { removed: removed.length, names: removed.map(source => source.name), snapshot };
    });
  }

  /** 删除文风档案：删到当前启用档案时清空选择，绝不再自动挑选替代档案。 */
  removeStyle(id: string, styleId: string, expectedHash: string) {
    return this.serial(async () => {
      const target = z.uuid().parse(styleId);
      const current = await this.read(id);
      if (current.hash !== expectedHash) throw new Error('文风资料已更新，请重新打开');
      const style = current.value.styles.find(item => item.id === target);
      if (!style) throw new Error('文风档案不存在，可能已删除');
      const next = { ...current.value, styles: current.value.styles.filter(item => item.id !== target), activeStyleId: current.value.activeStyleId === target ? '' : current.value.activeStyleId };
      return { name: style.name, snapshot: await this.write(id, next, expectedHash) };
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
      if (source.format === 'docx') { await validateDocxForTextExtraction(bytes); text = (await mammoth.extractRawText({ buffer: bytes })).value; if (forKnowledge) warnings.push('参考DOCX仅提取基础文字，图片、域和部分复杂内容可能不可见。'); }
      else if (forKnowledge) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('知识检索参考TXT不是有效UTF-8，请先另存兼容副本，原件保留'); } }
      else text = bytes.toString('utf8');
      if (forKnowledge && text.length > 200000) throw new Error('知识检索每份参考来源仅支持20万字符');
      total += text.length; if (total > 8000000) throw new Error('本次参考文本超过 800 万字符，请减少选择');
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
  /** 全文分段：按预算把每个来源切成块，供分段模型分析使用；不改变原文，只给模型看分块。 */
  async styleChunks(id: string, sourceIds: string[], expectedHash: string, chunkCharacters: number) {
    const source = await this.readStyleSources(id, sourceIds);
    if (source.current.hash !== expectedHash) throw new Error('本书文风资料已变化，请刷新');
    const budget = Math.max(1000, Math.min(20000, Math.floor(chunkCharacters)));
    const chunks: { name: string; index: number; text: string }[] = [];
    for (const item of source.texts) {
      for (const part of splitModelStyleText(item.text, budget)) {
        chunks.push({ name: item.name, index: chunks.length, text: part });
      }
    }
    if (!chunks.length) throw new Error('参考文本为空，无法分段分析');
    if (chunks.length > 2000) throw new Error('参考文本分段超过 2000 段，请减少本次语料或增大模型窗口');
    const corpus = source.texts.map(item => item.text).join('\n');
    return { chunks, sourceHashes: source.hashes, totalCharacters: source.texts.reduce((sum, item) => sum + item.text.length, 0), chunkCharacters: budget, metrics: analyzeText(corpus).metrics };
  }

  /** 只给"开始前预估"用的轻量计划：不返回正文块，只返回段数、字数与预计调用数。 */
  async stylePlanPreview(id: string, sourceIds: string[], expectedHash: string, chunkCharacters: number) {
    const plan = await this.styleChunks(id, sourceIds, expectedHash, chunkCharacters);
    const perChunk = plan.chunks.map(chunk => chunk.text.length);
    return {
      chunks: plan.chunks.length, chunkCharacters: plan.chunkCharacters, totalCharacters: plan.totalCharacters,
      estimatedRequests: plan.chunks.length + 1, largestChunkCharacters: Math.max(...perChunk), smallestChunkCharacters: Math.min(...perChunk)
    };
  }

  /** 断点恢复用：按保存下来的来源哈希重新切块；来源内容变了就拒绝，避免把新旧样本混成一份结果。 */
  async styleChunksForResume(id: string, sourceIds: string[], chunkCharacters: number, sourceHashes: Record<string, string>) {
    const source = await this.readStyleSources(id, sourceIds);
    for (const sourceId of sourceIds) {
      if (source.hashes[sourceId] !== sourceHashes[sourceId]) throw new Error('参考文本已变化，不能从旧断点继续；请重新开始分析');
    }
    const budget = Math.max(1000, Math.min(20000, Math.floor(chunkCharacters)));
    const chunks: { name: string; index: number; text: string }[] = [];
    for (const item of source.texts) {
      for (const part of splitModelStyleText(item.text, budget)) {
        chunks.push({ name: item.name, index: chunks.length, text: part });
      }
    }
    if (!chunks.length) throw new Error('参考文本为空，无法分段分析');
    if (chunks.length > 2000) throw new Error('参考文本分段超过 2000 段，请减少本次语料或增大模型窗口');
    return { chunks, sourceHashes: source.hashes, totalCharacters: source.texts.reduce((sum, item) => sum + item.text.length, 0), chunkCharacters: budget };
  }

  /** 标记参考文本的作者/作品（用于同作者分组）；传空字符串即清除。 */
  labelStyleSource(id: string, sourceId: string, label: { author?: string; work?: string }, expectedHash: string) {
    return this.serial(async () => {
      const current = await this.read(id);
      if (current.hash !== expectedHash) throw new Error('文风资料已更新，请重新打开');
      const target = z.string().regex(/^[a-f0-9]{64}$/).parse(sourceId);
      const source = current.value.sources.find(item => item.id === target);
      if (!source) throw new Error('参考文本不属于当前小说');
      const author = label.author === undefined ? source.author : String(label.author).trim().slice(0, 120) || undefined;
      const work = label.work === undefined ? source.work : String(label.work).trim().slice(0, 200) || undefined;
      const next = { ...current.value, sources: current.value.sources.map(item => item.id === target ? { ...item, author, work } : item) };
      return this.write(id, next, expectedHash);
    });
  }

  /** 合并多个文风档案：equal 等权；characters 按各档案统计的字符数加权。
   * 新档案保留 mergedFrom（来源 ID、模式、实际权重），不覆盖原档案。 */
  mergeStyles(id: string, name: string, styleIds: string[], mode: 'equal' | 'characters', expectedHash: string) {
    return this.serial(async () => {
      const current = await this.read(id);
      if (current.hash !== expectedHash) throw new Error('文风资料已更新，请重新打开');
      const trimmed = name.trim();
      if (!trimmed) throw new Error('请为合并文风命名');
      if (current.value.styles.some(style => style.name === trimmed)) throw new Error('已有同名文风，请换一个名称');
      const ids = z.array(z.uuid()).min(2).max(10).parse(styleIds);
      if (new Set(ids).size !== ids.length) throw new Error('合并来源不能重复');
      const styles = ids.map(styleId => {
        const style = current.value.styles.find(item => item.id === styleId);
        if (!style) throw new Error('要合并的文风档案不存在，可能已删除');
        return style;
      });
      const totalCharacters = styles.reduce((sum, style) => sum + Math.max(style.metrics.characters, 1), 0);
      const weights = Object.fromEntries(styles.map(style => [style.id, mode === 'equal' ? Math.round((1 / styles.length) * 1000) / 1000 : Math.round(style.metrics.characters / totalCharacters * 1000) / 1000]));
      const weighted = (pick: (style: (typeof styles)[number]) => number) => {
        const value = styles.reduce((sum, style) => sum + pick(style) * (weights[style.id] ?? 0), 0);
        return Math.round(value * 10) / 10;
      };
      const metrics = {
        characters: styles.reduce((sum, style) => sum + style.metrics.characters, 0),
        paragraphs: styles.reduce((sum, style) => sum + style.metrics.paragraphs, 0),
        meanSentenceLength: weighted(style => style.metrics.meanSentenceLength),
        meanParagraphLength: weighted(style => style.metrics.meanParagraphLength),
        dialogueRatio: Math.round(weighted(style => style.metrics.dialogueRatio) * 10) / 10,
        firstPersonPerThousand: weighted(style => style.metrics.firstPersonPerThousand)
      };
      const label = mode === 'equal' ? '等权' : '按有效字数加权';
      const header = '合并分析（' + label + '，权重：' + styles.map(style => style.name + ' ' + Math.round((weights[style.id] ?? 0) * 100) + '%').join(' / ') + '）：' + styles.map(style => style.name).join('、');
      const rules = [header, ...styles.flatMap(style => style.rules.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => '【' + style.name + '】' + line))].join('\n').slice(0, 20000);
      const merged: LearnedStyle = {
        id: randomUUID(), name: trimmed, rules, sourceIds: [...new Set(styles.flatMap(style => style.sourceIds))],
        createdAt: new Date().toISOString(), method: styles.every(style => style.method === 'model-analysis-v1') ? 'model-analysis-v1' : 'local-statistics-v1',
        metrics, mergedFrom: { styleIds: ids, mode, weights }
      };
      return this.write(id, { ...current.value, styles: [...current.value.styles, merged] }, expectedHash);
    });
  }

  /** 合并前对比：返回共同规则、各档案独有规则与指标区间；只读，不改档案。 */
  compareStyleArchives(id: string, styleIds: string[]) {
    return this.serial(async () => {
      const current = await this.read(id);
      const ids = z.array(z.uuid()).min(2).max(10).parse(styleIds);
      if (new Set(ids).size !== ids.length) throw new Error('比较来源不能重复');
      const styles = ids.map(styleId => {
        const style = current.value.styles.find(item => item.id === styleId);
        if (!style) throw new Error('要比较的文风档案不存在，可能已删除');
        return style;
      });
      return compareForMerge(styles.map(style => ({ id: style.id, name: style.name, rules: style.rules, metrics: style.metrics })));
    });
  }

  /** 跨小说导入文风档案：复制被引用的来源文件到目标书、建立目标书独立记录，
   * 不改源书、不共享引用；目标书重名时自动加「（导入）」。 */
  importStyleFromBook(sourceProjectId: string, targetProjectId: string, styleId: string, targetExpectedHash: string) {
    return this.serial(async () => {
      const sourceId = z.uuid().parse(sourceProjectId), targetId = z.uuid().parse(targetProjectId);
      if (sourceId === targetId) throw new Error('请选择另一本小说作为文风来源');
      const styleUUID = z.uuid().parse(styleId);
      const source = await this.read(sourceId);
      const target = await this.read(targetId);
      if (target.hash !== targetExpectedHash) throw new Error('目标小说的文风资料已更新，请重新打开');
      const style = source.value.styles.find(item => item.id === styleUUID);
      if (!style) throw new Error('源文风档案不存在，可能已删除');
      const targetRoot = this.getProject(targetId).root;
      const sourceRoot = this.getProject(sourceId).root;
      let copied = 0;
      const sources = [...target.value.sources];
      for (const referenced of style.sourceIds) {
        const meta = source.value.sources.find(item => item.id === referenced);
        if (!meta) throw new Error('源文风引用的参考文本缺失，已取消导入');
        if (sources.some(item => item.id === referenced)) continue;
        const relative = path.join('小说资料', 'style-sources', referenced + '.' + (meta.format ?? 'txt'));
        const bytes = await fs.readFile(path.join(sourceRoot, relative));
        const destination = path.join(targetRoot, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        sources.push({ ...meta });
        copied += 1;
      }
      let name = style.name;
      for (let index = 1; target.value.styles.some(item => item.name === name) && index < 50; index++) name = style.name + '（导入' + (index || '') + '）';
      if (target.value.styles.some(item => item.name === name)) throw new Error('目标书已有过多同名文风，请先整理');
      const imported: LearnedStyle = {
        id: randomUUID(), name, rules: style.rules, sourceIds: [...style.sourceIds], createdAt: new Date().toISOString(),
        method: style.method, metrics: style.metrics, coverage: style.coverage
      };
      const snapshot = await this.write(targetId, { ...target.value, sources, styles: [...target.value.styles, imported] }, targetExpectedHash);
      return { snapshot, styleId: imported.id, copiedSources: copied };
    });
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
  analyze(id: string, name: string, sourceIds: string[], expectedHash: string, options: { mode?: 'sample' | 'full'; chunkCharacters?: number } = {}) {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!sourceIds.length || sourceIds.length > 30 || new Set(sourceIds).size !== sourceIds.length) throw new Error('请选择 1—30 份参考文本');
      if (sourceIds.some(source => !current.value.sources.some(item => item.id === source))) throw new Error('参考文本不属于当前小说');
      if (!name.trim()) throw new Error('请为文风命名');
      if (current.value.styles.some(s => s.name === name.trim())) throw new Error('已有同名文风，请换一个名称');
      const texts: string[] = []; let totalCharacters = 0;
      for (const sourceId of sourceIds) {
        const source = current.value.sources.find(item => item.id === sourceId)!;
        const bytes = await this.readFile(id, 'style-sources', `${sourceId}.${source.format ?? 'txt'}`);
        if (source.format === 'docx') await validateDocxForTextExtraction(bytes);
        const text = source.format === 'docx' ? (await mammoth.extractRawText({ buffer: bytes })).value : bytes.toString('utf8');
        totalCharacters += text.length;
        if (totalCharacters > 8000000) throw new Error('本次参考文本超过 800 万字符，请减少选择的文件');
        texts.push(text);
      }
      const corpus = (options.mode === 'full' ? texts : texts.map(text => sampleStyleText(text, 6000, '\n').text)).join('\n');
      const base = analyzeText(corpus);
      if (options.mode !== 'full') {
        current.value.styles.push({ id: randomUUID(), name: name.trim(), sourceIds, createdAt: new Date().toISOString(), ...base, coverage: { mode: 'sample', characters: base.metrics.characters, chunks: 1, chunkCharacters: base.metrics.characters, sentenceLength: { min: base.metrics.meanSentenceLength, max: base.metrics.meanSentenceLength }, dialogueRatio: { min: base.metrics.dialogueRatio, max: base.metrics.dialogueRatio } } });
      } else {
        // 全文统计使用整段语料；分段仅用于显示不同区段的指标范围。
        const full = analyzeFullText(corpus, { chunkCharacters: options.chunkCharacters ?? 20000 });
        current.value.styles.push({ id: randomUUID(), name: name.trim(), sourceIds, createdAt: new Date().toISOString(), method: base.method, rules: base.rules, metrics: full.metrics, coverage: full.coverage });
      }
      return this.write(id, current.value, expectedHash);
    });
  }
}
