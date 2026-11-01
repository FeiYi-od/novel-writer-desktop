import type { Worker, WorkerOptions } from 'node:worker_threads';
import type { MacroEnv, RegexScript } from '../core/st-macros';

export const REGEX_PREVIEW_LIMITS = Object.freeze({
  inputCharacters: 20000, scripts: 256, patternCharacters: 8192, replacementCharacters: 32768,
  trimEntries: 128, trimCharacters: 8192, payloadBytes: 1024 * 1024, outputCharacters: 200000,
  timeoutMs: 3000, concurrency: 2
});
export interface RegexPreviewTask { projectId: string; requestId: string; text: string; scripts: RegexScript[]; env: MacroEnv }
export interface RegexPreviewOutput { projectId: string; requestId: string; expanded: string; applied: string }
export type RegexWorkerFactory = (options: WorkerOptions) => Worker;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ENV_STRING_KEYS = ['user', 'char', 'description', 'personality', 'scenario', 'persona', 'mesExamples', 'lastMessage', 'original', 'seed', 'userNickname', 'charNickname'] as const;
const ENV_BOOLEAN_KEYS = ['nicknamePreviewEnabled', 'useNicknameForMacros'] as const;
const ENV_KEYS = [...ENV_STRING_KEYS, ...ENV_BOOLEAN_KEYS];
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('正则预览参数格式无效');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error('正则预览包含未知参数');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Error('正则预览不接收动态属性');
  }
  return value as Record<string, unknown>;
}

/** Reconstruct a bounded plain snapshot before Worker structured cloning. Neither
 * caller mutations nor a giant JSON stringify can enlarge this request later. */
export function freezeRegexPreviewTask(input: unknown): RegexPreviewTask {
  const limits = REGEX_PREVIEW_LIMITS, value = record(input, ['projectId', 'requestId', 'text', 'scripts', 'env']);
  let rawBytes = 0;
  const string = (item: unknown, max: number): string => {
    if (typeof item !== 'string' || item.length > max) throw new Error('正则预览文字或脚本超过安全上限');
    rawBytes += Buffer.byteLength(item, 'utf8');
    if (rawBytes > limits.payloadBytes) throw new Error('正则预览参数超过1 MiB');
    return item;
  };
  const projectId = string(value.projectId, 36), requestId = string(value.requestId, 36);
  if (!uuid.test(projectId) || !uuid.test(requestId)) throw new Error('正则预览小说或请求标识无效');
  const text = string(value.text, limits.inputCharacters);
  if (!Array.isArray(value.scripts) || value.scripts.length > limits.scripts) throw new Error('正则预览脚本不能超过256条');
  const scripts = value.scripts.map(raw => {
    const item = record(raw, ['findRegex', 'replaceString', 'disabled', 'flags', 'trimStrings']);
    const script: RegexScript = { findRegex: string(item.findRegex, limits.patternCharacters), replaceString: string(item.replaceString, limits.replacementCharacters) };
    if (item.disabled !== undefined) {
      if (typeof item.disabled !== 'boolean') throw new Error('正则脚本禁用标记无效');
      script.disabled = item.disabled;
    }
    if (item.flags !== undefined) script.flags = string(item.flags, limits.patternCharacters);
    if (item.trimStrings !== undefined) {
      if (!Array.isArray(item.trimStrings) || item.trimStrings.length > limits.trimEntries) throw new Error('正则预览trim条目不能超过128条');
      script.trimStrings = item.trimStrings.map(trim => string(trim, limits.trimCharacters));
    }
    return script;
  });
  const envInput = record(value.env, ENV_KEYS), env: MacroEnv = {};
  for (const name of ENV_STRING_KEYS) if (envInput[name] !== undefined) env[name] = string(envInput[name], limits.inputCharacters);
  for (const name of ENV_BOOLEAN_KEYS) if (envInput[name] !== undefined) {
    if (typeof envInput[name] !== 'boolean') throw new Error('昵称预览开关格式无效');
    env[name] = envInput[name] as boolean;
  }
  const snapshot = { projectId, requestId, text, scripts, env };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > limits.payloadBytes) throw new Error('正则预览参数超过1 MiB');
  return snapshot;
}

const cancelled = () => new Error('正则预览已取消，未返回部分结果');

/** Only a trusted factory creates workers. The application supplies its built
 * ?nodeWorker entry; tests compile that same entry to an isolated CJS fixture. */
export class RegexPreviewRunner {
  private readonly active = new Map<string, symbol>();
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  constructor(private readonly factory: RegexWorkerFactory, options: { timeoutMs?: number; maxConcurrent?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? REGEX_PREVIEW_LIMITS.timeoutMs;
    this.maxConcurrent = options.maxConcurrent ?? REGEX_PREVIEW_LIMITS.concurrency;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60000
      || !Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 8) throw new Error('正则预览线程配置无效');
  }
  get activeCount() { return this.active.size; }
  async run(input: RegexPreviewTask, signal?: AbortSignal): Promise<RegexPreviewOutput> {
    const task = freezeRegexPreviewTask(input), key = `${task.projectId}:${task.requestId}`;
    if (signal?.aborted) throw cancelled();
    if (this.active.has(key)) throw new Error('这次正则预览已经在处理');
    if (this.active.size >= this.maxConcurrent) throw new Error('正则预览线程已满，请等待或取消正在运行的预览');
    const identity = Symbol(key); this.active.set(key, identity);
    const release = () => { if (this.active.get(key) === identity) this.active.delete(key); };
    let worker: Worker;
    try {
      worker = this.factory({ workerData: task, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    } catch {
      release(); throw new Error('正则预览线程启动失败');
    }
    return new Promise<RegexPreviewOutput>((resolve, reject) => {
      let settling = false, exited = false;
      const cleanup = () => {
        worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
        release();
      };
      const finish = (failure?: Error, output?: RegexPreviewOutput) => {
        if (settling) return;
        settling = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        // Keep error/exit listeners until terminate resolves; removing error early
        // could turn an error racing cancellation into an uncaught host event.
        void (async () => {
          let terminated = false;
          try { await worker.terminate(); terminated = true; }
          catch { failure = new Error('正则预览线程终止失败，未返回结果'); }
          finally {
            if (terminated || exited) cleanup();
            else {
              // A failed termination cannot free capacity for another thread
              // until the old worker actually exits.
              worker.off('message', onMessage); worker.once('exit', cleanup);
            }
          }
          if (signal?.aborted) failure = cancelled();
          if (failure) reject(failure); else if (output) resolve(output); else reject(new Error('正则预览未返回有效结果'));
        })();
      };
      const onMessage = (message: unknown) => {
        try {
          const value = record(message, ['ok', 'projectId', 'requestId', 'expanded', 'applied', 'error']);
          if (value.projectId !== task.projectId || value.requestId !== task.requestId) throw new Error('正则预览结果归属不匹配');
          if (value.ok === false && typeof value.error === 'string' && value.error.length <= 500) { finish(new Error(value.error)); return; }
          if (value.ok !== true || typeof value.expanded !== 'string' || typeof value.applied !== 'string'
            || value.expanded.length > REGEX_PREVIEW_LIMITS.outputCharacters || value.applied.length > REGEX_PREVIEW_LIMITS.outputCharacters)
            throw new Error('正则预览结果无效或超过输出上限');
          finish(undefined, { projectId: task.projectId, requestId: task.requestId, expanded: value.expanded, applied: value.applied });
        } catch (error) { finish(error instanceof Error ? error : new Error('正则预览结果无效')); }
      };
      const onError = () => finish(new Error('正则预览线程执行失败，未返回部分结果'));
      const onExit = () => { exited = true; if (!settling) finish(new Error('正则预览线程提前结束，未返回部分结果')); };
      const onAbort = () => finish(cancelled());
      const timer = setTimeout(() => finish(new Error('正则预览超过时限，已终止；未返回部分结果')), this.timeoutMs);
      worker.on('message', onMessage); worker.on('error', onError); worker.once('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
