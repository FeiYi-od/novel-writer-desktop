import type { KnowledgeChunk, RetrievalHit } from './knowledge';

/** Canonical text for the embedding/chunking identity. The caller hashes it with the same hash
 * used for chunk ids, so a changed model, revision, dimension or chunking policy never reuses
 * vectors that belong to a different space. */
export function indexFingerprint(space: { protocol: string; model: string; modelRevision: string; dimensions: number },
  chunking: { maxCharacters: number; overlapCharacters: number; version: number }): string {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');
  return ['vector-index-v1', normalize(space.protocol), normalize(space.model), normalize(space.modelRevision),
    String(space.dimensions), String(chunking.version), String(chunking.maxCharacters), String(chunking.overlapCharacters)].join('\u0000');
}

export interface IndexedChunk { id: string; sourcePath: string; sourceHash: string }
export interface IndexDiff { keepIds: string[]; addIds: string[]; removeIds: string[]; changedSources: string[]; removedSources: string[] }
/** Splits a rebuild into the minimum work: unchanged chunks stay, changed sources are re-embedded,
 * deleted sources disappear. Chunk ids already contain the source hash, so a changed source
 * produces new ids and its old ids are removed. */
export function diffIndex(previous: IndexedChunk[], chunks: KnowledgeChunk[]): IndexDiff {
  const previousById = new Map(previous.map(item => [item.id, item]));
  const nextIds = new Set(chunks.map(chunk => chunk.id));
  const keepIds: string[] = []; const addIds: string[] = [];
  for (const chunk of chunks) { if (previousById.has(chunk.id)) keepIds.push(chunk.id); else addIds.push(chunk.id); }
  const removeIds = previous.filter(item => !nextIds.has(item.id)).map(item => item.id);
  const nextSources = new Map<string, string>();
  for (const chunk of chunks) nextSources.set(chunk.sourcePath, chunk.sourceHash);
  const changedSources = [...nextSources].filter(([path, hash]) => previous.some(item => item.sourcePath === path && item.sourceHash !== hash)).map(([path]) => path);
  const removedSources = [...new Set(previous.map(item => item.sourcePath))].filter(path => !nextSources.has(path));
  return { keepIds, addIds, removeIds, changedSources, removedSources };
}

export function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error(`向量维度不一致（${left.length} / ${right.length}），拒绝比较`);
  if (!left.length) throw new Error('向量为空，拒绝比较');
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('向量含非法数值，拒绝比较');
    dot += a * b; leftNorm += a * a; rightNorm += b * b;
  }
  if (!(leftNorm > 0) || !(rightNorm > 0)) throw new Error('向量范数为零，拒绝比较');
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Server-side vectors are re-validated before they may enter an index. */
export function validateVectors(entries: { id: string; values: number[] }[], dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('索引维度无效');
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('索引向量 ID 重复，拒绝写入');
  for (const entry of entries) {
    if (entry.values.length !== dimensions) throw new Error(`索引向量维度不匹配（${entry.values.length} / ${dimensions}），拒绝写入`);
    if (!entry.values.every(value => Number.isFinite(value))) throw new Error('索引向量含非法数值，拒绝写入');
  }
}

const RRF_K = 60;
/** Reciprocal rank fusion of the keyword and semantic rankings. Both lists keep their own order;
 * a chunk found by both ranks above a chunk found by only one, and no score is invented for
 * unseen chunks. Ties fall back to chunk id so results are deterministic. */
export function hybridMerge(keywordHits: RetrievalHit[], semanticHits: RetrievalHit[], topK: number, embeddingFingerprint?: string):
  { hits: RetrievalHit[]; warnings: string[] } {
  if (!Number.isInteger(topK) || topK <= 0) throw new Error('检索条数无效');
  const scores = new Map<string, { hit: RetrievalHit; score: number; keyword: boolean; semantic: boolean }>();
  const add = (hits: RetrievalHit[], semantic: boolean) => {
    hits.forEach((hit, index) => {
      if (hits.findIndex(other => other.chunk.id === hit.chunk.id) !== index) return; // keep the best rank only
      const current = scores.get(hit.chunk.id);
      const contribution = 1 / (RRF_K + index + 1);
      if (!current) scores.set(hit.chunk.id, { hit, score: contribution, keyword: !semantic, semantic });
      else { current.score += contribution; if (semantic) current.semantic = true; else current.keyword = true; }
    });
  };
  add(keywordHits, false); add(semanticHits, true);
  const warnings: string[] = [];
  if (!keywordHits.length && !semanticHits.length) warnings.push('关键词与语义检索都没有命中');
  const hits = [...scores.values()]
    .sort((left, right) => right.score - left.score || left.hit.chunk.id.localeCompare(right.hit.chunk.id))
    .slice(0, topK)
    .map(item => ({ chunk: item.hit.chunk, score: item.score, ...(item.semantic && embeddingFingerprint ? { embeddingFingerprint } : {}) }));
  return { hits, warnings };
}
