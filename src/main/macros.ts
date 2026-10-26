import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MacroEnv, RegexScript } from '../core/st-macros';
import type { MacroContext, MacroPreviewResult, MacroImportResult } from '../shared/macros';
import type { Workspace } from './workspace';
import { REGEX_PREVIEW_LIMITS, type RegexPreviewRunner } from './regex-preview';
import { analyzeRegexImport } from './regex-import';

export type { MacroContext } from '../shared/macros';
const MAX_BYTES = REGEX_PREVIEW_LIMITS.payloadBytes;
const contextSchema = z.object({ characterName: z.string().max(512).optional(), userName: z.string().max(512).optional(), lastMessage: z.string().max(20000).optional() }).strict();
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const same = (left: string, right: string) => path.relative(left, right) === '';
type Stat = Awaited<ReturnType<typeof fs.lstat>>;
const identity = (stat: Stat) => ({ dev: stat.dev, ino: stat.ino });
const fileIdentity = (stat: Stat) => ({ ...identity(stat), size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
interface Snapshot { projectId: string; root: string; directory: string; file: string; raw: Buffer | null; scripts: RegexScript[]; fingerprint: string }
interface PreviewJob { projectId: string; requestId: string; controller: AbortController }
type EnterShared = <T>(action: () => Promise<T>) => Promise<T>;

/** Book-scoped script data only. Preview computation runs in a terminable worker. */
export class MacroStore {
  private readonly jobs = new Map<string, PreviewJob>();
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(private readonly workspace: Workspace, private readonly runner: RegexPreviewRunner,
    private readonly enterShared: EnterShared = action => Promise.resolve().then(action)) {}
  private async directory(directory: string, create = false): Promise<Stat | null> {
    let stat: Stat;
    try { stat = await fs.lstat(directory); }
    catch (error) {
      if (!absent(error)) throw error;
      if (!create) return null;
      await fs.mkdir(directory).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; });
      stat = await fs.lstat(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(directory, await fs.realpath(directory))) throw new Error('正则资料目录不能使用链接或越界路径');
    return stat;
  }
  private async locations(projectId: string, create = false) {
    const project = { ...this.workspace.getProject(z.uuid().parse(projectId)) };
    const root = await this.directory(project.root);
    if (!root) throw new Error('正则脚本所属小说目录不存在');
    const directory = path.join(project.root, '小说资料'), meta = await this.directory(directory, create);
    const record = await this.regular(path.join(directory, 'project.json'));
    let book: { schemaVersion?: unknown; id?: unknown };
    try { book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.raw ?? Buffer.alloc(0))); } catch { throw new Error('小说归属记录缺失或损坏，正则操作已停止'); }
    if (book?.schemaVersion !== 1 || book.id !== projectId) throw new Error('小说目录归属或版本已变化，正则操作已停止');
    return { projectId, root: project.root, directory, file: path.join(directory, '正则脚本.json'), rootIdentity: identity(root), metaIdentity: meta ? identity(meta) : null,
      bookIdentity: hash(JSON.stringify({ stamp: record.stamp, sha256: hash(record.raw!) })) };
  }
  private async regular(file: string) {
    let before: Stat | null = null;
    try { before = await fs.lstat(file); } catch (error) { if (!absent(error)) throw error; }
    let raw: Buffer | null = null;
    if (before) {
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES || !same(file, await fs.realpath(file))) throw new Error('正则资料不能使用链接或超过1 MiB的文件');
      const handle = await fs.open(file, 'r');
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || JSON.stringify(fileIdentity(opened)) !== JSON.stringify(fileIdentity(before))) throw new Error('正则脚本读取前已变化');
        const chunks: Buffer[] = []; let total = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          total += chunk.length; if (total > MAX_BYTES) throw new Error('正则脚本读取期间超过1 MiB'); chunks.push(Buffer.from(chunk));
        }
        if (total !== opened.size || JSON.stringify(fileIdentity(await handle.stat())) !== JSON.stringify(fileIdentity(opened))) throw new Error('正则脚本读取期间已变化');
        raw = Buffer.concat(chunks);
      } finally { await handle.close(); }
    }
    let after: Stat | null = null;
    try { after = await fs.lstat(file); } catch (error) { if (!absent(error)) throw error; }
    if (JSON.stringify(after ? fileIdentity(after) : null) !== JSON.stringify(before ? fileIdentity(before) : null) || after?.isSymbolicLink()) throw new Error('正则脚本读取期间已变化');
    return { raw, stamp: after ? fileIdentity(after) : null };
  }
  private async snapshot(projectId: string): Promise<Snapshot> {
    const location = await this.locations(projectId), { raw, stamp } = await this.regular(location.file);
    const latest = await this.locations(projectId);
    if (JSON.stringify(latest) !== JSON.stringify(location)) throw new Error('正则资料目录或小说归属已变化');
    let scripts: RegexScript[] = [];
    if (raw !== null) {
      let json: unknown;
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw new Error('正则脚本不是有效UTF-8 JSON，原文件保持不变'); }
      scripts = analyzeRegexImport(json, projectId).scripts;
    }
    return { ...location, raw, scripts, fingerprint: hash(JSON.stringify({ location, file: stamp, sha256: raw === null ? null : hash(raw) })) };
  }
  async read(projectId: string): Promise<RegexScript[]> { return (await this.snapshot(projectId)).scripts; }
  private async preserveSource(projectId: string, bytes: Buffer, analysis: ReturnType<typeof analyzeRegexImport>) {
    const initial = await this.locations(projectId), base = path.join(initial.directory, '正则导入原件');
    await this.directory(base, true);
    const copyId = randomUUID(), directory = path.join(base, copyId); await fs.mkdir(directory);
    const file = path.join(directory, '原始正则.json'), manifestFile = path.join(directory, 'manifest.json');
    const sha256 = hash(bytes);
    const directoryIdentities = async () => Promise.all([base, directory].map(async folder => {
      const stat = await this.directory(folder); if (!stat) throw new Error('正则导入原件目录缺失'); return identity(stat);
    }));
    const expectedDirectories = JSON.stringify(await directoryIdentities());
    await fs.writeFile(file, bytes, { flag: 'wx' });
    const source = await this.regular(file);
    if (!source.raw?.equals(bytes)) throw new Error('正则导入原件暂存已变化，未替换活动脚本');
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'regex-import-source', projectId, copyId,
      createdAt: new Date().toISOString(), format: analysis.format, file: '原始正则.json', bytes: bytes.length, sha256,
      scripts: analysis.scripts.length, unsupportedFields: analysis.unsupportedFields, unsupportedFieldCount: analysis.unsupportedFieldCount }, null, 2));
    if (JSON.stringify(await this.locations(projectId)) !== JSON.stringify(initial) || JSON.stringify(await directoryIdentities()) !== expectedDirectories)
      throw new Error('正则导入原件的小说或目录已变化，未替换活动脚本');
    const rechecked = await this.regular(file);
    if (!rechecked.raw?.equals(bytes) || JSON.stringify(rechecked.stamp) !== JSON.stringify(source.stamp)) throw new Error('正则导入原件已变化，未发布原件清单');
    // This record describes a source copy, never success of the later active-file swap.
    await fs.writeFile(manifestFile, manifest, { flag: 'wx' });
    const savedManifest = await this.regular(manifestFile);
    const verify = async () => {
      if (JSON.stringify(await this.locations(projectId)) !== JSON.stringify(initial) || JSON.stringify(await directoryIdentities()) !== expectedDirectories)
        throw new Error('正则导入原件的小说或目录已变化，活动脚本保持不变');
      const currentSource = await this.regular(file), currentManifest = await this.regular(manifestFile);
      if (!currentSource.raw?.equals(bytes) || JSON.stringify(currentSource.stamp) !== JSON.stringify(source.stamp)
        || !currentManifest.raw?.equals(manifest) || JSON.stringify(currentManifest.stamp) !== JSON.stringify(savedManifest.stamp))
        throw new Error('正则导入原件或清单已变化，活动脚本保持不变');
    };
    await verify();
    return { file, sha256, verify };
  }
  async import(projectId: string, json: unknown) {
    const id = z.uuid().parse(projectId); this.workspace.getProject(id);
    return (await this.writeImport(id, analyzeRegexImport(json, id))).scripts;
  }
  async importBytes(projectId: string, input: Uint8Array): Promise<MacroImportResult> {
    const id = z.uuid().parse(projectId); this.workspace.getProject(id);
    if (!(input instanceof Uint8Array) || input.byteLength > MAX_BYTES) throw new Error('正则导入原件无效或超过1 MiB');
    const bytes = Buffer.from(input);
    let json: unknown; try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('正则导入文件不是有效UTF-8 JSON'); }
    const analysis = analyzeRegexImport(json, id), saved = await this.writeImport(id, analysis, bytes);
    if (!saved.source) throw new Error('正则导入未保留原件');
    return { schemaVersion: 1, projectId: id, count: saved.scripts.length, format: analysis.format,
      unsupportedFields: analysis.unsupportedFields, unsupportedFieldCount: analysis.unsupportedFieldCount,
      sourceFile: saved.source.file, sourceSha256: saved.source.sha256 };
  }
  private async writeImport(id: string, analysis: ReturnType<typeof analyzeRegexImport>, sourceBytes?: Buffer) {
    const scripts = analysis.scripts;
    if (!scripts.length) throw new Error('这份文件里没有正则脚本');
    const raw = Buffer.from(JSON.stringify({ schemaVersion: 1, projectId: id, scripts }, null, 2));
    if (raw.length > MAX_BYTES) throw new Error('正则脚本文件超过1 MiB，原文件保持不变');
    const previous = this.writes.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const before = await this.snapshot(id), location = await this.locations(id, true);
      if (location.root !== before.root) throw new Error('正则脚本所属小说目录已变化');
      const source = sourceBytes ? await this.preserveSource(id, sourceBytes, analysis) : null;
      const temporary = path.join(location.directory, `.正则脚本-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, raw, { flag: 'wx' });
      const staged = await this.regular(temporary);
      if (!staged.raw?.equals(raw)) throw new Error('正则脚本暂存已变化，原文件保持不变');
      if (before.raw !== null) {
        const history = path.join(location.directory, '正则脚本历史'); await this.directory(history, true);
        await fs.writeFile(path.join(history, `${Date.now()}-${randomUUID()}.json`), before.raw, { flag: 'wx' });
      }
      if (source) await source.verify();
      const latest = await this.snapshot(id);
      if (latest.fingerprint !== before.fingerprint) throw new Error('正则脚本保存期间已在外部变化，原件、历史和暂存均保留');
      const target = await this.locations(id);
      if (JSON.stringify(target) !== JSON.stringify(location)) throw new Error('正则资料目录保存期间已变化，暂存已保留');
      if (source) {
        // Reading the current active file can overlap an external edit of the
        // retained source. Recheck the copy, then the active version again.
        await source.verify();
        if ((await this.snapshot(id)).fingerprint !== before.fingerprint) throw new Error('正则脚本保存期间已在外部变化，原件、历史和暂存均保留');
      }
      const finalStaged = await this.regular(temporary);
      if (!finalStaged.raw?.equals(raw) || JSON.stringify(finalStaged.stamp) !== JSON.stringify(staged.stamp)) throw new Error('正则脚本暂存已变化，原件与历史已保留');
      if (!before.raw) { await fs.link(temporary, location.file); await fs.unlink(temporary); }
      else await fs.rename(temporary, location.file);
      return { scripts, source };
    });
    this.writes.set(id, operation);
    void operation.finally(() => { if (this.writes.get(id) === operation) this.writes.delete(id); }).catch(() => {});
    return operation;
  }
  cancel(projectId: string, requestId: string): boolean {
    const id = z.uuid().parse(projectId), request = z.uuid().parse(requestId); this.workspace.getProject(id);
    const job = this.jobs.get(`${id}:${request}`);
    if (!job || job.controller.signal.aborted) return false;
    job.controller.abort(); return true;
  }
  async preview(projectId: string, text: string, context: MacroContext = {}, requestId?: string): Promise<MacroPreviewResult> {
    const id = z.uuid().parse(projectId), request = requestId === undefined ? randomUUID() : z.uuid().parse(requestId);
    this.workspace.getProject(id);
    const input = z.string().max(REGEX_PREVIEW_LIMITS.inputCharacters, '预览文本不能超过20000字符').parse(text), frozenContext = contextSchema.parse(structuredClone(context));
    if ([...this.jobs.values()].some(job => job.projectId === id)) throw new Error('本书已有正则预览，请先取消或等待完成');
    if (this.jobs.size >= 8) throw new Error('等待中的正则预览过多，请稍后重试');
    const job: PreviewJob = { projectId: id, requestId: request, controller: new AbortController() }, key = `${id}:${request}`;
    this.jobs.set(key, job);
    const assertActive = () => { if (job.controller.signal.aborted) throw new Error('正则预览已取消，未返回部分结果'); };
    try {
      return await this.enterShared(async () => {
        assertActive();
        const [notes, source] = await Promise.all([this.workspace.readNotes(id).catch(() => null), this.snapshot(id)]);
        assertActive();
        const character = frozenContext.characterName ?? '';
        const env: MacroEnv = { char: character, user: frozenContext.userName ?? '作者', description: '', personality: '', scenario: '', persona: '', mesExamples: '',
          lastMessage: frozenContext.lastMessage ?? '', original: input, seed: `${id}:${character}` };
        const value = await this.runner.run({ projectId: id, requestId: request, text: input, scripts: source.scripts, env }, job.controller.signal);
        assertActive();
        if (value.projectId !== id || value.requestId !== request) throw new Error('正则预览结果的小说或请求标识不匹配');
        if ((await this.snapshot(id)).fingerprint !== source.fingerprint) throw new Error('正则脚本或小说目录在预览期间已变化，请重新预览');
        assertActive();
        return { schemaVersion: 1, projectId: id, requestId: request, sourceHash: source.fingerprint,
          expanded: value.expanded, applied: value.applied, scripts: source.scripts.length, notesPresent: Boolean(notes?.value.preset || notes?.value.world) };
      });
    } finally { if (this.jobs.get(key) === job) this.jobs.delete(key); }
  }
}
