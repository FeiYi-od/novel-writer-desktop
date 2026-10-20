import type { RetrievalHit, RetrievalRequest } from './knowledge';
import { planRetrieval, type RetrievalCapability } from './retrieval-mode';
import { hybridMerge } from './vector-index';

export interface RetrievalDeps {
  /** Always safe: literal keyword search over the already-collected sources. */
  keyword: () => Promise<RetrievalHit[]>;
  /** Embeds the query in the same space as the index. Only called when a semantic path runs. */
  embedQuery: () => Promise<number[]>;
  /** Cosine search over the local vector index. */
  semantic: (queryVector: number[]) => Promise<RetrievalHit[]>;
  signal: AbortSignal;
  /** Fingerprint of the embedding space, echoed on semantic hits. */
  embeddingFingerprint?: string;
}
export interface RetrievalOutcome { hits: RetrievalHit[]; usedMode: RetrievalRequest['mode']; warnings: string[] }
/**
 * Runs the retrieval mode the app can honestly execute. Degradations from planRetrieval are kept
 * as author-visible warnings and `usedMode` always reports what actually ran, never the request.
 */
export async function retrieve(request: { mode: RetrievalRequest['mode']; topK: number }, capability: RetrievalCapability, deps: RetrievalDeps): Promise<RetrievalOutcome> {
  const plan = planRetrieval(request.mode, capability);
  deps.signal.throwIfAborted();
  if (plan.effective === 'keyword') {
    const hits = await deps.keyword();
    deps.signal.throwIfAborted();
    return { hits: hits.slice(0, request.topK), usedMode: 'keyword', warnings: plan.warnings };
  }
  // Semantic-only still needs no keyword scan; hybrid runs both and fuses their rankings.
  const keywordHits = plan.effective === 'hybrid' ? await deps.keyword() : [];
  deps.signal.throwIfAborted();
  const vector = await deps.embedQuery();
  deps.signal.throwIfAborted();
  const semanticHits = await deps.semantic(vector);
  if (plan.effective === 'semantic') return { hits: semanticHits.slice(0, request.topK), usedMode: 'semantic', warnings: plan.warnings };
  const merged = hybridMerge(keywordHits, semanticHits, request.topK, deps.embeddingFingerprint);
  return { hits: merged.hits, usedMode: 'hybrid', warnings: [...plan.warnings, ...merged.warnings] };
}
