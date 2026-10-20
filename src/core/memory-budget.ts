import type { StoryMemorySnapshot } from '../shared/contracts';

/** Renderer-safe UTF-8 length: the core module also runs in the browser, where Buffer does not exist. */
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export interface MemoryUsage {
  budget: number; factsBytes: number; summariesBytes: number;
  includedFacts: number; skippedFacts: number; includedSummaries: number; skippedSummaries: number;
}
/**
 * Mirrors the context assembly order exactly (enabled facts first, then summaries sorted by
 * importance and recency, each item paying two separator bytes) so the author sees the same
 * budget the model request will use. Pure function: no IO, no model call.
 */
export function memoryUsage(value: StoryMemorySnapshot['value'], staleIds: string[]): MemoryUsage {
  const used: MemoryUsage = { budget: value.budgetBytes, factsBytes: 0, summariesBytes: 0, includedFacts: 0, skippedFacts: 0, includedSummaries: 0, skippedSummaries: 0 };
  let bytes = 0;
  for (const fact of value.facts.filter(fact => fact.enabled)) {
    const label = fact.kind === 'fact' ? '作者确认事实' : fact.state === 'open' ? '未解决伏笔' : '已解决伏笔';
    const size = utf8Bytes(`${label}：${fact.text}${fact.sourcePath ? `（来源：${fact.sourcePath}）` : ''}`) + 2;
    if (bytes + size > value.budgetBytes) { used.skippedFacts++; continue; }
    bytes += size; used.factsBytes += size; used.includedFacts++;
  }
  const summaries = value.entries.filter(entry => entry.enabled && !staleIds.includes(entry.id))
    .sort((a, b) => Number(b.important) - Number(a.important) || b.createdAt.localeCompare(a.createdAt));
  for (const entry of summaries) {
    const size = utf8Bytes(`已确认章节摘要（${entry.sourcePath}）：\n${entry.content}`) + 2;
    if (bytes + size > value.budgetBytes) { used.skippedSummaries++; continue; }
    bytes += size; used.summariesBytes += size; used.includedSummaries++;
  }
  return used;
}
