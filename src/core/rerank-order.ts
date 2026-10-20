import type { RetrievalHit } from './knowledge';

export interface RerankScore { index: number; score: number }

/** Reorders retrieval hits by an external reranker without inventing or dropping evidence.
 * Unknown or duplicated indexes are ignored; hits the reranker did not score keep their original
 * relative order and stay behind the scored ones, so a partial answer can never hide a passage. */
export function applyRerank(hits: RetrievalHit[], ranking: RerankScore[], topK: number): RetrievalHit[] {
  const seen = new Set<number>();
  const scored: { hit: RetrievalHit; score: number; index: number }[] = [];
  for (const item of ranking) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= hits.length) continue;
    if (seen.has(item.index) || !Number.isFinite(item.score)) continue;
    seen.add(item.index); scored.push({ hit: hits[item.index], score: item.score, index: item.index });
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  const rest = hits.filter((_, index) => !seen.has(index));
  return [...scored.map(item => item.hit), ...rest].slice(0, Math.max(1, topK));
}
