import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ChapterConfirmationEntry, ChapterConfirmationPreview, ChapterConfirmationSnapshot, ConfirmChapterVersionRequest } from '../shared/contracts';
import { hashText } from './ai-connections';
import { materialDirectory, metadata, readMarkdown, safeJson, writeMarkdown } from './markdown-materials';
import type { Workspace } from './workspace';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.union([z.literal(''), fingerprint]);
const sourcePath = z.string().min(1).max(2000);
const entrySchema = z.object({ id: z.uuid(), projectId: z.uuid(), sourcePath, sourceHash: fingerprint, confirmedAt: z.iso.datetime(), enabled: z.boolean() }).strict();
const schema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), entries: z.array(entrySchema).max(1000) }).strict();
const storedSchema = schema.extend({ kind: z.literal('chapter-confirmations') }).strict();
const requestSchema = z.object({ projectId: z.uuid(), path: sourcePath, sourceHash: fingerprint, expectedHash: revision }).strict();
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const key = (relative: string) => path.normalize(relative).toLowerCase();
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** Explicit author decisions only. Reading, editing, saving and exporting never
 * create confirmation records. Source files are always read-only here. */
export class ChapterConfirmationStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private workspace: Workspace, private materialsRoot: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const result = this.queue.then(action); this.queue = result.catch(() => {}); return result; }
  private relative(id: string, input: string) {
    const project = this.workspace.getProject(z.uuid().parse(id));
    sourcePath.parse(input);
    if (path.isAbsolute(input) || input.includes(':') || /[<>"|?*\x00-\x1f]/u.test(input) || input.split(/[\\/]/u).includes('..')) throw new Error('正文确认路径无效或越界');
    const file = path.resolve(project.root, input), relative = path.relative(project.root, file);
    if (!relative || !inside(project.root, file) || relative.split(path.sep)[0].toLowerCase() === '小说资料' || !/\.(docx|txt)$/iu.test(relative)) throw new Error('正文确认路径越界或格式不受支持');
    return relative;
  }
  private async location(id: string) {
    this.workspace.getProject(z.uuid().parse(id));
    return path.join(await materialDirectory(this.materialsRoot, id), '正文确认.md');
  }
  private async raw(file: string) {
    try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('正文确认记录类型或链接不受支持，原文件已保留'); }
    catch (error) { if (absent(error)) return null; throw error; }
    return readMarkdown(file);
  }
  private validate(value: ChapterConfirmationSnapshot['value'], id: string) {
    schema.parse(value);
    if (value.projectId !== id || value.entries.some(entry => entry.projectId !== id)) throw new Error('正文确认记录属于其他小说，不能跨小说保存');
    if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) throw new Error('正文确认记录存在重复 ID，原文件已保留');
    for (const entry of value.entries) this.relative(id, entry.sourcePath);
    const enabled = value.entries.filter(entry => entry.enabled);
    if (new Set(enabled.map(entry => key(entry.sourcePath))).size !== enabled.length) throw new Error('同章存在多个启用的正文确认版本，请核对记录');
  }
  private async load(id: string) {
    const file = await this.location(id), raw = await this.raw(file);
    let value: ChapterConfirmationSnapshot['value'];
    if (raw === null) value = { schemaVersion: 1, projectId: id, entries: [] };
    else { const { kind: _kind, ...parsed } = storedSchema.parse(metadata(raw, 'chapter-confirmations', id)); value = parsed; }
    this.validate(value, id);
    const originalPaths = value.entries.map(entry => entry.sourcePath);
    const resolved = await this.workspace.resolveChapterPaths(id, originalPaths);
    value.entries = value.entries.map((entry, index) => ({ ...entry, sourcePath: resolved[index] }));
    this.validate(value, id);
    const pathsChanged = JSON.stringify(originalPaths) !== JSON.stringify(resolved);
    const hash = raw === null ? '' : hashText(pathsChanged ? raw + ':paths:' + JSON.stringify(resolved) : raw);
    return { file, raw, snapshot: { value, hash, staleIds: [] } as ChapterConfirmationSnapshot };
  }
  private async snapshot(id: string, validateSources: boolean): Promise<ChapterConfirmationSnapshot> {
    const { snapshot } = await this.load(id);
    if (validateSources) {
      for (const entry of snapshot.value.entries.filter(entry => entry.enabled)) {
        try { if (await this.workspace.chapterHash(id, entry.sourcePath) !== entry.sourceHash) snapshot.staleIds.push(entry.id); }
        catch { snapshot.staleIds.push(entry.id); }
      }
    }
    return snapshot;
  }
  read(id: string, validateSources = true) {
    const projectId = z.uuid().parse(id), validate = z.boolean().parse(validateSources);
    return this.serial(() => this.snapshot(projectId, validate));
  }
  private async currentSource(id: string, relative: string, hash: string) {
    // A preview binds its current path. A subsequent rename requires a new preview,
    // even when the rename preserved bytes; stored history may still be projected.
    if (await this.workspace.resolveChapterPath(id, relative) !== relative) throw new Error('正文已经重命名，请重新预览当前章节');
    if (await this.workspace.chapterHash(id, relative) !== hash) throw new Error('正文原件已变化，请重新预览后确认');
  }
  private async previewSource(id: string, relative: string): Promise<ChapterConfirmationPreview> {
    const frozen = await this.workspace.resolveChapterPath(id, this.relative(id, relative));
    const source = await this.workspace.readChapterKnowledge(id, frozen);
    if (source.projectId !== id || source.path !== frozen) throw new Error('正文来源或路径已变化，请重新预览');
    const text = source.paragraphs.join('\n');
    if (!text.trim()) throw new Error('正文为空，不能确认空白章节');
    if (text.length > 200000) throw new Error('正文确认每份来源仅支持20万字符');
    await this.currentSource(id, frozen, source.hash);
    return { projectId: id, path: frozen, hash: source.hash, text, characters: text.length, paragraphCount: source.paragraphs.filter(paragraph => paragraph.trim()).length, warnings: [...source.warnings] };
  }
  async preview(id: string, relative: string) {
    const projectId = z.uuid().parse(id), frozen = this.relative(projectId, relative);
    return this.serial(() => this.previewSource(projectId, frozen));
  }
  private markdown(value: ChapterConfirmationSnapshot['value']) {
    return `<!-- novel-writer ${safeJson({ ...value, kind: 'chapter-confirmations' })} -->\n# 正文确认\n\n仅作者显式确认的保存版本可作为正式正文。请保留文件头版本记录。\n\n` + value.entries.map(entry => `- ${entry.enabled ? '启用' : '停用'}：${entry.sourcePath}；${entry.confirmedAt}；版本 ${entry.sourceHash}\n`).join('');
  }
  private async stage(file: string, raw: string) {
    const staged = `${file}.${randomUUID()}.confirmation.tmp`;
    // Reuse the Markdown boundary and write preparation; final publication is
    // controlled below so first creation cannot overwrite a concurrent record.
    try { await writeMarkdown(staged, raw, ''); return staged; }
    catch (error) { await fs.unlink(staged).catch(cleanup => { if (!absent(cleanup)) throw cleanup; }); throw error; }
  }
  private async backup(file: string, raw: string) {
    const directory = path.join(path.dirname(file), 'history'); await fs.mkdir(directory, { recursive: true });
    if (!inside(path.dirname(file), await fs.realpath(directory))) throw new Error('正文确认备份目录链接越界');
    const backup = path.join(directory, `正文确认-${hashText(raw)}.md`);
    const existing = await this.raw(backup);
    if (existing !== null) { if (existing !== raw) throw new Error('正文确认历史备份异常，原记录已保留'); return; }
    const staged = await this.stage(backup, raw);
    try { await fs.link(staged, backup); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await this.raw(backup) !== raw) throw error; }
    finally { await fs.unlink(staged).catch(error => { if (!absent(error)) throw error; }); }
  }
  private async save(id: string, value: ChapterConfirmationSnapshot['value'], expectedHash: string, source?: { path: string; hash: string }) {
    this.validate(value, id);
    const current = await this.load(id);
    if (current.snapshot.hash !== expectedHash) throw new Error('正文确认记录已更新，请重新读取后核对');
    if (current.raw !== null) await this.backup(current.file, current.raw);
    const staged = await this.stage(current.file, this.markdown(value));
    const recheck = async () => {
      const [snapshot] = await Promise.all([this.load(id), source ? this.currentSource(id, source.path, source.hash) : Promise.resolve()]);
      if (snapshot.snapshot.hash !== expectedHash) throw new Error('保存期间正文确认记录或章节路径已变化，请重新读取');
      // Projection can await rename metadata. Re-read the record afterwards so
      // a change during that preparation cannot be hidden by an earlier read.
      if (await this.raw(current.file) !== current.raw) throw new Error('正文确认记录已在外部更新，原记录已保留');
    };
    try {
      await recheck();
      if (current.raw === null) await fs.link(staged, current.file);
      else {
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(staged, current.file); break; }
          catch (error) { if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(resolve => setTimeout(resolve, 30 * 2 ** attempt)); await recheck(); }
        }
      }
    } finally { await fs.unlink(staged).catch(error => { if (!absent(error)) throw error; }); }
    // Final checks reduce races but are not a cross-process filesystem lock.
    return this.snapshot(id, true);
  }
  async confirm(input: ConfirmChapterVersionRequest) {
    const request = requestSchema.parse(input), frozen = this.relative(request.projectId, request.path);
    return this.serial(async () => {
      const { snapshot: current } = await this.load(request.projectId);
      if (current.hash !== request.expectedHash) throw new Error('正文确认记录已更新，请重新读取后核对');
      await this.currentSource(request.projectId, frozen, request.sourceHash);
      const preview = await this.previewSource(request.projectId, frozen);
      if (preview.path !== frozen || preview.hash !== request.sourceHash) throw new Error('正文原件已变化，请重新预览后确认');
      if (current.value.entries.some(entry => entry.enabled && key(entry.sourcePath) === key(frozen) && entry.sourceHash === request.sourceHash)) throw new Error('此正文版本已经启用确认，不能重复确认');
      if (current.value.entries.length >= 1000) throw new Error('正文确认历史已达1000条上限，请保留记录后核对');
      const entry: ChapterConfirmationEntry = { id: randomUUID(), projectId: request.projectId, sourcePath: frozen, sourceHash: request.sourceHash, confirmedAt: new Date().toISOString(), enabled: true };
      return this.save(request.projectId, { ...current.value, entries: [...current.value.entries.map(previous => key(previous.sourcePath) === key(frozen) ? { ...previous, enabled: false } : previous), entry] }, request.expectedHash, { path: frozen, hash: request.sourceHash });
    });
  }
  async disable(id: string, entryId: string, expectedHash: string) {
    const projectId = z.uuid().parse(id), targetId = z.uuid().parse(entryId), baseline = revision.parse(expectedHash);
    return this.serial(async () => {
      const { snapshot: current } = await this.load(projectId);
      if (current.hash !== baseline) throw new Error('正文确认记录已更新，请重新读取后核对');
      const target = current.value.entries.find(entry => entry.id === targetId);
      if (!target) throw new Error('本书未找到此正文确认版本');
      if (!target.enabled) throw new Error('此正文确认版本已经停用');
      return this.save(projectId, { ...current.value, entries: current.value.entries.map(entry => entry.id === targetId ? { ...entry, enabled: false } : entry) }, baseline);
    });
  }
}
