import type { AIConnection } from '../shared/contracts';
import { parseUsage } from '../core/usage';

export interface UsageSample { connectionId: string; connectionName: string; model: string; prompt: number; completion: number }
type UsageSink = (sample: UsageSample) => void;
let usageSink: UsageSink | null = null;
/** One choke point: every provider call reports its own token usage here. */
export function setUsageSink(sink: UsageSink | null) { usageSink = sink; }

export interface ChatMessage { role: 'system' | 'user'; content: string }
export function chatBody(profile: AIConnection, messages: ChatMessage[]) {
  if (profile.adapter === 'gemini') return {
    ...(messages.some(m => m.role === 'system') ? { systemInstruction: { parts: messages.filter(m => m.role === 'system').map(m => ({ text: m.content })) } } : {}),
    contents: messages.filter(m => m.role !== 'system').map(m => ({ role: 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: profile.maxOutputTokens }
  };
  if (profile.adapter === 'anthropic') return {
    model: profile.model, system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
    messages: messages.filter(m => m.role !== 'system'), stream: true, max_tokens: profile.maxOutputTokens
  };
  // OpenAI Responses API: instructions carry the system text, input is a single user turn.
  if (profile.adapter === 'responses') return {
    model: profile.model, stream: true,
    ...(messages.some(m => m.role === 'system') ? { instructions: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') } : {}),
    input: messages.filter(m => m.role !== 'system').map(m => ({ role: 'user', content: [{ type: 'input_text', text: m.content }] })),
    max_output_tokens: profile.maxOutputTokens
  };
  // Ollama native API: plain object body, NDJSON stream, `options.num_predict` for output length.
  if (profile.adapter === 'ollama') return {
    model: profile.model, messages, stream: true,
    options: { num_predict: profile.maxOutputTokens }
  };
  const body: Record<string, unknown> = { model: profile.model, messages, stream: true, [profile.tokenParameter]: profile.maxOutputTokens };
  if (profile.thinking !== 'default') {
    if (profile.adapter === 'deepseek') body.thinking = { type: profile.thinking };
    if (profile.adapter === 'qwen') body.enable_thinking = profile.thinking === 'enabled';
  }
  return body;
}
/** Read SSE incrementally: UTF-8 characters, CRLF and events may span network chunks. */
export async function streamChat(profile: AIConnection, key: string, messages: ChatMessage[], signal: AbortSignal, onText: (text: string) => void): Promise<string> {
  let endpoint = `${profile.baseUrl}/chat/completions`;
  const auth: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  if (profile.adapter === 'gemini') {
    const model = profile.model.replace(/^models\//, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error('模型ID无效，请填写Gemini模型名称');
    endpoint = `${profile.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    delete auth.Authorization; if (key) auth['x-goog-api-key'] = key;
  } else if (profile.adapter === 'anthropic') {
    endpoint = `${profile.baseUrl}/messages`; delete auth.Authorization;
    if (key) auth['x-api-key'] = key; auth['anthropic-version'] = '2023-06-01';
  } else if (profile.adapter === 'responses') {
    endpoint = `${profile.baseUrl}/responses`;
  } else if (profile.adapter === 'ollama') {
    // Ollama speaks NDJSON, not SSE, and needs no bearer token for local installs.
    endpoint = `${profile.baseUrl}/api/chat`; delete auth.Authorization;
  }
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...auth },
    body: JSON.stringify(chatBody(profile, messages))
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`API 返回 HTTP ${response.status}。${response.status === 401 || response.status === 403 ? '请检查密钥及模型权限。' : response.status === 429 ? '请求限流或余额不足。' : '请检查地址、模型及输出参数。'}`);
  }
  const isOllama = profile.adapter === 'ollama';
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body || (isOllama ? !/(application\/x-ndjson|application\/json)/u.test(contentType) : !contentType.includes('text/event-stream'))) {
    await response.body?.cancel();
    throw new Error(isOllama ? '服务未返回 NDJSON 流，请确认这是 Ollama 原生接口（默认 http://127.0.0.1:11434）' : '服务未返回 SSE 流，请确认所选协议和基础地址');
  }
  if (isOllama) {
    // NDJSON 逐行解析：每行一个 {message:{content}, done, prompt_eval_count, eval_count}
    const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', finish = '', total = 0, calls = 0;
    try {
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) { buffer += decoder.decode(); if (buffer.trim()) handleLine(buffer.trim()); break; }
        total += value.byteLength;
        if (total > 8 * 1024 * 1024) throw new Error('模型流超过 8 MB 限制，已停止并保留已接收内容');
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) handleLine(line);
          if (finish) break;
        }
        if (finish) break;
      }
      if (!finish) throw new Error('连接结束但未收到完成原因，已保留部分内容');
      void calls;
      return finish;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    function handleLine(line: string) {
      let chunk: any;
      try { chunk = JSON.parse(line); } catch { throw new Error('模型返回了无法解析的流式数据'); }
      if (!chunk || typeof chunk !== 'object') throw new Error('模型在生成过程中返回错误');
      if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : '模型在生成过程中返回错误');
      if (typeof chunk.message?.content === 'string' && chunk.message.content) onText(chunk.message.content);
      const usage = parseUsage({ usage: { prompt_tokens: chunk.prompt_eval_count, completion_tokens: chunk.eval_count } });
      if (usage) usageSink?.({ connectionId: profile.id, connectionName: profile.name, model: profile.model, ...usage });
      if (chunk.done === true) { calls += 1; finish = chunk.done_reason === 'length' ? 'length' : 'stop'; }
    }
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', eventLines: string[] = [], finish = '', done = false, total = 0;
  const blocks = new Map<number, string>(); let anthropicStopped = false;
  const event = () => {
    const data = eventLines.join('\n'); eventLines = [];
    if (!data) return;
    if (data.trim() === '[DONE]') { done = true; return; }
    let chunk: any;
    try { chunk = JSON.parse(data); } catch { throw new Error('模型返回了无法解析的流式数据'); }
    if (!chunk || typeof chunk !== 'object' || chunk.error) throw new Error('模型在生成过程中返回错误');
    const usage = parseUsage(chunk);
    if (usage) usageSink?.({ connectionId: profile.id, connectionName: profile.name, model: profile.model, ...usage });
    if (profile.adapter === 'gemini') {
      if (chunk.promptFeedback?.blockReason) throw new Error('模型拒绝了本次请求');
      const candidate = chunk.candidates?.find((c: any) => c.index === 0 || c.index === undefined);
      for (const part of candidate?.content?.parts ?? []) if (!part.thought && typeof part.text === 'string') onText(part.text);
      if (candidate?.finishReason) { finish = candidate.finishReason === 'STOP' ? 'stop' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'content_filter'; done = true; }
      return;
    }
    if (profile.adapter === 'responses') {
      // OpenAI Responses events: output_text deltas, then response.completed / failed.
      if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') onText(chunk.delta);
      if (chunk.type === 'response.refusal.delta') throw new Error('模型拒绝了本次请求');
      if (chunk.type === 'response.completed') { finish = chunk.response?.status === 'incomplete' ? 'length' : 'stop'; done = true; }
      if (chunk.type === 'response.failed' || chunk.type === 'error') {
        throw new Error(chunk.response?.error?.message ?? chunk.error?.message ?? '模型在生成过程中返回错误');
      }
      return;
    }
    if (profile.adapter === 'anthropic') {
      if (chunk.type === 'content_block_start') {
        blocks.set(chunk.index, chunk.content_block?.type);
        if (chunk.content_block?.type === 'text' && typeof chunk.content_block.text === 'string') onText(chunk.content_block.text);
      }
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && blocks.get(chunk.index) === 'text' && typeof chunk.delta.text === 'string') onText(chunk.delta.text);
      if (chunk.type === 'message_delta' && chunk.delta?.stop_reason) {
        const reason = chunk.delta.stop_reason; finish = ['end_turn', 'stop_sequence'].includes(reason) ? 'stop' : reason === 'max_tokens' ? 'length' : reason === 'refusal' ? 'content_filter' : reason;
      }
      if (chunk.type === 'message_stop') { anthropicStopped = true; done = true; }
      return;
    }
    const choice = chunk.choices?.find((c: any) => c.index === 0);
    if (!choice) return;
    if (typeof choice.delta?.content === 'string') onText(choice.delta.content);
    if (choice.delta?.refusal) throw new Error('模型拒绝了本次请求');
    if (choice.finish_reason != null) finish = String(choice.finish_reason);
  };
  const lines = () => {
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
      const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      if (line === '') event(); else if (line.startsWith('data:')) eventLines.push(line.slice(5).replace(/^ /, ''));
      if (done) break;
    }
  };
  try {
    while (!done) {
      const { value, done: ended } = await reader.read();
      if (ended) { buffer += decoder.decode(); lines(); if (buffer.startsWith('data:')) eventLines.push(buffer.slice(5).trimStart()); event(); break; }
      total += value.byteLength;
      if (total > 8 * 1024 * 1024) throw new Error('模型流超过 8 MB 限制，已停止并保留已接收内容');
      buffer += decoder.decode(value, { stream: true }); lines();
    }
    if (!finish || (profile.adapter === 'anthropic' && !anthropicStopped)) throw new Error('连接结束但未收到完成原因，已保留部分内容');
    return finish;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
