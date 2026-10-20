import { z } from 'zod';
import type { AuxiliaryModels } from './auxiliary-models';
import type { RerankTestResult } from '../shared/contracts';
import { HttpRerankProvider, RERANK_PROBE_PROJECT_ID } from './rerank-provider';

/** Explicit fixed synthetic probe. Never accepts novel/file text via IPC. */
export class RerankService {
  private active: { id: string; controller: AbortController } | null = null;
  constructor(private models: AuxiliaryModels) {}
  cancel(id: string) { z.uuid().parse(id); if (this.active?.id !== id) throw new Error('重排序测试会话已结束或不匹配'); this.active.controller.abort(); }
  async test(id: string, expectedHash: string, requestId: string): Promise<RerankTestResult> {
    z.uuid().parse(id); z.uuid().parse(requestId);
    if (this.active) throw new Error('重排序测试正在运行，请等待或停止');
    const controller = new AbortController(); this.active = { id: requestId, controller }; const start = Date.now();
    try {
      const { profile, key } = await this.models.resolve(id, expectedHash);
      controller.signal.throwIfAborted();
      const observed = await new HttpRerankProvider(profile, key).probe(controller.signal);
      if ((await this.models.read()).hash !== expectedHash) throw new Error('重排序配置已更新，本次测试结果已丢弃');
      controller.signal.throwIfAborted();
      return { connectionId: id, requestId, projectId: RERANK_PROBE_PROJECT_ID, ...observed, elapsedMs: Date.now() - start };
    } catch (e) {
      if (controller.signal.aborted) throw new Error('重排序测试已停止，配置保留');
      if (e instanceof Error && /^(重排序|嵌入\/重排序|不能将|模型配置|本机无法)/u.test(e.message)) throw e;
      throw new Error('重排序测试失败或超时，请检查地址、模型与参数，配置保留');
    } finally { this.active = null; }
  }
  /** Order retrieval candidates for the knowledge search. Never touches novel text on disk. */
  async rank(id: string, expectedHash: string, query: string, texts: string[], signal: AbortSignal): Promise<{ ranking: { index: number; score: number }[] }> {
    z.uuid().parse(id);
    if (!texts.length) return { ranking: [] };
    const { profile, key } = await this.models.resolve(id, expectedHash);
    signal.throwIfAborted();
    const ranking = await new HttpRerankProvider(profile, key).order(query, texts, signal);
    signal.throwIfAborted();
    return { ranking };
  }
}
