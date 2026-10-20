import { z } from 'zod';
import type { AuxiliaryModels } from './auxiliary-models';
import type { EmbeddingTestResult } from '../shared/contracts';
import { HttpEmbeddingProvider } from './embedding-provider';

/** Probe only fixed synthetic sentences. No novel/file text crosses this IPC. */
export class EmbeddingService {
  private active: { id: string; controller: AbortController } | null = null;
  constructor(private models: AuxiliaryModels) {}
  cancel(id: string) { z.uuid().parse(id); if (this.active?.id !== id) throw new Error('嵌入测试会话已结束或不匹配'); this.active.controller.abort(); }
  async test(id: string, expectedHash: string, requestId: string): Promise<EmbeddingTestResult> {
    z.uuid().parse(id); z.uuid().parse(requestId);
    if (this.active) throw new Error('嵌入测试正在运行，请等待或停止');
    const controller = new AbortController(); this.active = { id: requestId, controller }; const start = Date.now();
    try {
      const { profile, key } = await this.models.resolve(id, expectedHash);
      const observed = await new HttpEmbeddingProvider(profile, key).probe(controller.signal);
      if ((await this.models.read()).hash !== expectedHash) throw new Error('嵌入配置已更新，本次测试结果已丢弃');
      controller.signal.throwIfAborted();
      const configuredDimensions = Number(profile.parameters.embedding_dimensions);
      return { connectionId: id, requestId, projectId: '00000000-0000-4000-8000-000000000001', ...observed, configuredDimensions, dimensionMatches: configuredDimensions === observed.dimensions, elapsedMs: Date.now() - start };
    } catch (e) {
      if (controller.signal.aborted) throw new Error('嵌入测试已停止，配置保留');
      if (e instanceof Error && /^(嵌入|不能将|模型配置|本机无法)/u.test(e.message)) throw e;
      throw new Error('嵌入测试失败或超时，请检查地址、模型与参数，配置保留');
    } finally { this.active = null; }
  }
}
