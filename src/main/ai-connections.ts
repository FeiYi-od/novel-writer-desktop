import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AIConnection, AIConnectionEdit, AIConnectionSnapshot } from '../shared/contracts';
import { keepPreviousCopy } from './key-recovery';

export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export interface SecretCodec { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export function normalizeBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入有效的 API 基础地址'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能含账号、密钥、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('远程 API 请使用 HTTPS；本机服务可使用 HTTP');
  url.pathname = url.pathname.replace(/\/(chat\/completions|messages|models)\/?$/, '').replace(/\/+$/, '');
  if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname === '/') url.pathname = '/v1beta';
  if (url.hostname === 'api.anthropic.com' && url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}
const fields = {
  adapter: z.enum(['generic', 'deepseek', 'qwen', 'gemini', 'anthropic', 'responses', 'ollama']).default('generic'), thinking: z.enum(['default', 'enabled', 'disabled']).default('default'), timeoutSeconds: z.number().int().min(30).max(1800).default(300),
  name: z.string().trim().min(1).max(100), baseUrl: z.string().max(2000).transform(normalizeBaseUrl),
  model: z.string().trim().min(1).max(200), contextWindow: z.number().int().min(512).max(2000000),
  maxOutputTokens: z.number().int().min(1).max(128000), tokenParameter: z.enum(['max_tokens', 'max_completion_tokens'])
};
const storedSchema = z.object({ schemaVersion: z.literal(1), connections: z.array(z.object({ id: z.uuid(), ...fields, encryptedKey: z.string().max(20000) })).max(50) });
const editSchema = z.object({ id: z.uuid().optional(), ...fields, apiKey: z.string().trim().max(4000).optional(), clearKey: z.boolean().optional() });

export class AIConnections {
  private queue: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(directory: string, private codec: SecretCodec) { this.file = path.join(directory, 'ai-connections.json'); }
  private async stored() {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { value: storedSchema.parse({ schemaVersion: 1, connections: [] }), hash: '' }; throw e; }
    try { return { value: storedSchema.parse(JSON.parse(raw)), hash: hashText(raw) }; }
    catch { throw new Error('AI 连接资料损坏或版本不支持，已保留原文件'); }
  }
  async read(): Promise<AIConnectionSnapshot> {
    const stored = await this.stored();
    return { hash: stored.hash, connections: stored.value.connections.map(({ encryptedKey, ...profile }) => ({
      ...profile,
      hasKey: !!encryptedKey,
      // A force-quit or an OS keyring reset leaves ciphertext we can no longer open; saying so here
      // keeps the UI from pretending the key is fine.
      keyState: !encryptedKey ? 'missing' : this.canDecrypt(encryptedKey) ? 'ok' : 'unreadable'
    })) };
  }
  private canDecrypt(encryptedKey: string) {
    try { this.codec.decrypt(Buffer.from(encryptedKey, 'base64')); return true; }
    catch { return false; }
  }
  async resolve(id: string): Promise<{ profile: AIConnection; key: string }> {
    const item = (await this.stored()).value.connections.find(p => p.id === id);
    if (!item) throw new Error('请先保存并选择模型连接');
    const { encryptedKey, ...profile } = item;
    let key = '';
    try { if (encryptedKey) key = this.codec.decrypt(Buffer.from(encryptedKey, 'base64')); }
    catch { throw new Error('本机无法解密此密钥，请重新填写后保存'); }
    return { profile: { ...profile, hasKey: !!encryptedKey }, key };
  }
  save(input: AIConnectionEdit, expectedHash: string): Promise<AIConnectionSnapshot> {
    const result = this.queue.then(async () => {
      const edit = editSchema.parse(input);
      if (['gemini', 'anthropic'].includes(edit.adapter) && edit.thinking !== 'default') throw new Error('原生协议当前使用模型默认思考，请选择按服务商默认');
      if (edit.maxOutputTokens + 256 >= edit.contextWindow) throw new Error('上下文窗口必须大于输出上限，并预留至少 256 token');
      const stored = await this.stored();
      if (stored.hash !== expectedHash) throw new Error('AI 连接已更新，请重新加载后编辑');
      const previous = stored.value.connections.find(p => p.id === edit.id);
      if (edit.id && !previous) throw new Error('模型连接不存在');
      // Changing the endpoint must never silently forward the old endpoint's credential.
      if (previous && (previous.baseUrl !== edit.baseUrl || previous.adapter !== edit.adapter) && previous.encryptedKey && !edit.apiKey && !edit.clearKey) throw new Error('更换 API 地址或协议时请重新填写密钥，或勾选清除密钥');
      const { apiKey, clearKey, ...profile } = edit;
      const encryptedKey = apiKey ? this.codec.encrypt(apiKey).toString('base64') : clearKey ? '' : previous?.encryptedKey ?? '';
      const item = { ...profile, id: previous?.id ?? randomUUID(), encryptedKey };
      const value = storedSchema.parse({ schemaVersion: 1, connections: previous ? stored.value.connections.map(p => p.id === item.id ? item : p) : [...stored.value.connections, item] });
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
        if ((await this.stored()).hash !== expectedHash) throw new Error('AI 连接文件在保存期间被修改');
        await keepPreviousCopy(this.file);
        await fs.rename(temp, this.file);
      } finally { await fs.rm(temp, { force: true }); }
      return this.read();
    });
    this.queue = result.catch(() => {}); return result;
  }
}
