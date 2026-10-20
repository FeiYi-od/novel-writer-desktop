import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashText, normalizeBaseUrl, type SecretCodec } from './ai-connections';
import { astrbotTemplates } from '../shared/model-presets';
import type { AuxiliaryModelEdit, AuxiliaryModelSnapshot } from '../shared/contracts';

const kind = z.enum(['embedding', 'rerank']);
const parameters = z.record(z.string().min(1).max(100), z.union([z.string().max(4000), z.number().finite(), z.boolean()]));
const fields = { kind, name: z.string().trim().min(1).max(100), type: z.string().min(1).max(100), parameters };
const storedSchema = z.object({ schemaVersion: z.literal(1), connections: z.array(z.object({ id: z.uuid(), ...fields, encryptedKey: z.string().max(20000) }).strict()).max(100) }).strict();
const editSchema = z.object({ id: z.uuid().optional(), ...fields, apiKey: z.string().trim().max(4000).optional(), clearKey: z.boolean().optional() }).strict();
const base = (p: Record<string, unknown>) => Object.entries(p).find(([k]) => k.endsWith('api_base'))?.[1];

export class AuxiliaryModels {
  private file: string; private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string, private codec: SecretCodec) { this.file = path.join(directory, 'auxiliary-models.json'); }
  private async stored() {
    try { const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('资料类型或大小不受支持'); const raw = await fs.readFile(this.file, 'utf8'); return { value: storedSchema.parse(JSON.parse(raw)), hash: hashText(raw) }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { value: storedSchema.parse({ schemaVersion: 1, connections: [] }), hash: '' }; throw new Error('嵌入/重排序配置损坏或版本不支持，原件保留'); }
  }
  async read(): Promise<AuxiliaryModelSnapshot> { const { value, hash } = await this.stored(); return { hash, connections: value.connections.map(({ encryptedKey, ...c }) => ({ ...c, hasKey: !!encryptedKey })) }; }
  async resolve(id: string, expectedHash: string) {
    z.uuid().parse(id); const stored = await this.stored();
    if (stored.hash !== expectedHash) throw new Error('嵌入/重排序配置已更新，请重新读取');
    const item = stored.value.connections.find(c => c.id === id); if (!item) throw new Error('模型配置不存在');
    const { encryptedKey, ...value } = item; let key = '';
    try { if (encryptedKey) key = this.codec.decrypt(Buffer.from(encryptedKey, 'base64')); } catch { throw new Error('本机无法解密密钥，请重新填写'); }
    return { profile: { ...value, hasKey: !!encryptedKey }, key };
  }
  save(input: AuxiliaryModelEdit, expectedHash: string): Promise<AuxiliaryModelSnapshot> {
    const result = this.queue.then(async () => {
      const edit = editSchema.parse(input), template = astrbotTemplates.find(t => t.type === edit.type && t.provider_type === edit.kind);
      if (!template) throw new Error('请选对应类别的AstrBot嵌入/重排序协议');
      const allowed = new Set(Object.keys(template).filter(k => /api_base$|model$|dimensions|dimensions_mode|^timeout$|^input_type$|api_suffix$|model_endpoint$|^return_documents$|^instruct$|^.*truncate$|^tei_rerank_(truncation_direction|raw_scores|return_text)$/.test(k)));
      if (Object.keys(edit.parameters).some(k => !allowed.has(k))) throw new Error('配置包含未支持的参数或凭据字段');
      const baseEntry = Object.entries(edit.parameters).find(([k]) => k.endsWith('api_base'));
      if (!baseEntry || typeof baseEntry[1] !== 'string' || !baseEntry[1]) throw new Error('请填写嵌入/重排序接口地址');
      edit.parameters[baseEntry[0]] = normalizeBaseUrl(baseEntry[1]);
      if (typeof edit.parameters.timeout !== 'number' || !Number.isInteger(edit.parameters.timeout) || edit.parameters.timeout < 1 || edit.parameters.timeout > 1800) throw new Error('请求超时须为1至1800秒');
      const model = Object.entries(edit.parameters).find(([k]) => k.endsWith('_model'))?.[1];
      if (edit.kind === 'embedding' && (typeof model !== 'string' || !model.trim())) throw new Error('请填写嵌入模型名称');
      const dimensions = edit.parameters.embedding_dimensions;
      if (dimensions !== undefined && (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536)) throw new Error('嵌入维度须为1至65536');
      const stored = await this.stored(); if (stored.hash !== expectedHash) throw new Error('嵌入/重排序配置已更新，请重新读取');
      const previous = stored.value.connections.find(c => c.id === edit.id);
      if (edit.id && !previous) throw new Error('模型配置不存在');
      if (previous && previous.encryptedKey && (previous.kind !== edit.kind || previous.type !== edit.type || base(previous.parameters) !== base(edit.parameters)) && !edit.apiKey && !edit.clearKey) throw new Error('更换地址或协议须重新填写密钥或清除密钥');
      const { apiKey, clearKey, ...profile } = edit;
      const item = { ...profile, id: previous?.id ?? randomUUID(), encryptedKey: apiKey ? this.codec.encrypt(apiKey).toString('base64') : clearKey ? '' : previous?.encryptedKey ?? '' };
      const value = storedSchema.parse({ schemaVersion: 1, connections: previous ? stored.value.connections.map(c => c.id === item.id ? item : c) : [...stored.value.connections, item] });
      const raw = JSON.stringify(value, null, 2); if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('模型配置超过2MiB，原件保留');
      await fs.mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, raw, { flag: 'wx' }); if ((await this.stored()).hash !== expectedHash) throw new Error('配置在保存期间已变化'); await fs.rename(temp, this.file); }
      finally { await fs.rm(temp, { force: true }); }
      return this.read();
    }); this.queue = result.catch(() => {}); return result;
  }
}
