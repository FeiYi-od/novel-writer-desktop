import type { IndexScope } from '../core/knowledge';
import type { AuxiliaryModelConnection } from '../shared/contracts';
import { embeddingFingerprint, HttpEmbeddingProvider } from './embedding-provider';
import type { Embedder } from './vector-service';

export interface EmbedderBundle { embed: Embedder; fingerprint: string; dimensions: number; scope: IndexScope }
/**
 * Adapts one saved auxiliary embedding connection (local Ollama by default) into the vector
 * service. The credential never leaves this object: no logging, no fixtures, no throws carrying it.
 * The fingerprint covers protocol/model/parameters/dimensions, so switching models starts a new
 * index instead of reusing vectors from another space.
 */
export function createEmbedder(profile: AuxiliaryModelConnection, key: string, dimensions: number, projectId: string, corpus: IndexScope['corpus']): EmbedderBundle {
  if (profile.kind !== 'embedding') throw new Error('所选连接不是嵌入模型，不能用于索引');
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('嵌入维度必须是正整数');
  const fingerprint = embeddingFingerprint(profile, dimensions);
  const scope: IndexScope = { projectId, corpus, embeddingFingerprint: fingerprint };
  const provider = new HttpEmbeddingProvider(profile, key);
  const embed: Embedder = async (purpose, inputs, signal) => {
    if (!inputs.length) return [];
    const batch = await provider.embed({ scope, dimensions, purpose, inputs: inputs.map(input => ({ id: input.id, projectId, text: input.text })) }, signal);
    return batch.vectors;
  };
  return { embed, fingerprint, dimensions, scope };
}
