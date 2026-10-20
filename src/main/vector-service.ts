import type { IndexScope, KnowledgeChunk, RetrievalHit } from '../core/knowledge';
import { cosine, validateVectors } from '../core/vector-index';
import type { VectorIndexStore } from './vector-index-store';

/** Minimal embedding capability this service needs; the HTTP adapter validates its own batches. */
export type Embedder = (purpose: 'document' | 'query', inputs: { id: string; text: string }[], signal: AbortSignal) =>
  Promise<{ id: string; values: number[] }[]>;

export interface RebuildStats { embedded: number; reused: number; removed: number; sources: number; dimensions: number }
export interface SemanticSearch { hits: RetrievalHit[]; warnings: string[] }

/**
 * Rebuilds and queries the local vector index. Embedding only happens for chunks the index does
 * not already hold for this exact embedding space; every vector is re-validated before it may be
 * written. Queries never mutate the index, and a missing index yields an explicit warning instead
 * of an empty "semantic" result.
 */
export class VectorService {
  constructor(private store: VectorIndexStore) {}
  async rebuild(scope: IndexScope, chunks: KnowledgeChunk[], dimensions: number, embed: Embedder, signal: AbortSignal, batchSize = 16): Promise<RebuildStats> {
    if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('嵌入维度无效，不能建立索引');
    if (!chunks.length) { await this.store.clear(scope); return { embedded: 0, reused: 0, removed: 0, sources: 0, dimensions }; }
    if (chunks.some(chunk => chunk.projectId !== scope.projectId || chunk.corpus !== scope.corpus)) throw new Error('索引分片与本书或用途不一致，拒绝建立索引');
    const { snapshot, diff, keepEntries } = await this.store.plan(scope, chunks);
    const pending = chunks.filter(chunk => diff.addIds.includes(chunk.id));
    const embedded: typeof keepEntries = [];
    for (let start = 0; start < pending.length; start += Math.max(1, batchSize)) {
      signal.throwIfAborted();
      const batch = pending.slice(start, start + Math.max(1, batchSize));
      const vectors = await embed('document', batch.map(chunk => ({ id: chunk.id, text: chunk.text })), signal);
      const byId = new Map(vectors.map(vector => [vector.id, vector.values]));
      const mapped = batch.map(chunk => {
        const values = byId.get(chunk.id);
        if (!values) throw new Error('嵌入服务漏掉了部分分片，索引未写入');
        return { id: chunk.id, sourcePath: chunk.sourcePath, sourceHash: chunk.sourceHash, startParagraph: chunk.startParagraph, endParagraph: chunk.endParagraph, text: chunk.text, vector: values };
      });
      validateVectors(mapped.map(entry => ({ id: entry.id, values: entry.vector })), dimensions);
      embedded.push(...mapped);
    }
    if (embedded.some(entry => entry.vector.length !== dimensions) || keepEntries.some(entry => entry.vector.length !== dimensions))
      throw new Error('新向量与已有索引维度不一致，请更换嵌入模型后全量重建');
    const sources = new Map<string, string>();
    for (const chunk of chunks) sources.set(chunk.sourcePath, chunk.sourceHash);
    if (snapshot && snapshot.dimensions !== dimensions) await this.store.clear(scope);
    await this.store.write(scope, { dimensions, entries: [...keepEntries, ...embedded], sources: [...sources].map(([path, hash]) => ({ path, hash })) });
    return { embedded: embedded.length, reused: keepEntries.length, removed: diff.removeIds.length, sources: sources.size, dimensions };
  }
  async search(scope: IndexScope, queryVector: number[], topK: number, signal: AbortSignal): Promise<SemanticSearch> {
    if (!Number.isInteger(topK) || topK <= 0) throw new Error('检索条数无效');
    signal.throwIfAborted();
    const snapshot = await this.store.read(scope);
    if (!snapshot) return { hits: [], warnings: ['本书该用途尚未建立向量索引；语义检索不可用，请先重建或改用关键词检索'] };
    if (queryVector.length !== snapshot.dimensions) return { hits: [], warnings: [`查询向量维度 ${queryVector.length} 与索引维度 ${snapshot.dimensions} 不一致，请核对嵌入配置后重建索引`] };
    const scored: RetrievalHit[] = snapshot.entries.map(entry => ({ chunk: { id: entry.id, projectId: scope.projectId, corpus: scope.corpus,
      sourcePath: entry.sourcePath, sourceHash: entry.sourceHash, startParagraph: entry.startParagraph, endParagraph: entry.endParagraph, text: entry.text, confirmed: true },
      score: cosine(queryVector, entry.vector), embeddingFingerprint: scope.embeddingFingerprint }));
    scored.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
    return { hits: scored.slice(0, topK), warnings: [] };
  }
}
