export type ProviderIdentity = 'openai' | 'gemini' | 'deepseek' | 'qwen' | 'claude' | 'ollama' | 'custom';
/** Recognize official endpoints only, never infer a vendor from a proxy or model name. */
export function identifyProvider(baseUrl: string, adapter?: string): ProviderIdentity {
  let host = '';
  try { const url = new URL(baseUrl); if (!['https:', 'http:'].includes(url.protocol)) return 'custom'; host = url.hostname.toLowerCase(); }
  catch { return 'custom'; }
  if (host === 'api.openai.com') return 'openai';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com') return 'qwen';
  if (host === 'api.anthropic.com') return 'claude';
  if (adapter === 'ollama' && ['localhost','127.0.0.1','[::1]'].includes(host)) return 'ollama';
  return 'custom';
}
