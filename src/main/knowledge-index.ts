import type { IndexScope, KnowledgeChunk, KnowledgeCorpus, RetrievalHit } from '../core/knowledge';
import type { RebuildStats, VectorService } from './vector-service';
import type { Embedder } from './vector-service';
import type { VectorIndexStore } from './vector-index-store';
import type { Workspace } from './workspace';

export interface ChunkProvider {
  collectChunks(projectId: string, corpus: KnowledgeCorpus, signal: AbortSignal): Promise<{ chunks: KnowledgeChunk[]; warnings: string[] }>;
}
export interface IndexStatus {
  projectId: string; corpus: KnowledgeCorpus;
  exists: boolean; entries: number; dimensions: number; updatedAt: string;
  warnings: string[];
}
export interface IndexRebuildResult { stats: RebuildStats; warnings: string[] }
/**
 * Owns "when can this book be searched semantically": it collects the same passages the keyword
 * search would use, embeds only what the local index is missing, and reports honestly when there
 * is nothing to build. It never touches novel files and never runs without an explicit request.
 */
export class KnowledgeIndexService {
  private active: { projectId: string; controller: AbortController } | null = null;
  constructor(private provider: ChunkProvider, private store: VectorIndexStore, private vectors: VectorService, private workspace: Workspace) {}
  private scope(projectId: string, corpus: KnowledgeCorpus, fingerprint: string): IndexScope {
    this.workspace.getProject(projectId);
    return { projectId, corpus, embeddingFingerprint: fingerprint };
  }
  async status(projectId: string, corpus: KnowledgeCorpus, fingerprint?: string): Promise<IndexStatus> {
    this.workspace.getProject(projectId);
    if (!fingerprint) return { projectId, corpus, exists: false, entries: 0, dimensions: 0, updatedAt: '', warnings: ['尚未选择嵌入连接，语义检索不可用；关键词检索不受影响'] };
    const snapshot = await this.store.read(this.scope(projectId, corpus, fingerprint));
    if (!snapshot) return { projectId, corpus, exists: false, entries: 0, dimensions: 0, updatedAt: '', warnings: ['本书该用途还没有可用的向量索引，请先重建'] };
    return { projectId, corpus, exists: true, entries: snapshot.entries.length, dimensions: snapshot.dimensions, updatedAt: snapshot.updatedAt, warnings: [] };
  }
  async rebuild(request: { projectId: string; corpus: KnowledgeCorpus; fingerprint: string; dimensions: number; embed: Embedder }): Promise<IndexRebuildResult> {
    this.workspace.getProject(request.projectId);
    if (this.active) throw new Error('已有索引重建进行中，请等待完成或停止');
    const controller = new AbortController();
    this.active = { projectId: request.projectId, controller };
    try {
      const scope = this.scope(request.projectId, request.corpus, request.fingerprint);
      const { chunks, warnings } = await this.provider.collectChunks(request.projectId, request.corpus, controller.signal);
      controller.signal.throwIfAborted();
      if (!chunks.length) {
        await this.store.clear(scope);
        await this.store.clearActive(request.projectId, request.corpus);
        return { stats: { embedded: 0, reused: 0, removed: 0, sources: 0, dimensions: request.dimensions }, warnings: [...warnings, '没有可索引的来源，已清除该用途的旧索引'] };
      }
      const stats = await this.vectors.rebuild(scope, chunks, request.dimensions, request.embed, controller.signal);
      await this.store.writeActive(request.projectId, request.corpus, { fingerprint: request.fingerprint, dimensions: request.dimensions });
      return { stats, warnings };
    } finally { this.active = null; }
  }
  cancel(projectId: string) {
    if (this.active?.projectId === projectId) this.active.controller.abort();
  }
  /** Query path shared by the search service: embed the query, then cosine-search the index. */
  async search(projectId: string, corpus: KnowledgeCorpus, fingerprint: string, queryVector: number[], topK: number, signal: AbortSignal): Promise<{ hits: RetrievalHit[]; warnings: string[] }> {
    return this.vectors.search(this.scope(projectId, corpus, fingerprint), queryVector, topK, signal);
  }
}
