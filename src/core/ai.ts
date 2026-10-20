/** 通用 Provider 演进接口；当前 Chat Completions 运行实现见 main/ai-provider.ts。 */
export interface ModelConnection {
  id: string;
  protocol: 'openai-compatible' | 'anthropic' | 'gemini';
  baseUrl: string;
  model: string;
  credentialRef: string;
  contextWindow: number;
  maxOutputTokens: number;
}
export interface GenerationRequest {
  projectId: string;
  chapterPath: string;
  sourceHash: string;
  prompt: string;
}
export interface GenerationDelta { text: string; inputTokens?: number; outputTokens?: number }
export interface ModelProvider {
  generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationDelta>;
}

export interface ContextPiece {
  projectId: string;
  id: string;
  text: string;
  tokens: number;
  required: boolean;
  purpose: 'instruction' | 'canon' | 'prose' | 'discussion' | 'style';
}

/** tokens 必须由适配器计算或保守估算；此处只负责预算和作用域。 */
export function assembleContext(projectId: string, pieces: ContextPiece[], inputBudget: number) {
  if (!projectId || !Number.isFinite(inputBudget) || inputBudget < 0) throw new Error('无效上下文预算');
  if (pieces.some(p => p.projectId !== projectId)) throw new Error('上下文包含其他小说的资料');
  if (pieces.some(p => !Number.isFinite(p.tokens) || p.tokens < 0)) throw new Error('无效 Token 计数');
  const required = pieces.filter(p => p.required).reduce((n, p) => n + p.tokens, 0);
  if (required > inputBudget) throw new Error('必需设定超过预算，请缩小输入或更换模型');
  let used = required;
  const included = pieces.filter(p => {
    if (p.required) return true;
    if (used + p.tokens > inputBudget) return false;
    used += p.tokens;
    return true;
  });
  return { included, used, omitted: pieces.filter(p => !included.includes(p)).map(p => p.id) };
}

export function canApplyGeneration(request: GenerationRequest, target: { projectId: string; path: string; hash: string }) {
  return request.projectId === target.projectId && request.chapterPath === target.path && request.sourceHash === target.hash;
}
