import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoryFact, StoryFactEdit, StoryMemoryEntry, StoryMemorySnapshot } from '../shared/contracts';
import type { Workspace } from './workspace';
import { materialDirectory, metadata, readMarkdown, readSection, safeJson, section, writeMarkdown } from './markdown-materials';
import { hashText } from './ai-connections';
const entrySchema = z.object({ id: z.uuid(), projectId: z.uuid(), sourcePath: z.string().min(1).max(2000), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().trim().min(1).max(10000), taskId: z.uuid(), model: z.string().max(300), createdAt: z.string(), enabled: z.boolean(), important: z.boolean() });
const factSchema = z.object({ id: z.uuid(), projectId: z.uuid(), kind: z.enum(['fact', 'foreshadow']), text: z.string().trim().min(1).max(2000),
  sourcePath: z.string().min(1).max(2000).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), state: z.enum(['open', 'resolved']), enabled: z.boolean(), createdAt: z.string() })
  .refine(value => (value.sourcePath === undefined) === (value.sourceHash === undefined), { message: '事实来源与版本必须成对保存' });
const storySchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid(), budgetBytes: z.number().int().min(500).max(20000), entries: z.array(entrySchema).max(200), facts: z.array(factSchema).max(200).optional() });
export class StoryMemoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private workspace: Workspace, private root: string) {}
  private async file(id: string) { this.workspace.getProject(z.uuid().parse(id)); return path.join(await materialDirectory(this.root, id), '故事记忆.md'); }
  async read(id: string): Promise<StoryMemorySnapshot> {
    const raw = await readMarkdown(await this.file(id));
    if (raw === null) return { value: { schemaVersion: 1, projectId: id, budgetBytes: 6000, entries: [], facts: [] }, hash: '', staleIds: [] };
    const meta = metadata(raw, 'memory', id);
    if (!Array.isArray(meta.entries) || meta.entries.length > 200) throw new Error('故事记忆索引无效');
    const value = storySchema.parse({ ...meta, facts: Array.isArray(meta.facts) ? meta.facts : [], entries: meta.entries.map((entry: StoryMemoryEntry) => ({ ...entry, content: readSection(raw, entry.id) })) }) as StoryMemorySnapshot['value'];
    if (value.entries.some(e => e.projectId !== id) || new Set(value.entries.map(e => e.id)).size !== value.entries.length) throw new Error('故事记忆小说归属或 ID 不匹配');
    const originalPaths = JSON.stringify(value.entries.map(e => e.sourcePath));
    value.entries = await Promise.all(value.entries.map(async entry => ({ ...entry, sourcePath: await this.workspace.resolveChapterPath(id, entry.sourcePath) })));
    const pathsChanged = JSON.stringify(value.entries.map(e => e.sourcePath)) !== originalPaths;
    const hashes = new Map<string, string>();
    for (const source of new Set(value.entries.map(e => e.sourcePath))) { try { hashes.set(source, await this.workspace.chapterHash(id, source)); } catch { hashes.set(source, ''); } }
    return { value, hash: hashText(pathsChanged ? raw + ':paths:' + JSON.stringify(value.entries.map(e => e.sourcePath)) : raw), staleIds: value.entries.filter(e => hashes.get(e.sourcePath) !== e.sourceHash).map(e => e.id) };
  }
  private async save(id: string, value: StoryMemorySnapshot['value'], expectedHash: string) {
    storySchema.parse(value);
    if (value.projectId !== id || value.entries.some(e => e.projectId !== id) || value.facts.some(f => f.projectId !== id)) throw new Error('故事记忆不能跨小说保存');
    const { entries, ...meta } = value;
    const raw = `<!-- novel-writer ${safeJson({ ...meta, kind: 'memory', entries: entries.map(({ content, ...entry }) => entry) })} -->\n# 故事记忆\n\n` + entries.map(entry => section(entry.id, `章节摘要：${entry.sourcePath}`, entry.content)).join('\n');
    const file = await this.file(id); const previous = await readMarkdown(file);
    if ((await this.read(id)).hash !== expectedHash) throw new Error('故事记忆已更新，请重新读取');
    await writeMarkdown(file, raw, previous === null ? '' : hashText(previous)); return this.read(id);
  }
  add(id: string, entry: StoryMemoryEntry, expectedHash: string) {
    return this.serial(async () => {
      const current = await this.read(id); const next = entrySchema.parse(entry);
      next.sourcePath = await this.workspace.resolveChapterPath(id, next.sourcePath);
      if (next.projectId !== id) throw new Error('故事记忆不能跨小说保存');
      if (current.value.entries.some(e => e.taskId === next.taskId)) throw new Error('此摘要任务已经确认，不能重复入库');
      if (await this.workspace.chapterHash(id, next.sourcePath) !== next.sourceHash) throw new Error('摘要原文已变化，请重新生成');
      return this.save(id, { ...current.value, entries: [...current.value.entries.map(e => e.sourcePath === next.sourcePath ? { ...e, enabled: false } : e), next] }, expectedHash);
    });
  }

  /** 批量删除章节摘要条目：一次校验、一次写入；不存在或重复的 ID 直接拒绝，不静默跳过。 */
  removeEntries(id: string, entryIds: string[], expectedHash: string) {
    const ids = z.array(z.uuid()).min(1).max(200).parse(entryIds);
    return this.serial(async () => {
      const current = await this.read(id);
      if (new Set(ids).size !== ids.length) throw new Error('要删除的摘要不能重复');
      const missing = ids.filter(entryId => !current.value.entries.some(entry => entry.id === entryId));
      if (missing.length) throw new Error('有 ' + missing.length + ' 条摘要不存在或已被删除，请刷新后重试');
      return this.save(id, { ...current.value, entries: current.value.entries.filter(entry => !ids.includes(entry.id)) }, expectedHash);
    });
  }
  update(id: string, entryId: string, enabled: boolean, important: boolean, expectedHash: string) {
    z.uuid().parse(entryId); z.boolean().parse(enabled); z.boolean().parse(important);
    return this.serial(async () => {
      const current = await this.read(id); if (!current.value.entries.some(e => e.id === entryId)) throw new Error('本书未找到此摘要');
      if (enabled && current.staleIds.includes(entryId)) throw new Error('原文已变化，旧摘要不能启用');
      const target = current.value.entries.find(e => e.id === entryId)!;
      return this.save(id, { ...current.value, entries: current.value.entries.map(e => e.id === entryId ? { ...e, enabled, important } : enabled && e.sourcePath === target.sourcePath ? { ...e, enabled: false } : e) }, expectedHash);
    });
  }
  async context(id: string) {
    const snapshot = await this.read(id); const valid = snapshot.value.entries.filter(e => e.enabled && !snapshot.staleIds.includes(e.id)).sort((a, b) => Number(b.important) - Number(a.important) || b.createdAt.localeCompare(a.createdAt));
    const included: string[] = []; let bytes = 0;
    // Author facts come first: they are short, explicit and required for continuity.
    for (const fact of snapshot.value.facts.filter(fact => fact.enabled)) {
      const label = fact.kind === 'fact' ? '作者确认事实' : fact.state === 'open' ? '未解决伏笔' : '已解决伏笔';
      const text = `${label}：${fact.text}${fact.sourcePath ? `（来源：${fact.sourcePath}）` : ''}`; const size = Buffer.byteLength(text) + 2;
      if (bytes + size > snapshot.value.budgetBytes) continue;
      bytes += size; included.push(text);
    }
    for (const entry of valid) {
      const text = `已确认章节摘要（${entry.sourcePath}）：\n${entry.content}`; const size = Buffer.byteLength(text) + 2;
      if (bytes + size > snapshot.value.budgetBytes) continue;
      bytes += size; included.push(text);
    }
    return included.join('\n\n');
  }
  /** Author-maintained facts and foreshadowing. They are never derived from a model, and a
   * foreshadowing item stays "open" until the author resolves it. */
  saveFact(id: string, edit: StoryFactEdit, expectedHash: string) {
    return this.serial(async () => {
      const input = z.object({ id: z.uuid().optional(), kind: z.enum(['fact', 'foreshadow']), text: z.string().trim().min(1).max(2000),
        sourcePath: z.string().min(1).max(2000).optional(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        state: z.enum(['open', 'resolved']).optional(), enabled: z.boolean().optional() })
        .refine(value => (value.sourcePath === undefined) === (value.sourceHash === undefined), { message: '事实来源必须同时提供路径与版本' }).parse(edit);
      if (input.sourcePath && input.sourceHash && await this.workspace.chapterHash(id, await this.workspace.resolveChapterPath(id, input.sourcePath)) !== input.sourceHash)
        throw new Error('事实来源章节已变化，请重新选择当前版本');
      const current = await this.read(id);
      if (current.hash !== expectedHash) throw new Error('故事记忆已更新，请重新读取');
      const existing = input.id ? current.value.facts.find(fact => fact.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('本书未找到这条事实');
      if (!input.id && current.value.facts.length >= 200) throw new Error('本书事实与伏笔已达 200 条上限，请先整理旧条目');
      const next: StoryFact = { id: existing?.id ?? randomUUID(), projectId: id, kind: input.kind, text: input.text,
        ...(input.sourcePath && input.sourceHash ? { sourcePath: input.sourcePath, sourceHash: input.sourceHash } : {}),
        state: input.state ?? existing?.state ?? 'open', enabled: input.enabled ?? existing?.enabled ?? true, createdAt: existing?.createdAt ?? new Date().toISOString() };
      return this.save(id, { ...current.value, facts: existing ? current.value.facts.map(fact => fact.id === next.id ? next : fact) : [...current.value.facts, next] }, expectedHash);
    });
  }
  removeFact(id: string, factId: string, expectedHash: string) {
    z.uuid().parse(factId);
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current.value.facts.some(fact => fact.id === factId)) throw new Error('本书未找到这条事实');
      if (current.hash !== expectedHash) throw new Error('故事记忆已更新，请重新读取');
      return this.save(id, { ...current.value, facts: current.value.facts.filter(fact => fact.id !== factId) }, expectedHash);
    });
  }
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
}
