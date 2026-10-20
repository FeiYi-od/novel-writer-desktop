import { z } from 'zod';
import type { AIModelList, ModelDiscoveryRequest } from '../shared/contracts';
import { AIConnections, normalizeBaseUrl } from './ai-connections';
import type { ModelCache } from './model-cache';

export class ModelDiscoveryService {
  private busy = false;
  constructor(private connections: AIConnections, private timeoutMs = 15000, private cache?: ModelCache) {}
  async discover(input: ModelDiscoveryRequest): Promise<AIModelList> {
    if (this.busy) throw new Error('正在获取模型列表，请稍候'); this.busy = true;
    try {
      const request = z.object({ connectionId: z.uuid().optional(), expectedHash: z.string(), baseUrl: z.string().max(2000).transform(normalizeBaseUrl), apiKey: z.string().max(4000).optional(), clearKey: z.boolean().optional(), refresh: z.boolean().optional(), adapter: z.enum(['generic', 'deepseek', 'qwen', 'gemini', 'anthropic', 'responses', 'ollama']).optional() }).parse(input);
      if ((await this.connections.read()).hash !== request.expectedHash) throw new Error('模型配置已更新，请重新加载');
      let credential = request.apiKey?.trim() ?? '';
      let adapter = request.adapter ?? 'generic';
      if (request.connectionId) {
        const saved = await this.connections.resolve(request.connectionId);
        adapter = request.adapter ?? saved.profile.adapter;
        if (!credential && !request.clearKey) {
          if ((saved.profile.baseUrl !== request.baseUrl || saved.profile.adapter !== adapter) && saved.key) throw new Error('更换地址或协议后请填写该服务的密钥，或清除旧密钥');
          credential = saved.key;
        }
      }
      // Cached lists keep the settings page instant; refresh skips the cache on purpose.
      if (this.cache && request.refresh !== true) {
        const hit = await this.cache.get(adapter, request.baseUrl);
        if (hit) return { connectionId: request.connectionId, baseUrl: request.baseUrl, checkedAt: hit.checkedAt, models: hit.models as AIModelList['models'], cached: true };
      }
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (credential) headers[adapter === 'gemini' ? 'x-goog-api-key' : adapter === 'anthropic' ? 'x-api-key' : 'Authorization'] = ['gemini', 'anthropic'].includes(adapter) ? credential : 'Bearer ' + credential;
      if (adapter === 'anthropic') headers['anthropic-version'] = '2023-06-01';
      const signal = AbortSignal.timeout(this.timeoutMs), collected: any[] = [], cursors = new Set<string>();
      // Ollama 原生用 /api/tags 列模型，返回值是 { models: [{ name }] }。
      const ollama = adapter === 'ollama';
      let endpoint = request.baseUrl + (ollama ? '/api/tags' : '/models'), totalBytes = 0, totalItems = 0;
      for (let page = 0; ; page++) {
        if (page >= 20) throw new Error('模型列表分页过多，请手工填写模型 ID');
        const response = await fetch(endpoint, { method: 'GET', redirect: 'error', signal, headers });
        if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? '模型列表权限不足，请检查密钥' : [404,405,501].includes(response.status) ? '服务不支持模型列表，请手工填写模型 ID' : `模型列表返回HTTP ${response.status}，请稍后重试或手工填写`); }
        if (!response.body) throw new Error('模型列表为空，请手工填写模型 ID');
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        try { for (;;) { const next = await reader.read(); if (next.done) break; totalBytes += next.value.byteLength; if (totalBytes > 1024 * 1024) throw new Error('模型列表过大，请手工填写模型 ID'); chunks.push(next.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        let payload: any; try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Error('模型列表格式不受支持，请手工填写模型 ID'); }
        const items = adapter === 'gemini' || ollama ? payload?.models : payload?.data;
        if (!Array.isArray(items) || (totalItems += items.length) > 2000 || items.some(m => !m || typeof m !== 'object')) throw new Error('模型列表格式不受支持，请手工填写模型 ID');
        if (adapter === 'gemini') collected.push(...items.filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent')).map(m => ({ id: typeof m.name === 'string' ? m.name.replace(/^models\//, '') : m.name, name: m.displayName ?? m.name, context_window: m.inputTokenLimit, max_output_tokens: m.outputTokenLimit })));
        else if (adapter === 'anthropic') collected.push(...items.map(m => ({ ...m, name: m.display_name ?? m.id })));
        else if (ollama) collected.push(...items.map(m => ({ id: m.name ?? m.model, name: m.name ?? m.model })));
        else collected.push(...items);
        if (!['gemini', 'anthropic'].includes(adapter) && (payload.has_more || payload.nextPageToken)) throw new Error('模型列表使用尚未支持的兼容分页，请手工填写模型 ID');
        const cursor = adapter === 'gemini' ? payload.nextPageToken : adapter === 'anthropic' && payload.has_more ? payload.last_id : undefined;
        if (adapter === 'anthropic' && payload.has_more && !cursor) throw new Error('模型列表分页信息异常，请手工填写模型 ID');
        if (!cursor) break;
        if (typeof cursor !== 'string' || cursor.length > 2000 || /[\x00-\x1f\x7f-\x9f]/u.test(cursor) || (credential && (cursor.includes(credential) || cursor.includes(encodeURIComponent(credential)))) || cursors.has(cursor)) throw new Error('模型列表分页信息异常或含不安全内容，已拒绝');
        cursors.add(cursor);
        endpoint = request.baseUrl + '/models?' + (adapter === 'gemini' ? 'pageToken=' : 'after_id=') + encodeURIComponent(cursor);
      }
      const text = (value: unknown) => {
        if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f-\x9f]/u.test(value)) throw new Error('模型列表含无效名称，请手工填写模型 ID');
        let decoded = value; try { decoded = decodeURIComponent(value); } catch {}
        if (credential && (value.includes(credential) || decoded.includes(credential) || value.includes(encodeURIComponent(credential)))) throw new Error('模型列表含不安全内容，已拒绝显示');
        return value.trim();
      };
      const seen = new Set<string>(); const models: AIModelList['models'] = [];
      for (const item of collected) {
        if (!item || typeof item !== 'object') throw new Error('模型列表格式不受支持，请手工填写模型 ID');
        const id = text(item.id), name = item.name === undefined ? id : text(item.name);
        if (seen.has(id)) continue; seen.add(id);
        const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
        models.push({ id, name, contextWindow: positive(item.context_window ?? item.context_length), maxOutputTokens: positive(item.max_output_tokens) });
      }
      if ((await this.connections.read()).hash !== request.expectedHash) throw new Error('请求期间模型配置已更新，旧列表已丢弃');
      await this.cache?.set(adapter, request.baseUrl, models).catch(() => {});
      return { connectionId: request.connectionId, baseUrl: request.baseUrl, checkedAt: new Date().toISOString(), models };
    } catch (e) {
      if (e instanceof Error && /^(模型列表|模型配置|服务不支持|更换地址|请求期间)/u.test(e.message)) throw e;
      throw new Error('获取模型列表失败或超时，请检查地址，也可继续手工填写模型 ID');
    } finally { this.busy = false; }
  }
}
