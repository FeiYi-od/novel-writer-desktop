import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { z } from 'zod';
import { EMPTY_DOCUMENT, type Chapter, type Manuscript, type NotesSnapshot, type Project, type ProjectNotes, type RichNode, type SaveRequest } from '../shared/contracts';
import { encodeDocx, validateDocument } from './docx';
import { ChapterPaths } from './chapter-paths';
import type { RenameChapterRequest } from '../shared/contracts';
import { normalizeParagraphs } from '../core/typography';
import { decodeText, txtDocument, txtText } from './text-import';
import { describeSaveFailure } from '../core/save-failure';
import { materialDirectory, notesMarkdown, parseNotesMarkdown, readMarkdown, writeMarkdown } from './markdown-materials';
import { importRecoveredMaterials } from './material-recovery';

const META = '小说资料';
const projectSchema = z.object({ schemaVersion: z.literal(1), id: z.uuid(), name: z.string().min(1).max(200) });
const notesSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), characters: z.string(), world: z.string(), preset: z.string(), style: z.string() });
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const inside = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
type RecoveryDirectory = { root: string; base: string; directory: string; rootDev: number; rootIno: number; dev: number; ino: number };

export class Workspace {
  private projects = new Map<string, Project>();
  private chapterPaths = new ChapterPaths(id => this.project(id));
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly localData: string, readonly materialsRoot?: string) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async initialize() {
    await fs.mkdir(this.localData, { recursive: true });
    let entries: unknown;
    try { entries = JSON.parse(await fs.readFile(path.join(this.localData, 'library.json'), 'utf8')); }
    catch (e) { if (!absent(e)) throw new Error('书库索引损坏，请保留文件并恢复备份'); return; }
    const roots = z.array(z.string()).parse(entries);
    for (const root of roots) {
      try {
        const metadata = projectSchema.parse(JSON.parse(await fs.readFile(path.join(root, META, 'project.json'), 'utf8')));
        if (this.projects.has(metadata.id)) continue;
        this.projects.set(metadata.id, { ...metadata, root });
      } catch {
        // 离线目录仍保存在 library.json；恢复连接后用户可重新关联。
      }
    }
  }

  listProjects() { return [...this.projects.values()]; }
  getProject(id: string) { return this.project(id); }
  resolveChapterPath(id: string, relative: string) { return this.chapterPaths.resolve(id, relative); }
  resolveChapterPaths(id: string, relative: string[]) { return this.chapterPaths.resolveMany(id, relative); }
  renameChapter(request: RenameChapterRequest): Promise<Manuscript> { return this.serial(async () => this.readChapter(request.projectId, await this.chapterPaths.rename(request))); }
  /** Moves a chapter file into another folder of the same novel; old-path bindings are kept. */
  moveChapter(request: { projectId: string; path: string; expectedHash: string; folder: string }): Promise<string> {
    return this.serial(() => this.chapterPaths.move(request));
  }

  private project(id: string) {
    const project = this.projects.get(id);
    if (!project) throw new Error('未关联此小说，请重新选择文件夹');
    return project;
  }

  private async metadataDirectory(project: Project) {
    const directory = path.join(project.root, META);
    await fs.mkdir(directory, { recursive: true });
    if (!inside(project.root, await fs.realpath(directory))) throw new Error('资料目录不能指向小说目录外');
    return directory;
  }

  private async verifyRecoveryDirectory(target: RecoveryDirectory) {
    const root = await fs.lstat(target.root), directory = await fs.lstat(target.directory);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== target.rootDev || root.ino !== target.rootIno
      || !directory.isDirectory() || directory.isSymbolicLink() || directory.dev !== target.dev || directory.ino !== target.ino
      || await fs.realpath(target.root) !== target.base || path.relative(target.directory, await fs.realpath(target.directory)) !== '')
      throw new Error('本机恢复目录已变化，未将稿件写入其他目录');
  }

  private async writeRecovery(target: RecoveryDirectory, name: string, data: string | Buffer) {
    await this.verifyRecoveryDirectory(target);
    const file = path.join(target.directory, name), handle = await fs.open(file, 'wx');
    try {
      const opened = await handle.stat();
      await this.verifyRecoveryDirectory(target);
      const current = await fs.lstat(file);
      if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino)
        throw new Error('本机恢复文件身份已变化，未写入稿件');
      await handle.writeFile(data);
      await this.verifyRecoveryDirectory(target);
      const after = await fs.lstat(file);
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino)
        throw new Error('本机恢复文件写入期间发生变化');
    } finally { await handle.close(); }
  }

  async attach(folder: string): Promise<Project> {
    return this.serial(async () => {
      const root = await fs.realpath(folder);
      for (const existing of this.projects.values()) {
        if (path.relative(existing.root, root) === '') return existing;
        if (inside(existing.root, root) || inside(root, existing.root)) throw new Error('每本小说需使用互不嵌套的独立文件夹');
      }
      const directory = path.join(root, META);
      await fs.mkdir(directory, { recursive: true });
      if (!inside(root, await fs.realpath(directory))) throw new Error('资料目录链接越界');
      let metadata: z.infer<typeof projectSchema>;
      try { metadata = projectSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'project.json'), 'utf8'))); }
      catch (e) {
        if (!absent(e)) throw new Error('小说资料格式无法识别，已保留原文件');
        metadata = { schemaVersion: 1, id: randomUUID(), name: path.basename(root) };
        await fs.writeFile(path.join(directory, 'project.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
      }
      if (this.projects.has(metadata.id)) throw new Error('发现相同小说 ID 的另一份目录，请勿作为不同小说打开');
      if (this.materialsRoot) await importRecoveredMaterials(root, this.materialsRoot, metadata.id);
      const project: Project = { ...metadata, root };
      // 合并离线目录记录，避免一次临时离线导致其他书从索引消失。
      let stored: string[] = [];
      try { stored = z.array(z.string()).parse(JSON.parse(await fs.readFile(path.join(this.localData, 'library.json'), 'utf8'))); }
      catch (e) { if (!absent(e)) throw e; }
      await this.atomic(path.join(this.localData, 'library.json'), JSON.stringify([...new Set([...stored, root])], null, 2));
      this.projects.set(project.id, project);
      return project;
    });
  }

  private async chapterFile(id: string, relative: string) {
    const project = this.project(id);
    relative = await this.resolveChapterPath(id, relative);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes(':')) throw new Error('无效章节路径');
    const file = path.resolve(project.root, relative);
    if (!inside(project.root, file) || inside(path.join(project.root, META), file) || !['.docx', '.txt'].includes(path.extname(file).toLowerCase())) throw new Error('章节路径越界或格式不受支持');
    const real = await fs.realpath(file);
    if (!inside(project.root, real) || inside(path.join(project.root, META), real)) throw new Error('章节链接越界');
    return real;
  }

  async chapters(id: string): Promise<Chapter[]> {
    await this.chapterPaths.check(id);
    const project = this.project(id);
    const result: Chapter[] = [];
    const visit = async (directory: string, depth: number) => {
      if (depth > 20) return;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name === META || entry.name.startsWith('~$')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile() && /\.(docx|txt)$/i.test(entry.name)) result.push({ path: path.relative(project.root, file), name: entry.name });
      }
    };
    await visit(project.root, 0);
    return result.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
  }

  private async stateFile(projectId: string, hash: string) {
    const metadata = await this.metadataDirectory(this.project(projectId));
    const directory = path.join(metadata, 'documents');
    await fs.mkdir(directory, { recursive: true });
    if (!inside(metadata, await fs.realpath(directory))) throw new Error('文档资料路径越界');
    return path.join(directory, `${hash}.json`);
  }

  private async readState(projectId: string, hash: string): Promise<RichNode | undefined> {
    try {
      const state = JSON.parse(await fs.readFile(await this.stateFile(projectId, hash), 'utf8'));
      if (state.schemaVersion !== 1 || state.projectId !== projectId || state.hash !== hash) return undefined;
      validateDocument(state.content);
      return state.content;
    } catch (e) { if (absent(e) || e instanceof SyntaxError) return undefined; throw e; }
  }

  private async recordState(projectId: string, hash: string, content: RichNode) {
    const file = await this.stateFile(projectId, hash);
    await this.atomic(file, JSON.stringify({ schemaVersion: 1, projectId, hash, content }));
  }

  async readChapter(projectId: string, relative: string): Promise<Manuscript> {
    relative = await this.resolveChapterPath(projectId, relative);
    const file = await this.chapterFile(projectId, relative);
    if ((await fs.stat(file)).size > 20 * 1024 * 1024) throw new Error('当前框架仅打开 20 MB 以内的 DOCX');
    const buffer = await fs.readFile(file);
    const hash = digest(buffer);
    if (path.extname(file).toLowerCase() === '.txt') {
      const decoded = decodeText(buffer);
      const cached = decoded.encoding === 'utf-8' ? await this.readState(projectId, hash) : undefined;
      const content = cached && txtText(cached) === decoded.text ? cached : txtDocument(decoded.text);
      return { projectId, path: relative, hash, content, managed: decoded.encoding === 'utf-8', warnings: [decoded.encoding === 'utf-8' ? 'TXT 仅保存纯文本；字体与粗斜体不写入文件，保存时规范段首空格。' : `此 TXT 编码为 ${decoded.encoding}，请另存 UTF-8 TXT 或 DOCX，原文件保留。`] };
    }
    const state = await this.readState(projectId, hash);
    if (state) return { projectId, path: relative, hash, content: state, managed: true, warnings: [] };
    const preview = await mammoth.convertToHtml({ buffer });
    return {
      projectId, path: relative, hash, content: preview.value, managed: false,
      warnings: ['此文件由外部软件生成或修改。当前只预览基础文字；请另存为新 DOCX，原文件会保留。', ...preview.messages.map(m => m.message)]
    };
  }
  /** Read a saved snapshot for local retrieval; never use the renderer's unsaved draft. */
  async readChapterKnowledge(projectId: string, relative: string) {
    relative = await this.resolveChapterPath(projectId, relative);
    const file = await this.chapterFile(projectId, relative);
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('知识检索仅读取8MiB以内的正文文件');
    const bytes = await fs.readFile(file), hash = digest(bytes);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('知识检索正文文件超过8MiB限制');
    if (path.extname(file).toLowerCase() === '.txt') {
      const decoded = decodeText(bytes);
      const paragraphs = decoded.text.split(/\r\n|\n|\r/);
      if (decoded.text.length > 200000) throw new Error('知识检索每份来源仅支持20万字符');
      return { projectId, path: relative, hash, paragraphs, warnings: decoded.encoding === 'utf-8' ? [] : [`正文按${decoded.encoding}只读解码，原文件保留。`] };
    }
    // Retrieval fingerprints the DOCX bytes, so its text must come from those same bytes.
    // The editor's mutable structure cache cannot supply text under a DOCX-only hash.
    const extracted = await mammoth.extractRawText({ buffer: bytes });
    if (extracted.value.length > 200000) throw new Error('知识检索每份来源仅支持20万字符');
    const paragraphs = extracted.value.split(/\r?\n\r?\n/);
    if (paragraphs.at(-1) === '') paragraphs.pop();
    return { projectId, path: relative, hash, paragraphs, warnings: ['DOCX按原件提取基础文字，图片、域和部分复杂内容可能不可见；不会改写原文件。'] };
  }
  async chapterHash(projectId: string, relative: string) {
    const file = await this.chapterFile(projectId, relative);
    if ((await fs.stat(file)).size > 20 * 1024 * 1024) throw new Error('章节文件超过读取限制');
    return digest(await fs.readFile(file));
  }

  private async atomic(file: string, data: string | Buffer, beforeCommit?: () => Promise<void>) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, data, { flag: 'wx' });
      await beforeCommit?.();
      await fs.rename(temp, file);
    } finally { await fs.unlink(temp).catch(e => { if (!absent(e)) throw e; }); }
  }

  private checkedRequestPath(projectId: string, relative: string) {
    const project = this.project(z.uuid().parse(projectId));
    z.string().min(1).max(2000).parse(relative);
    const target = path.resolve(project.root, relative);
    if (path.isAbsolute(relative) || relative.includes(':') || !inside(project.root, target) || inside(path.join(project.root, META), target) || !/\.(docx|txt)$/iu.test(relative)) throw new Error('章节路径越界或格式不受支持');
    return project;
  }

  private async recoveryDirectory(projectId: string) {
    this.project(z.uuid().parse(projectId));
    const root = path.join(this.localData, 'recovery'); await fs.mkdir(root, { recursive: true });
    const rootStat = await fs.lstat(root), local = await fs.realpath(this.localData), base = await fs.realpath(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !inside(local, base)) throw new Error('本机恢复根目录或链接异常，未保存到其他小说');
    const directory = path.join(base, projectId); await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(base, await fs.realpath(directory))) throw new Error('本机恢复目录或链接异常，未保存到其他小说');
    const latestRoot = await fs.lstat(root);
    if (!latestRoot.isDirectory() || latestRoot.isSymbolicLink() || latestRoot.dev !== rootStat.dev || latestRoot.ino !== rootStat.ino || await fs.realpath(root) !== base)
      throw new Error('本机恢复根目录已变化，未保存到其他小说');
    return { root, base, directory, rootDev: rootStat.dev, rootIno: rootStat.ino, dev: stat.dev, ino: stat.ino } satisfies RecoveryDirectory;
  }

  /** Exact original bytes for format-preserving operations, never renderer text. */
  async readOriginalChapter(projectId: string, relative: string, expectedHash?: string) {
    this.checkedRequestPath(projectId, relative);
    if (expectedHash !== undefined) z.string().regex(/^[a-f0-9]{64}$/u).parse(expectedHash);
    const resolved = await this.resolveChapterPath(projectId, relative), file = await this.chapterFile(projectId, resolved);
    const before = await fs.stat(file);
    if (before.size > 20 * 1024 * 1024) throw new Error('原件超过20 MiB，已保留并拒绝操作');
    const bytes = await fs.readFile(file), hash = digest(bytes);
    if (bytes.length > 20 * 1024 * 1024 || before.size !== bytes.length) throw new Error('原件读取期间变化或过大，请重新打开');
    if (expectedHash !== undefined && hash !== expectedHash) throw new Error('原文版本已变化，请重新打开后操作');
    return { projectId, path: resolved.split(path.sep).join('/'), hash, bytes };
  }

  publishOriginalCopy(projectId: string, relative: string, expectedHash: string, input: Uint8Array, label: '保真编辑' | '结构编辑' | '换图' | '排版副本') {
    this.checkedRequestPath(projectId, relative); z.string().regex(/^[a-f0-9]{64}$/u).parse(expectedHash);
    z.enum(['保真编辑', '结构编辑', '换图', '排版副本']).parse(label);
    const bytes = Buffer.from(input);
    if (bytes.length > 20 * 1024 * 1024) throw new Error('副本超过20 MiB，原稿已保留');
    return this.serial(async () => {
      const source = await this.readOriginalChapter(projectId, relative, expectedHash), project = this.project(projectId);
      if (source.path !== relative.replace(/\\/gu, '/')) throw new Error('章节已改名或移动，请重新打开后另存副本');
      const sourceFile = await this.chapterFile(projectId, source.path), parent = path.dirname(sourceFile);
      const target = path.join(parent, `${path.basename(sourceFile, '.docx')}-${label}-${Date.now()}-${randomUUID().slice(0, 8)}.docx`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        const current = await this.readOriginalChapter(projectId, source.path, expectedHash);
        if (current.path !== source.path || await fs.realpath(parent) !== parent || await this.chapterFile(projectId, source.path) !== sourceFile) throw new Error('来源路径已变化，原稿已保留');
        await fs.link(temporary, target); // Exclusive publication; never overwrite an existing file.
      } finally { await fs.unlink(temporary).catch(error => { if (!absent(error)) throw error; }); }
      return { path: path.relative(project.root, target).split(path.sep).join('/'), hash: digest(bytes) };
    });
  }

  restoreOriginalChapter(projectId: string, relative: string, expectedHash: string, input: Uint8Array) {
    this.checkedRequestPath(projectId, relative); z.string().regex(/^[a-f0-9]{64}$/u).parse(expectedHash);
    const bytes = Buffer.from(input);
    if (bytes.length > 20 * 1024 * 1024) throw new Error('恢复原件超过20 MiB，已拒绝');
    return this.serial(async () => {
      const current = await this.readOriginalChapter(projectId, relative, expectedHash), file = await this.chapterFile(projectId, current.path);
      const recovery = await this.recoveryDirectory(projectId), stamp = `${Date.now()}-${randomUUID()}`, extension = path.extname(file).toLowerCase();
      await this.writeRecovery(recovery, `${stamp}-previous${extension}`, current.bytes);
      await this.writeRecovery(recovery, `${stamp}-previous.meta.json`, JSON.stringify({ schemaVersion: 1, sourcePath: current.path, at: new Date().toISOString(), bytes: current.bytes.length }));
      await this.atomic(file, bytes, async () => {
        const latest = await this.readOriginalChapter(projectId, current.path, expectedHash);
        if (latest.path !== current.path || await this.chapterFile(projectId, current.path) !== file) throw new Error('恢复期间章节路径或版本已变化，原件已保留');
      });
      return this.readChapter(projectId, current.path);
    });
  }

  async createChapter(projectId: string, source: RichNode = EMPTY_DOCUMENT, format: 'docx' | 'txt' = 'docx', beforePublish?: () => Promise<void>): Promise<Manuscript> {
    return this.serial(async () => {
      const project = this.project(projectId);
      if (!['docx', 'txt'].includes(format)) throw new Error('正文仅支持 DOCX 或 TXT');
      validateDocument(source);
      const content = normalizeParagraphs(source);
      const data = format === 'txt' ? Buffer.from(txtText(content), 'utf8') : await encodeDocx(content);
      const relative = `新章节-${Date.now()}-${randomUUID().slice(0, 4)}.${format}`;
      await this.recordState(projectId, digest(data), content);
      // Internal callers may recheck a source snapshot after encoding and cache
      // persistence, immediately before this independent new manuscript exists.
      await beforePublish?.();
      await fs.writeFile(path.join(project.root, relative), data, { flag: 'wx' });
      return { projectId, path: relative, hash: digest(data), content, managed: true, warnings: format === 'txt' ? ['TXT 仅保存纯文本，排版样式不会写入文件。'] : [] };
    });
  }

  async saveChapter(request: SaveRequest): Promise<Manuscript> {
    const frozen = z.object({ projectId: z.uuid(), path: z.string().min(1).max(2000), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u), content: z.custom<RichNode>() }).parse(request);
    this.checkedRequestPath(frozen.projectId, frozen.path); validateDocument(frozen.content);
    const content = structuredClone(frozen.content);
    try { return await this.saveChapterInner({ ...frozen, content }); }
    catch (error) {
      // 只在确实是文件系统错误时换成可读文案；业务校验的中文错误原样抛出。
      const code = (error as NodeJS.ErrnoException).code;
      if (code) throw new Error(describeSaveFailure(error).message);
      throw error;
    }
  }
  private async saveChapterInner(request: SaveRequest): Promise<Manuscript> {
    return this.serial(async () => {
      const { projectId, path: relative, expectedHash } = request;
      // 断网也可能发生在解析路径阶段，所以先把草稿落本机，再碰网络文件。
      const isTxt = path.extname(relative).toLowerCase() === '.txt';
      const content = normalizeParagraphs(request.content);
      const data = isTxt ? Buffer.from(txtText(content), 'utf8') : await encodeDocx(content);
      const recovery = await this.recoveryDirectory(projectId);
      const stamp = `${Date.now()}-${randomUUID()}`;
      await this.writeRecovery(recovery, `${stamp}-draft.${isTxt ? 'txt' : 'docx'}`, data);
      // 附带来源信息，界面里才能告诉作者这份草稿原本属于哪一章。
      await this.writeRecovery(recovery, `${stamp}-draft.meta.json`, JSON.stringify({ sourcePath: relative, at: new Date().toISOString(), bytes: data.length }));
      if (await this.resolveChapterPath(projectId, relative) !== path.normalize(relative)) throw new Error('章节已经重命名，旧路径不能写入，请重新打开当前章节');
      const file = await this.chapterFile(projectId, relative);
      const initialStat = await fs.stat(file);
      if (!initialStat.isFile() || initialStat.size > 20 * 1024 * 1024) throw new Error('章节文件类型异常或超过20 MiB，草稿已保留');
      // Recheck the original after the temporary output is fully written. A
      // hash check before staging leaves a window where another application
      // can edit the manuscript and be overwritten by the final rename.
      const beforeCommit = async () => {
        if (await this.resolveChapterPath(projectId, relative) !== path.normalize(relative)
          || await this.chapterFile(projectId, relative) !== file) throw new Error('章节路径已变化，草稿已保留，请重新打开');
        const before = await fs.stat(file);
        if (!before.isFile() || before.dev !== initialStat.dev || before.ino !== initialStat.ino || before.size > 20 * 1024 * 1024)
          throw new Error('章节原文件身份已变化，草稿已保留，请重新打开');
        const latest = await fs.readFile(file), after = await fs.stat(file);
        if (digest(latest) !== expectedHash || latest.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
          throw new Error('保存期间文件发生变化，外部原稿和本机草稿均已保留');
        if (await this.chapterFile(projectId, relative) !== file) throw new Error('章节路径已变化，草稿已保留，请重新打开');
        const final = await fs.stat(file);
        if (after.dev !== final.dev || after.ino !== final.ino || after.size !== final.size || after.mtimeMs !== final.mtimeMs || after.ctimeMs !== final.ctimeMs)
          throw new Error('保存期间文件发生变化，外部原稿和本机草稿均已保留');
      };
      if (isTxt) {
        validateDocument(request.content);
        const previous = await fs.readFile(file);
        if (digest(previous) !== expectedHash) throw new Error('文件已被其他程序修改，TXT 草稿已保存在本机恢复区');
        if (decodeText(previous).encoding !== 'utf-8') throw new Error('非 UTF-8 TXT 请另存副本，原文件保留');
        const previousStamp = `${Date.now()}-${randomUUID()}`;
        await this.writeRecovery(recovery, `${previousStamp}-previous.txt`, previous);
        await this.writeRecovery(recovery, `${previousStamp}-previous.meta.json`, JSON.stringify({ sourcePath: relative, at: new Date().toISOString(), bytes: previous.length }));
        if (digest(await fs.readFile(file)) !== expectedHash) throw new Error('TXT 文件保存期间发生变化');
        await this.recordState(projectId, digest(data), content);
        await this.atomic(file, data, beforeCommit);
        return { projectId, path: relative, hash: digest(data), content, managed: true, warnings: ['TXT 仅保存纯文本，排版样式不会写入文件。'] };
      }
      const previous = await fs.readFile(file);
      if (digest(previous) !== expectedHash) throw new Error('文件已被其他程序修改。当前草稿已保存在本机恢复区，请另存副本或重新打开');
      if (!await this.readState(projectId, expectedHash)) throw new Error('外部 DOCX 请另存副本，避免覆盖尚未支持的排版');
      const previousStamp = `${Date.now()}-${randomUUID()}`;
      await this.writeRecovery(recovery, `${previousStamp}-previous.docx`, previous);
      await this.writeRecovery(recovery, `${previousStamp}-previous.meta.json`, JSON.stringify({ sourcePath: relative, at: new Date().toISOString(), bytes: previous.length }));
      await this.recordState(projectId, digest(data), content);
      // 最终写入前再检查；文件同步系统仍可能发生竞争，NAS 阶段需保留冲突双方。
      let latest: Buffer;
      try { latest = await fs.readFile(file); }
      catch (error) { throw new Error(describeSaveFailure(error).message); }
      if (digest(latest) !== expectedHash) throw new Error('保存期间文件发生变化，草稿已保留');
      await this.atomic(file, data, beforeCommit);
      return { projectId, path: relative, hash: digest(data), content, managed: true, warnings: [] };
    });
  }

  async readNotes(projectId: string): Promise<NotesSnapshot> {
    if (this.materialsRoot) {
      this.project(projectId);
      const file = path.join(await materialDirectory(this.materialsRoot, projectId), '创作笔记.md');
      let raw = await readMarkdown(file);
      if (raw === null) {
        const legacy = await this.legacyNotes(projectId);
        const initial = notesMarkdown(legacy.value);
        await fs.writeFile(file, initial, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        raw = (await readMarkdown(file))!;
      }
      return { value: notesSchema.parse(parseNotesMarkdown(raw, projectId)), hash: digest(raw) };
    }
    return this.legacyNotes(projectId);
  }

  private async legacyNotes(projectId: string): Promise<NotesSnapshot> {
    const directory = await this.metadataDirectory(this.project(projectId));
    try {
      const raw = await fs.readFile(path.join(directory, 'notes.json'), 'utf8');
      const value = notesSchema.parse(JSON.parse(raw));
      if (value.projectId !== projectId) throw new Error('资料属于其他小说');
      return { value, hash: digest(raw) };
    } catch (e) {
      if (!absent(e)) throw e;
      return { value: { schemaVersion: 1, projectId, characters: '', world: '', preset: '', style: '' }, hash: '' };
    }
  }

  async saveNotes(projectId: string, input: ProjectNotes, expectedHash: string): Promise<NotesSnapshot> {
    return this.serial(async () => {
      const value = notesSchema.parse(input);
      if (value.projectId !== projectId) throw new Error('不能把资料写入另一部小说');
      if ((await this.readNotes(projectId)).hash !== expectedHash) throw new Error('资料已在外部修改，请保留本次文本并重新打开');
      if (this.materialsRoot) {
        const raw = notesMarkdown(value);
        await writeMarkdown(path.join(await materialDirectory(this.materialsRoot, projectId), '创作笔记.md'), raw, expectedHash);
        return { value, hash: digest(raw) };
      }
      const raw = JSON.stringify(value, null, 2);
      await this.atomic(path.join(await this.metadataDirectory(this.project(projectId)), 'notes.json'), raw);
      return { value, hash: digest(raw) };
    });
  }
}
