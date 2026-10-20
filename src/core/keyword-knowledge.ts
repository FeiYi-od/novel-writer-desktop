import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentKnowledgeHits, type KnowledgeChunk, type KnowledgeCorpus, type KnowledgeRetriever, type RetrievalHit, type RetrievalRequest } from './knowledge';

export interface KeywordSource {
  projectId: string; corpus: KnowledgeCorpus; sourcePath: string; sourceHash: string;
  label: string; kind: 'chapter' | 'world' | 'character' | 'outline' | 'reference';
  paragraphs: string[]; confirmed: boolean;
}

export const KEYWORD_KNOWLEDGE_LIMITS = Object.freeze({
  sources: 500, sourceCharacters: 200000, sourceParagraphs: 10000,
  totalTextBytes: 8 * 1024 * 1024, chunks: 10000, chunkCodePoints: 2000, longParagraphOverlap: 99,
  queryCharacters: 1000, queryTerms: 16, termCharacters: 100, topK: 100
});

const locator = z.string().min(1).max(2000).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const corpus = z.enum(['canon', 'style-reference', 'discussion']);
const sourceSchema = z.object({
  projectId: z.uuid(), corpus, sourcePath: locator, sourceHash: hash,
  label: z.string().min(1).max(2000), kind: z.enum(['chapter', 'world', 'character', 'outline', 'reference']),
  paragraphs: z.array(z.string().max(KEYWORD_KNOWLEDGE_LIMITS.sourceCharacters)).max(KEYWORD_KNOWLEDGE_LIMITS.sourceParagraphs),
  confirmed: z.boolean()
});
const requestSchema = z.object({
  scope: z.object({ projectId: z.uuid(), corpus, embeddingFingerprint: z.string().min(1).max(2000) }),
  query: z.string().min(1).max(KEYWORD_KNOWLEDGE_LIMITS.queryCharacters),
  topK: z.number().int().min(1).max(KEYWORD_KNOWLEDGE_LIMITS.topK),
  mode: z.enum(['keyword', 'semantic', 'hybrid']),
  currentHashes: z.record(locator, hash).refine(value => Object.keys(value).length <= KEYWORD_KNOWLEDGE_LIMITS.sources)
});

function validSource(input: KeywordSource): KeywordSource {
  let source: KeywordSource;
  try { source = sourceSchema.parse(input); } catch { throw new Error('关键词来源的小说、用途、版本或格式无效'); }
  const characters = source.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, Math.max(0, source.paragraphs.length - 1));
  if (characters > KEYWORD_KNOWLEDGE_LIMITS.sourceCharacters) throw new Error('关键词单个来源超过20万字符上限，请先明确拆分');
  // Unpaired UTF-16 surrogates would be replaced during UTF-8 hashing and lose identity.
  if (source.paragraphs.some(paragraph => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(paragraph))) throw new Error('关键词来源包含无效Unicode字符');
  return source;
}

/** Inclusive, zero-based ranges; bounded overlap preserves terms crossing a long-paragraph split. */
function chunkValidatedSource(source: KeywordSource): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let texts: string[] = [], size = 0, start = 0, end = 0;
  const emit = (text: string, startParagraph: number, endParagraph: number, startCodePoint = 0) => {
    if (!text.trim()) return;
    const id = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, algorithm: 'keyword-chunk-v1',
      projectId: source.projectId, corpus: source.corpus, sourcePath: source.sourcePath, sourceHash: source.sourceHash,
      startParagraph, endParagraph, startCodePoint, text })).digest('hex');
    chunks.push({ id, projectId: source.projectId, corpus: source.corpus, sourcePath: source.sourcePath,
      sourceHash: source.sourceHash, startParagraph, endParagraph, text, confirmed: source.confirmed });
  };
  const flush = () => { if (texts.length) emit(texts.join('\n'), start, end); texts = []; size = 0; };
  for (const [paragraphIndex, paragraph] of source.paragraphs.entries()) {
    if (!paragraph.trim() && !texts.length) continue;
    const points = Array.from(paragraph);
    if (points.length > KEYWORD_KNOWLEDGE_LIMITS.chunkCodePoints) {
      flush();
      for (let offset = 0; offset < points.length; offset += KEYWORD_KNOWLEDGE_LIMITS.chunkCodePoints - KEYWORD_KNOWLEDGE_LIMITS.longParagraphOverlap) {
        emit(points.slice(offset, offset + KEYWORD_KNOWLEDGE_LIMITS.chunkCodePoints).join(''), paragraphIndex, paragraphIndex, offset);
        if (offset + KEYWORD_KNOWLEDGE_LIMITS.chunkCodePoints >= points.length) break;
      }
      continue;
    }
    const separator = texts.length ? 1 : 0;
    if (size + separator + points.length > KEYWORD_KNOWLEDGE_LIMITS.chunkCodePoints) flush();
    if (!texts.length) start = paragraphIndex;
    size += points.length + (texts.length ? 1 : 0); end = paragraphIndex; texts.push(paragraph);
  }
  flush(); return chunks;
}

export function chunkKnowledgeSource(source: KeywordSource): KnowledgeChunk[] {
  return chunkValidatedSource(validSource(source));
}

const yieldToCancel = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function literalOccurrences(text: string, term: string) {
  let count = 0, position = 0;
  for (;;) { const found = text.indexOf(term, position); if (found < 0) return count; count++; position = found + term.length; }
}

/** A bounded in-memory literal retriever. It performs no network calls or persistent index writes. */
export class KeywordKnowledgeRetriever implements KnowledgeRetriever {
  private readonly chunks: KnowledgeChunk[];
  private readonly boundScope: { projectId: string; corpus: KnowledgeCorpus } | null;

  constructor(input: KeywordSource[]) {
    if (!Array.isArray(input) || input.length > KEYWORD_KNOWLEDGE_LIMITS.sources) throw new Error('关键词来源超过500项上限');
    const sources = input.map(validSource);
    this.boundScope = sources.length ? { projectId: sources[0].projectId, corpus: sources[0].corpus } : null;
    if (sources.some(source => source.projectId !== this.boundScope?.projectId || source.corpus !== this.boundScope?.corpus)) throw new Error('关键词来源包含其他小说或其他用途的资料');
    if (new Set(sources.map(source => source.sourcePath)).size !== sources.length) throw new Error('关键词来源路径重复，不能混合来源版本');
    const bytes = sources.reduce((sum, source) => sum + Buffer.byteLength(source.paragraphs.join('\n'), 'utf8'), 0);
    if (bytes > KEYWORD_KNOWLEDGE_LIMITS.totalTextBytes) throw new Error('关键词来源正文超过8MiB上限，请明确缩小来源范围');
    sources.sort((left, right) => left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0);
    this.chunks = sources.flatMap(chunkValidatedSource);
    if (this.chunks.length > KEYWORD_KNOWLEDGE_LIMITS.chunks) throw new Error('关键词来源分片超过10000项上限');
  }

  async search(input: RetrievalRequest, signal: AbortSignal): ReturnType<KnowledgeRetriever['search']> {
    signal.throwIfAborted();
    let request: RetrievalRequest;
    try { request = requestSchema.parse(input); } catch { throw new Error('关键词检索的小说、用途、版本、数量或查询格式无效'); }
    if (request.mode !== 'keyword') throw new Error('当前只实现关键词检索，语义与混合检索尚未接通');
    if (this.boundScope && (request.scope.projectId !== this.boundScope.projectId || request.scope.corpus !== this.boundScope.corpus)) throw new Error('关键词检索范围属于其他小说或其他用途');
    const rawTerms = request.query.trim().split(/\s+/u);
    if (!request.query.trim() || rawTerms.length > KEYWORD_KNOWLEDGE_LIMITS.queryTerms || rawTerms.some(term => term.length > KEYWORD_KNOWLEDGE_LIMITS.termCharacters)) throw new Error('关键词查询需包含1至16个词，每词不超过100字符');
    const terms = [...new Set(rawTerms.map(term => term.toLowerCase()))];
    const hits: RetrievalHit[] = [];
    for (const [index, chunk] of this.chunks.entries()) {
      if (index % 64 === 0) { await yieldToCancel(); signal.throwIfAborted(); }
      if (!Object.hasOwn(request.currentHashes, chunk.sourcePath) || request.currentHashes[chunk.sourcePath] !== chunk.sourceHash
        || (request.scope.corpus === 'canon' && !chunk.confirmed)) continue;
      const text = chunk.text.toLowerCase(); let coverage = 0, occurrences = 0;
      for (const term of terms) { const count = literalOccurrences(text, term); if (count) { coverage++; occurrences += count; } }
      // Coverage always outranks frequency. Frequency breaks ties without exceeding one point.
      if (coverage) hits.push({ chunk, score: coverage + occurrences / (occurrences + 1) });
    }
    signal.throwIfAborted();
    return { hits: structuredClone(currentKnowledgeHits(request, hits)), usedMode: 'keyword', warnings: [] };
  }
}
