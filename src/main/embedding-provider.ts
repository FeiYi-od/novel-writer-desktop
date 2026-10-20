import { z } from 'zod';
import { hashText, normalizeBaseUrl } from './ai-connections';
import type { AuxiliaryModelConnection } from '../shared/contracts';
import type { EmbeddingBatch, EmbeddingProvider, EmbeddingRequest } from '../core/knowledge';
import { validateEmbeddingBatch } from '../core/knowledge';

const requestSchema = z.object({ scope: z.object({ projectId: z.uuid(), corpus: z.enum(['canon', 'style-reference', 'discussion']), embeddingFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }), dimensions: z.number().int().min(1).max(65536), purpose: z.enum(['document', 'query']), inputs: z.array(z.object({ id: z.string().min(1).max(200), projectId: z.uuid(), text: z.string().trim().min(1).max(16000) })).min(1).max(10) });
export function embeddingFingerprint(profile: AuxiliaryModelConnection, dimensions: number) { return hashText(JSON.stringify({ version: 1, id: profile.id, type: profile.type, parameters: profile.parameters, dimensions })); }
const safeVector = (value: unknown): value is number[] => Array.isArray(value) && value.length >= 1 && value.length <= 65536 && value.every(n => typeof n === 'number' && Number.isFinite(n)) && value.some(n => n !== 0);

export class HttpEmbeddingProvider implements EmbeddingProvider {
  private profile: AuxiliaryModelConnection;
  constructor(profile: AuxiliaryModelConnection, private key: string) { this.profile = structuredClone(profile); if (profile.kind !== 'embedding') throw new Error('不能将重排序或对话模型用于嵌入'); }
  private async vectors(texts: string[], purpose: 'document' | 'query', signal: AbortSignal): Promise<number[][]> {
    const p = this.profile.parameters, type = this.profile.type;
    const model = z.string().trim().min(1).max(200).parse(p.embedding_model), base = normalizeBaseUrl(z.string().parse(p.embedding_api_base));
    const timeout = z.number().int().min(1).max(1800).parse(p.timeout);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)]);
    if (texts.reduce((n, text) => n + Buffer.byteLength(text, 'utf8'), 0) > 64000) throw new Error('嵌入输入超过本批64KiB上限，请显式分批');
    let url = base + '/embeddings', body: Record<string, unknown> = { model, input: texts, encoding_format: 'float' };
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...(this.key ? { Authorization: 'Bearer ' + this.key } : {}) };
    if (type === 'openai_embedding') { if (p.embedding_dimensions_mode === 'manual') body.dimensions = z.number().int().min(1).max(65536).parse(p.embedding_dimensions); }
    else if (type === 'nvidia_embedding') { body.input_type = purpose === 'query' ? 'query' : 'passage'; body.truncate = 'NONE'; }
    else if (type === 'ollama_embedding') { url = base + '/api/embed'; body = { model, input: texts, truncate: false }; }
    else if (type === 'dashscope_embedding') { url = base + '/services/embeddings/text-embedding/text-embedding'; body = { model, input: { texts }, parameters: { text_type: purpose === 'query' ? 'query' : 'document', dimension: z.number().int().min(1).max(65536).parse(p.embedding_dimensions) } }; }
    else if (type === 'gemini_embedding') {
      const name = model.replace(/^models\//, ''); if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error('Gemini嵌入模型ID无效');
      url = base + `/models/${name}:batchEmbedContents`; delete headers.Authorization; if (this.key) headers['x-goog-api-key'] = this.key;
      body = { requests: texts.map(text => ({ model: 'models/' + name, content: { parts: [{ text }] }, taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: z.number().int().min(1).max(65536).parse(p.embedding_dimensions) })) };
    } else throw new Error('嵌入协议尚未适配');
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: combined, headers, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`嵌入接口返回HTTP ${response.status}，请检查地址、权限、模型或输入限制`); }
    if (!response.body) throw new Error('嵌入结果为空');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 8 * 1024 * 1024) throw new Error('嵌入响应超过8MiB限制'); chunks.push(next.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let result: any; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Error('嵌入返回格式不受支持'); }
    let vectors: unknown[];
    if (type === 'ollama_embedding') vectors = result?.embeddings;
    else if (type === 'gemini_embedding') vectors = Array.isArray(result?.embeddings) ? result.embeddings.map((e: any) => e?.values) : [];
    else {
      const data = type === 'dashscope_embedding' ? result?.output?.embeddings : result?.data;
      if (!Array.isArray(data) || data.length !== texts.length) throw new Error('嵌入批次返回数量不匹配');
      vectors = new Array(texts.length); const seen = new Set<number>();
      for (const item of data) { const index = type === 'dashscope_embedding' ? item?.text_index : item?.index; if (!Number.isInteger(index) || index < 0 || index >= texts.length || seen.has(index)) throw new Error('嵌入返回索引重复或越界'); seen.add(index); vectors[index] = item.embedding; }
    }
    if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(safeVector)) throw new Error('嵌入向量数量或数值无效');
    if (vectors.some(v => (v as number[]).length !== (vectors[0] as number[]).length)) throw new Error('嵌入返回维度不一致');
    return vectors as number[][];
  }
  async embed(input: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingBatch> {
    const request = requestSchema.parse(input);
    if (request.inputs.some(i => i.projectId !== request.scope.projectId) || new Set(request.inputs.map(i => i.id)).size !== request.inputs.length) throw new Error('嵌入输入串书或ID重复');
    if (request.scope.embeddingFingerprint !== embeddingFingerprint(this.profile, request.dimensions)) throw new Error('嵌入模型指纹不匹配');
    const values = await this.vectors(request.inputs.map(i => i.text), request.purpose, signal);
    const batch: EmbeddingBatch = { scope: request.scope, dimensions: values[0].length, vectors: request.inputs.map((i, n) => ({ id: i.id, values: values[n] })) };
    validateEmbeddingBatch(request, batch); return batch;
  }
  async probe(signal: AbortSignal) { const vectors = await this.vectors(['虚构的学园位于山谷。', '虚构人物在图书馆阅读。'], 'document', signal); return { dimensions: vectors[0].length, inputCount: vectors.length }; }
}
