import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuxiliaryModels } from '../src/main/auxiliary-models';
import { EmbeddingService } from '../src/main/embedding-service';

async function main() {
  const tags = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) }).then(r => r.json()) as any;
  if (!tags.models?.some((m: any) => m.name === 'bge-m3:latest')) throw new Error('本机bge-m3未安装或服务不可读，没有自动下载模型');
  const dir = path.resolve('.artifacts', `embedding-local-${Date.now()}`); await fs.mkdir(dir, { recursive: true });
  const models = new AuxiliaryModels(dir, { encrypt: s => Buffer.from(s), decrypt: b => b.toString() });
  const snapshot = await models.save({ kind: 'embedding', name: '本机虚构句子测试', type: 'ollama_embedding', parameters: { embedding_api_base: 'http://127.0.0.1:11434', embedding_model: 'bge-m3:latest', embedding_dimensions: 768, timeout: 90 } }, '');
  const result = await new EmbeddingService(models).test(snapshot.connections[0].id, snapshot.hash, randomUUID());
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Local Ollama bge-m3 passed: ${result.inputCount} fixed fictional sentences, ${result.dimensions} observed dimensions, preset match ${result.dimensionMatches}, ${result.elapsedMs} ms. No novel/index/configuration mutation.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
