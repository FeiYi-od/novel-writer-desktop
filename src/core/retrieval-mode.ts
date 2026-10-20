import type { RetrievalRequest } from './knowledge';

export interface RetrievalCapability {
  /** An embedding connection is configured and usable (credentials present). */
  embedding: boolean;
  /** A vector index exists for this book/corpus and the current embedding fingerprint. */
  index: boolean;
  /** The index exists but its sources changed since it was built. */
  stale: boolean;
}
export interface RetrievalPlan {
  requested: RetrievalRequest['mode'];
  effective: RetrievalRequest['mode'];
  warnings: string[];
}
/**
 * Decides what the app can honestly do. Semantic or hybrid requests never pretend to run when the
 * embedding connection or the index is missing: they degrade to keyword search and say so.
 * A stale index still may not be trusted silently, so it also degrades with an explicit warning.
 */
export function planRetrieval(requested: RetrievalRequest['mode'], capability: RetrievalCapability): RetrievalPlan {
  if (requested === 'keyword') return { requested, effective: 'keyword', warnings: [] };
  if (!capability.embedding) return { requested, effective: 'keyword', warnings: ['尚未配置可用的嵌入连接，本次降级为关键词检索；语义检索未执行'] };
  if (!capability.index) return { requested, effective: 'keyword', warnings: ['本书该用途还没有可用的向量索引，本次降级为关键词检索；请先重建索引'] };
  if (capability.stale) return { requested, effective: 'keyword', warnings: ['向量索引的来源已变化，本次降级为关键词检索；请重建索引后再用语义检索'] };
  return { requested, effective: requested, warnings: [] };
}
