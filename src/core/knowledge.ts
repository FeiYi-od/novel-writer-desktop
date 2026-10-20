/** Knowledge contracts. HTTP embedding/rerank and local keyword retrieval are implemented; vector indexing remains pending. */
export type KnowledgeCorpus = 'canon' | 'style-reference' | 'discussion';
export interface EmbeddingConnection {
  id: string;
  protocol: 'openai-embeddings' | 'dashscope-embeddings' | 'local';
  baseUrl: string;
  model: string;
  credentialRef: string;
  dimensions: number;
  modelRevision: string;
  maxBatchSize: number;
  maxInputTokens: number;
}
export interface IndexScope {
  projectId: string;
  corpus: KnowledgeCorpus;
  /** Changes when provider/model/revision/dimensions/normalization/chunking changes. */
  embeddingFingerprint: string;
}
export interface KnowledgeChunk {
  id: string; projectId: string; corpus: KnowledgeCorpus;
  sourcePath: string; sourceHash: string; startParagraph: number; endParagraph: number;
  text: string; confirmed: boolean;
}
export interface EmbeddingRequest {
  scope: IndexScope; dimensions: number;
  purpose: 'document' | 'query';
  inputs: { id: string; projectId: string; text: string }[];
}
export interface EmbeddingBatch {
  scope: IndexScope; dimensions: number;
  vectors: { id: string; values: number[] }[];
  inputTokens?: number;
}
export interface EmbeddingProvider {
  embed(request: EmbeddingRequest, signal: AbortSignal): Promise<EmbeddingBatch>;
}
export interface RetrievalRequest {
  scope: IndexScope; query: string; topK: number;
  mode: 'keyword' | 'semantic' | 'hybrid';
  currentHashes: Record<string, string>;
}
export interface RetrievalHit { chunk: KnowledgeChunk; score: number; embeddingFingerprint?: string }
export interface KnowledgeRetriever {
  search(request: RetrievalRequest, signal: AbortSignal): Promise<{ hits: RetrievalHit[]; usedMode: RetrievalRequest['mode']; warnings: string[] }>;
}
export interface VectorIndex {
  upsert(scope: IndexScope, chunks: KnowledgeChunk[], vectors: EmbeddingBatch): Promise<void>;
  removeSource(scope: IndexScope, sourcePath: string): Promise<void>;
  search(scope: IndexScope, vector: number[], topK: number, signal: AbortSignal): Promise<RetrievalHit[]>;
}
export interface RerankProvider {
  rerank(request: { projectId: string; query: string; candidates: RetrievalHit[]; topK: number }, signal: AbortSignal): Promise<RetrievalHit[]>;
}

/** A batch cannot be indexed until every input is accounted for in the same model space. */
export function validateEmbeddingBatch(request: EmbeddingRequest, batch: EmbeddingBatch) {
  if (!request.scope.projectId || !request.scope.embeddingFingerprint || batch.scope.projectId !== request.scope.projectId || batch.scope.corpus !== request.scope.corpus || batch.scope.embeddingFingerprint !== request.scope.embeddingFingerprint) throw new Error('嵌入结果的小说、资料库或模型版本不匹配');
  if (!Number.isInteger(request.dimensions) || request.dimensions < 1 || batch.dimensions !== request.dimensions) throw new Error('嵌入向量维度不匹配');
  if (!request.inputs.length || request.inputs.some(input => input.projectId !== request.scope.projectId || !input.id || !input.text.trim())) throw new Error('嵌入输入为空或包含其他小说');
  const ids = new Set(request.inputs.map(input => input.id));
  if (ids.size !== request.inputs.length || batch.vectors.length !== ids.size) throw new Error('嵌入批次数量不匹配或输入 ID 重复');
  for (const vector of batch.vectors) {
    if (!ids.delete(vector.id)) throw new Error('嵌入结果 ID 重复或不属于请求');
    if (vector.values.length !== request.dimensions || vector.values.some(value => !Number.isFinite(value)) || vector.values.every(value => value === 0)) throw new Error('嵌入向量无效');
  }
}

/** Apply again after retrieval/rerank, immediately before assembling the model context. */
export function currentKnowledgeHits(request: RetrievalRequest, hits: RetrievalHit[]): RetrievalHit[] {
  if (!request.scope.projectId || !Number.isInteger(request.topK) || request.topK < 1 || request.topK > 100) throw new Error('无效检索范围');
  if (hits.some(hit => hit.chunk.projectId !== request.scope.projectId || hit.chunk.corpus !== request.scope.corpus)) throw new Error('检索结果包含其他小说或其他用途的资料');
  return hits.filter(hit => Number.isFinite(hit.score)
    && request.currentHashes[hit.chunk.sourcePath] === hit.chunk.sourceHash
    && (request.scope.corpus !== 'canon' || hit.chunk.confirmed)
    && (request.mode === 'keyword' || hit.embeddingFingerprint === request.scope.embeddingFingerprint))
    .sort((a, b) => b.score - a.score).slice(0, request.topK);
}
