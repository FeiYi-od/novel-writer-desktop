import upstream from './astrbot-provider-templates.json';
import type { AIConnectionEdit } from './contracts';

// Configuration metadata adapted from AstrBot (AGPL-3.0). See docs/ASTRBOT_MODEL_CONFIG.md.
export const astrbotTemplates = Object.entries(upstream.templates).map(([label, value]) => ({ label, ...value })) as { label: string; id: string; type: string; provider_type: string; [field: string]: unknown }[];
/** OpenAI 兼容协议：请求体与 SSE 都和通用通道一致。 */
const compatible = new Set(['openai_chat_completion', 'zhipu_chat_completion', 'longcat_chat_completion', 'aihubmix_chat_completion', 'mirarouter_chat_completion', 'openrouter_chat_completion', 'ssycloud_chat_completion', 'groq_chat_completion', 'xiaomi_chat_completion']);
/** 各家"保留但禁用"的协议在这里显式落位到已有适配器，未知类型继续禁用并给出原因。 */
const explicit: Record<string, { adapter: NonNullable<AIConnectionEdit['adapter']>; note: string }> = {
  openai_responses: { adapter: 'responses', note: '/responses 原生接口（instructions + input）' },
  kimi_code_chat_completion: { adapter: 'anthropic', note: 'Kimi 编码套餐提供 Anthropic 兼容的 /messages' },
  minimax_token_plan: { adapter: 'anthropic', note: 'MiniMax 套餐地址以 /anthropic 结尾，走 /messages' },
  xiaomi_token_plan: { adapter: 'anthropic', note: '小米套餐地址以 /anthropic 结尾，走 /messages' }
};
export interface ChatPreset { label: string; available: boolean; note: string; value: Partial<AIConnectionEdit> }
export const chatPresets: ChatPreset[] = astrbotTemplates.filter(t => t.provider_type === 'chat_completion').map(t => {
  const mapped = explicit[t.type];
  const adapter: AIConnectionEdit['adapter'] | undefined = mapped?.adapter
    ?? (t.type === 'googlegenai_chat_completion' ? 'gemini' : t.type === 'anthropic_chat_completion' ? 'anthropic' : compatible.has(t.type) ? t.id === 'deepseek' ? 'deepseek' : 'generic' : undefined);
  const note = mapped?.note ?? (adapter ? (adapter === 'gemini' ? 'Gemini 原生协议（streamGenerateContent）' : adapter === 'anthropic' ? 'Anthropic 原生 /messages' : adapter === 'deepseek' ? 'DeepSeek 原生对话通道' : 'OpenAI 兼容协议') : '该协议尚未适配（缺少可验证的接口规范），暂不提供选择');
  const baseUrl = typeof t.api_base === 'string' ? t.api_base : '';
  return { label: t.label, available: !!adapter, note: baseUrl ? note : `${note}；需自行填写接口地址`, value: { name: t.label, adapter, baseUrl, model: '', timeoutSeconds: typeof t.timeout === 'number' ? Math.max(30, t.timeout) : 120, thinking: 'default' } as Partial<AIConnectionEdit> };
});
// The existing domestic parameter adapter is retained in addition to the upstream catalog.
chatPresets.push({ label: '通义千问 · 百炼北京', available: true, note: '阿里云百炼兼容模式（enable_thinking 参数）', value: { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', adapter: 'qwen', thinking: 'default' } });
chatPresets.push({ label: '自定义兼容接口', available: true, note: '任意 OpenAI 兼容服务；需自行填写接口地址', value: { adapter: 'generic' } });
chatPresets.push({ label: 'gemini-web2api · 本地兼容', available: true, note: '本地兼容层，OpenAI 协议', value: { name: 'gemini-web2api', baseUrl: 'http://127.0.0.1:8081/v1', model: '', adapter: 'generic', thinking: 'default', timeoutSeconds: 300 } });
chatPresets.push({ label: 'Ollama · 本机原生', available: true, note: 'Ollama 原生 /api/chat（NDJSON 流）', value: { name: 'Ollama 本地', baseUrl: 'http://127.0.0.1:11434', model: '', adapter: 'ollama', thinking: 'default', timeoutSeconds: 300 } });
