import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { COMPRESSION, discussionPrompt, discussionRequestTokens, normalizeSummary, planCompression, type DiscussionMessage } from '../core/discussion';
import type { ChatMessage } from './ai-provider';
import type { Workspace } from './workspace';

export interface DiscussionSnapshot { messages: DiscussionMessage[]; hash: string; updatedAt: string }
const messageSchema = z.object({ id: z.uuid(), role: z.enum(['user', 'assistant', 'system']), content: z.string().max(1024 * 1024), at: z.string(), compressedInto: z.uuid().optional() }).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), projectId: z.uuid().optional(), messages: z.array(messageSchema).max(20000), updatedAt: z.string() }).strict();
/** Conversation history is append-only: compression only marks messages and adds a summary, so the
 * author can always unfold what was said. */
export class DiscussionStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly workspace: Workspace) {}
  private serial<T>(action: () => Promise<T>) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  private async file(projectId: string) {
    const project = this.workspace.getProject(projectId);
    const directory = path.join(project.root, '小说资料');
    await fs.mkdir(directory, { recursive: true });
    const relative = path.relative(await fs.realpath(project.root), await fs.realpath(directory));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('讨论目录越界，已保留原始记录');
    const file = path.join(directory, '讨论记录.json');
    const stat = await fs.lstat(file).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024)) throw new Error('讨论记录不是受支持的普通文件或过大，请保留原件并检查');
    return file;
  }
  async read(projectId: string): Promise<DiscussionSnapshot> {
    const file = await this.file(projectId);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = snapshotSchema.parse(JSON.parse(raw));
      if (parsed.projectId && parsed.projectId !== projectId) throw new Error('讨论记录不属于本书，已保留原件');
      const ids = new Map(parsed.messages.map(message => [message.id, message]));
      if (ids.size !== parsed.messages.length || parsed.messages.some(message => message.compressedInto && (message.compressedInto === message.id || ids.get(message.compressedInto)?.role !== 'system')))
        throw new Error('讨论压缩关系不匹配，已保留原始记录');
      return { messages: parsed.messages, updatedAt: parsed.updatedAt, hash: createHash('sha256').update(raw).digest('hex') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { messages: [], updatedAt: '', hash: '' };
      throw error;
    }
  }
  private async write(projectId: string, messages: DiscussionMessage[], expectedHash: string) {
    const file = await this.file(projectId);
    if ((await this.read(projectId)).hash !== expectedHash) throw new Error('讨论记录已在外部变化，请重新载入');
    const updatedAt = new Date().toISOString();
    const temporary = `${file}.${randomUUID()}.tmp`;
    const data = snapshotSchema.parse({ schemaVersion: 1, projectId, updatedAt, messages });
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx' });
      if ((await this.read(projectId)).hash !== expectedHash) throw new Error('讨论记录已在外部变化，请保留双方内容并重新载入');
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return this.read(projectId);
  }
  async append(projectId: string, input: { role: DiscussionMessage['role']; content: string }, expectedHash: string) {
    return this.serial(async () => {
      const snapshot = await this.read(projectId);
      if (snapshot.hash !== expectedHash) throw new Error('讨论记录已在外部变化，请重新载入');
      const content = input.content.trim();
      if (!content) throw new Error('消息内容为空');
      const message: DiscussionMessage = { id: randomUUID(), role: input.role, content, at: new Date().toISOString() };
      return this.write(projectId, [...snapshot.messages, message], snapshot.hash);
    });
  }
  /** Marks the given messages as compressed and inserts one summary right after them. */
  async compress(projectId: string, input: { ids: string[]; summary: string }, expectedHash: string) {
    return this.serial(async () => {
      const snapshot = await this.read(projectId);
      if (snapshot.hash !== expectedHash) throw new Error('讨论记录已在外部变化，请重新载入');
      const ids = new Set(input.ids);
      const target = snapshot.messages.filter(message => ids.has(message.id));
      if (!target.length) throw new Error('没有可压缩的消息');
      if (ids.size !== input.ids.length || target.length !== ids.size || target.some(message => message.compressedInto)) throw new Error('压缩来源已变化，请重新选择尚未压缩的讨论');
      const summary: DiscussionMessage = { id: randomUUID(), role: 'system', content: normalizeSummary(input.summary), at: new Date().toISOString() };
      const lastIndex = Math.max(...snapshot.messages.map((message, index) => ids.has(message.id) ? index : -1));
      const next = snapshot.messages.map(message => ids.has(message.id) ? { ...message, compressedInto: summary.id } : message);
      next.splice(lastIndex + 1, 0, summary);
      return this.write(projectId, next, snapshot.hash);
    });
  }
  /** 一次对话：先判断占用，必要时把旧消息压成摘要，再带着摘要与最近消息请求模型。 */
  async ask(projectId: string, input: { text: string; system?: string; contextWindow: number; maxOutputTokens?: number; stream: (messages: ChatMessage[], onText: (chunk: string) => void) => Promise<string> }) {
    // Freeze caller-owned request fields before waiting for another discussion operation.
    const { text: source, system, contextWindow, stream } = input;
    const reserveTokens = input.maxOutputTokens ?? COMPRESSION.reserveTokens;
    return this.serial(async () => {
      const snapshot = await this.read(projectId);
      const text = source.trim();
      if (!text) throw new Error('请先写点内容再发送');
      const options = { reserveTokens, newText: text, system };
      // Validate reservations even for an empty history, before any paid HTTP.
      planCompression([], contextWindow, options);
      const assertBudget = (messages: ChatMessage[]) => {
        if (discussionRequestTokens(messages) + reserveTokens > contextWindow) throw new Error('本次讨论超过模型保守上下文预算，请缩短新问题、系统提示或调整模型窗口；原文已保留');
      };
      assertBudget(discussionPrompt([], text, system));
      let current = structuredClone(snapshot);
      let compressed = 0;
      for (let attempt = 0; ; attempt++) {
        const plan = planCompression(current.messages, contextWindow, options);
        if (!plan.needed) break;
        if (attempt >= 12 || !plan.compressIds.length) throw new Error('旧讨论无法在模型上下文预算内安全压缩，原文未修改；请改用更大窗口或先手工整理');
        assertBudget(plan.summaryPrompt);
        if ((await this.read(projectId)).hash !== snapshot.hash) throw new Error('讨论记录已在外部变化，已停止后续模型请求，请重新载入');
        let summary = '';
        const finish = await stream(plan.summaryPrompt as ChatMessage[], chunk => { summary += chunk; });
        if (finish !== 'stop') throw new Error('压缩摘要未完整结束，原始讨论未修改，未继续请求回答');
        const normalized = normalizeSummary(summary);
        const next = (() => {
          const ids = new Set(plan.compressIds);
          const entry: DiscussionMessage = { id: randomUUID(), role: 'system', content: normalized, at: new Date().toISOString() };
          const lastIndex = Math.max(...current.messages.map((message, index) => ids.has(message.id) ? index : -1));
          const next = current.messages.map(message => ids.has(message.id) ? { ...message, compressedInto: entry.id } : message);
          next.splice(lastIndex + 1, 0, entry);
          return next;
        })();
        if (discussionRequestTokens(discussionPrompt(next, text, system)) >= plan.usedTokens)
          throw new Error('压缩摘要未减少上下文占用，原始讨论未修改；请调整模型或手工整理');
        current = { ...current, messages: next };
        compressed += plan.compressIds.length;
      }
      const messages = discussionPrompt(current.messages, text, system);
      assertBudget(messages);
      // All summaries are complete and every source remains present. Commit once,
      // so a later failed compression never leaves half of this attempt marked.
      const userMessage: DiscussionMessage = { id: randomUUID(), role: 'user', content: text, at: new Date().toISOString() };
      current = await this.write(projectId, [...current.messages, userMessage], current.hash);
      let reply = '';
      if ((await this.read(projectId)).hash !== current.hash) throw new Error('讨论记录已在外部变化，已停止模型请求，请重新载入');
      const finish = await stream(messages, chunk => { reply += chunk; });
      const assistant: DiscussionMessage = { id: randomUUID(), role: 'assistant', content: (reply.trim() || '（模型没有返回内容）') + (finish === 'stop' ? '' : `\n（本次回答未完整结束：${finish || '未知'}）`), at: new Date().toISOString() };
      current = await this.write(projectId, [...current.messages, assistant], current.hash);
      return { snapshot: current, compressed, finish };
    });
  }
  /** 原文永远可展开：给出某条摘要覆盖的原始消息。 */
  async expand(projectId: string, summaryId: string) {
    const snapshot = await this.read(projectId);
    return snapshot.messages.filter(message => message.compressedInto === summaryId);
  }
}
