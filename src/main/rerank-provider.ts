import { z } from 'zod';
import { hashText, normalizeBaseUrl } from './ai-connections';
import type { AuxiliaryModelConnection } from '../shared/contracts';
import type { RerankProvider, RetrievalHit } from '../core/knowledge';

export const RERANK_PROBE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
export const RERANK_PROBE_QUERY = '虚构人物在哪里阅读？';
export const RERANK_PROBE_TEXTS = ['虚构的学园位于山谷。', '虚构人物在图书馆阅读。', '虚构列车驶向海边。'] as const;
const nonempty = (max: number) => z.string().max(max).refine(s => s.trim().length > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const hitSchema = z.object({
  chunk: z.object({ id: nonempty(200), projectId: z.uuid(), corpus: z.enum(['canon', 'style-reference', 'discussion']), sourcePath: nonempty(2000), sourceHash: hash,
    startParagraph: z.number().int().min(0).max(1000000), endParagraph: z.number().int().min(0).max(1000000), text: nonempty(16000), confirmed: z.boolean() }).passthrough(),
  score: z.number().finite(), embeddingFingerprint: hash.optional()
}).passthrough();
const requestSchema = z.object({ projectId: z.uuid(), query: nonempty(4000), candidates: z.array(hitSchema).min(1).max(100), topK: z.number().int().min(1).max(100) });
type RerankRequest = Parameters<RerankProvider['rerank']>[0];
interface RankedIndex { index: number; score: number }

/** Concatenate a path only; never let URL parsing normalize traversal or replace the origin. */
function appendPath(base: string, suffix: unknown) {
  if (typeof suffix !== 'string' || suffix.length > 500 || !/^\/[A-Za-z0-9._/-]+$/.test(suffix)
    || suffix.split('/').slice(1).some(s => !s || s === '.' || s === '..')) throw new Error('重排序接口路径无效，请使用不含查询、转义或跳转的路径');
  const url = new URL(base + suffix);
  if (url.origin !== new URL(base).origin) throw new Error('重排序接口路径不能更换服务地址');
  return url.toString();
}

function parseRanks(result: unknown, type: string, candidateCount: number, topK: number): RankedIndex[] {
  const object = result !== null && typeof result === 'object' ? result as Record<string, unknown> : null;
  const ranks = type === 'tei_rerank' ? result : type === 'nvidia_rerank' ? object?.rankings
    : type === 'bailian_rerank' ? (object?.output as Record<string, unknown> | undefined)?.results : object?.results;
  const expectedCount = ['tei_rerank', 'nvidia_rerank'].includes(type) ? candidateCount : topK;
  if (!Array.isArray(ranks) || ranks.length !== expectedCount) throw new Error('重排序返回数量不匹配，结果已拒绝');
  const seen = new Set<number>();
  const mapped = ranks.map(value => {
    if (value === null || typeof value !== 'object') throw new Error('重排序返回格式不受支持');
    const item = value as Record<string, unknown>, index = item.index;
    const score = type === 'nvidia_rerank' ? item.logit : type === 'tei_rerank' ? item.score : item.relevance_score;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= candidateCount || seen.has(index)) throw new Error('重排序返回索引重复或越界');
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('重排序返回得分无效');
    seen.add(index); return { index, score };
  });
  return mapped.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, topK);
}

/** Text-only HTTP adapters. Input/source metadata is frozen before any asynchronous operation. */
export class HttpRerankProvider implements RerankProvider {
  private profile: AuxiliaryModelConnection;
  constructor(profile: AuxiliaryModelConnection, private key: string) {
    if (profile.kind !== 'rerank') throw new Error('不能将嵌入或对话模型用于重排序');
    this.profile = structuredClone(profile);
  }
  /** Public ordering entry used by knowledge retrieval: same guards and limits as scoring. */
  async order(query: string, texts: string[], signal: AbortSignal): Promise<RankedIndex[]> {
    if (!texts.length) return [];
    return this.ranks(query, texts, texts.length, signal);
  }
  private async ranks(query: string, texts: string[], topK: number, signal: AbortSignal): Promise<RankedIndex[]> {
    signal.throwIfAborted();
    if (Buffer.byteLength(query, 'utf8') + texts.reduce((n, text) => n + Buffer.byteLength(text, 'utf8'), 0) > 256 * 1024) throw new Error('重排序输入超过本批256KiB上限，请显式分批');
    const p = this.profile.parameters, type = this.profile.type;
    let url: string, body: Record<string, unknown>, timeout: number;
    try {
      timeout = z.number().int().min(1).max(1800).parse(p.timeout);
      const base = normalizeBaseUrl(z.string().max(2000).parse(type === 'nvidia_rerank' ? p.nvidia_rerank_api_base : p.rerank_api_base));
      if (type === 'vllm_rerank' || type === 'xinference_rerank') {
        url = appendPath(base, type === 'vllm_rerank' ? p.rerank_api_suffix : '/v1/rerank');
        body = { model: nonempty(200).parse(p.rerank_model), query, documents: texts, top_n: topK, return_documents: false };
      } else if (type === 'bailian_rerank') {
        url = base; const instruct = z.string().max(4000).parse(p.instruct ?? '');
        body = { model: nonempty(200).parse(p.rerank_model), input: { query, documents: texts }, parameters: { top_n: topK, return_documents: z.boolean().parse(p.return_documents ?? false), ...(instruct.trim() ? { instruct } : {}) } };
      } else if (type === 'nvidia_rerank') {
        const model = nonempty(200).parse(p.nvidia_rerank_model);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(model)) throw new Error('重排序NVIDIA模型路径无效');
        url = appendPath(appendPath(base, '/' + model), p.nvidia_rerank_model_endpoint);
        const truncate = z.enum(['', 'NONE', 'END']).parse(p.nvidia_rerank_truncate ?? '');
        body = { model, query: { text: query }, passages: texts.map(text => ({ text })), ...(truncate ? { truncate } : {}) };
      } else if (type === 'tei_rerank') {
        url = appendPath(base, '/rerank');
        body = { query, texts, truncate: z.boolean().parse(p.tei_rerank_truncate ?? false), truncation_direction: z.enum(['Left', 'Right']).parse(p.tei_rerank_truncation_direction ?? 'Right'),
          raw_scores: z.boolean().parse(p.tei_rerank_raw_scores ?? false), return_text: z.boolean().parse(p.tei_rerank_return_text ?? false) };
      } else throw new Error('重排序协议尚未适配');
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('重排序')) throw e;
      throw new Error('重排序模型参数或接口地址无效，请检查已保存配置');
    }
    const combined = AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)]);
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: combined,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(this.key ? { Authorization: 'Bearer ' + this.key } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`重排序接口返回HTTP ${response.status}，请检查地址、权限、模型或输入限制`); }
    if (!response.body) throw new Error('重排序返回为空');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 4 * 1024 * 1024) throw new Error('重排序响应超过4MiB限制'); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    combined.throwIfAborted();
    let result: unknown;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Error('重排序返回格式不受支持'); }
    return parseRanks(result, type, texts.length, topK);
  }
  async rerank(input: RerankRequest, signal: AbortSignal): Promise<RetrievalHit[]> {
    let request: RerankRequest;
    try { request = requestSchema.parse(input); } catch { throw new Error('重排序输入格式或大小无效'); }
    const candidates = structuredClone(request.candidates), corpus = candidates[0].chunk.corpus;
    if (candidates.some(c => c.chunk.projectId !== request.projectId || c.chunk.corpus !== corpus)) throw new Error('重排序候选串书或混合资料用途');
    if (new Set(candidates.map(c => c.chunk.id)).size !== candidates.length) throw new Error('重排序候选ID重复');
    const sourceHashes = new Map<string, string>();
    for (const { chunk } of candidates) {
      const previous = sourceHashes.get(chunk.sourcePath);
      if (previous !== undefined && previous !== chunk.sourceHash) throw new Error('重排序候选混合了同一来源的不同版本');
      sourceHashes.set(chunk.sourcePath, chunk.sourceHash);
    }
    if (candidates.some(c => c.chunk.endParagraph < c.chunk.startParagraph || (corpus === 'canon' && !c.chunk.confirmed))) throw new Error('重排序候选范围无效或包含未确认正史');
    if (request.topK > candidates.length) throw new Error('重排序返回数量不能超过候选数量');
    const ranked = await this.ranks(request.query, candidates.map(c => c.chunk.text), request.topK, signal);
    signal.throwIfAborted();
    return ranked.map(({ index, score }) => ({ ...candidates[index], score }));
  }
  async probe(signal: AbortSignal) {
    const candidates: RetrievalHit[] = RERANK_PROBE_TEXTS.map((text, index) => ({ chunk: { id: `rerank-probe-${index}`, projectId: RERANK_PROBE_PROJECT_ID, corpus: 'discussion',
      sourcePath: `synthetic-rerank-probe-${index}.txt`, sourceHash: hashText(text), startParagraph: index, endParagraph: index, text, confirmed: false }, score: 0 }));
    const hits = await this.rerank({ projectId: RERANK_PROBE_PROJECT_ID, query: RERANK_PROBE_QUERY, candidates, topK: 2 }, signal);
    return { candidateCount: candidates.length, results: hits.map(hit => ({ index: candidates.findIndex(c => c.chunk.id === hit.chunk.id), score: hit.score })) };
  }
}
