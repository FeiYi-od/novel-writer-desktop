export type ModelCapability = 'text' | 'reasoning' | 'vision' | 'tools' | 'long-context';
export interface ModelInfoInput { id: string; owned_by?: string; context_length?: number; context_window?: number; metadata?: Record<string, unknown> }
export interface ModelProfile { id: string; label: string; capabilities: ModelCapability[]; contextLength: number | null; reasoning: boolean; vision: boolean }
const REASONING = /(^|[^a-z])(o[1-9]|o[1-9]-mini|o[1-9]-pro|gpt-5|deepseek-r1|deepseek-reasoner|qwq|qvq|reasoner|thinking)([^a-z]|$)/iu;
const VISION = /(vision|vl|4o|omni|gemini|claude-3|claude-4|pixtral|llava|qwen-vl|gpt-4\.1|gpt-5)/iu;
const LONG = /(128k|200k|256k|1m|long|turbo|32k)/iu;
const EMBED = /(embed|embedding|rerank|moderation|whisper|tts|dall-e|image)/iu;
/** Model ids are the only reliable signal across providers, so capabilities are inferred from well
 * known naming patterns and any context length the provider actually reports. */
export function describeModel(input: ModelInfoInput): ModelProfile {
  const id = input.id.trim();
  const reported = Number(input.context_length ?? input.context_window ?? (input.metadata?.context_length as number | undefined) ?? 0);
  const contextLength = Number.isFinite(reported) && reported > 0 ? Math.round(reported) : null;
  const lower = id.toLowerCase();
  const capabilities: ModelCapability[] = ['text'];
  const reasoning = REASONING.test(lower);
  const vision = VISION.test(lower);
  if (reasoning) capabilities.push('reasoning');
  if (vision) capabilities.push('vision');
  if (!EMBED.test(lower)) capabilities.push('tools');
  if ((contextLength ?? 0) >= 100_000 || LONG.test(lower)) capabilities.push('long-context');
  return { id, label: labelFor(id), capabilities, contextLength, reasoning, vision };
}
function labelFor(id: string) { const cleaned = id.split('/').pop() ?? id; return cleaned.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim(); }
/** Filters the model list by capability; `text` is implied, so choosing only `vision` still returns
 * models that can also write text. */
export function filterModels(models: ModelProfile[], required: ModelCapability[]): ModelProfile[] {
  if (!required.length) return [...models].sort((left, right) => left.id.localeCompare(right.id));
  return models.filter(model => required.every(capability => model.capabilities.includes(capability)))
    .sort((left, right) => left.id.localeCompare(right.id));
}
/** A short, human label for the model picker. */
export function capabilitySummary(model: ModelProfile): string {
  const parts: string[] = [];
  if (model.capabilities.includes('reasoning')) parts.push('推理');
  if (model.vision) parts.push('视觉');
  if (model.capabilities.includes('tools')) parts.push('工具');
  if (model.capabilities.includes('long-context')) parts.push('长上下文');
  if (model.contextLength) parts.push(`${Math.round(model.contextLength / 1000)}k`);
  return parts.length ? parts.join(' · ') : '通用文本';
}
