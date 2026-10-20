export interface UsageTotal { prompt: number; completion: number; calls: number }
export interface UsageEntry extends UsageTotal { connectionId: string; connectionName: string; model: string; updatedAt: string }
export const EMPTY_USAGE: UsageTotal = { prompt: 0, completion: 0, calls: 0 };
export function addUsage(total: UsageTotal, usage: { prompt?: number; completion?: number }): UsageTotal {
  const prompt = Math.max(0, Math.round(Number(usage.prompt) || 0));
  const completion = Math.max(0, Math.round(Number(usage.completion) || 0));
  if (!prompt && !completion) return { ...total, calls: total.calls + 1 };
  return { prompt: total.prompt + prompt, completion: total.completion + completion, calls: total.calls + 1 };
}
/** Provider usage is advisory: a missing or partial `usage` block must never fail the writing task. */
export function parseUsage(chunk: unknown): { prompt: number; completion: number } | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const record = chunk as Record<string, unknown>;
  const usage = (record.usage ?? (record.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
  if (!usage) return null;
  const pick = (...keys: string[]) => { for (const key of keys) { const value = Number(usage[key]); if (Number.isFinite(value) && value >= 0) return Math.round(value); } return 0; };
  const prompt = pick('prompt_tokens', 'input_tokens');
  const completion = pick('completion_tokens', 'output_tokens');
  if (!prompt && !completion) return null;
  return { prompt, completion };
}
export function formatUsage(total: UsageTotal): string {
  if (!total.calls) return '还没有用量记录';
  const tokens = total.prompt + total.completion;
  return `${total.calls} 次调用 · 输入 ${total.prompt} · 输出 ${total.completion} · 合计 ${tokens} tokens`;
}
export function mergeEntry(entries: UsageEntry[], next: UsageEntry): UsageEntry[] {
  const existing = entries.find(entry => entry.connectionId === next.connectionId && entry.model === next.model);
  const merged = existing
    ? { ...existing, prompt: existing.prompt + next.prompt, completion: existing.completion + next.completion, calls: existing.calls + next.calls, updatedAt: next.updatedAt, connectionName: next.connectionName }
    : next;
  return [merged, ...entries.filter(entry => !(entry.connectionId === next.connectionId && entry.model === next.model))]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 40);
}
