import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { RegexWorkerFactory } from '../src/main/regex-preview';

const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.dirname(require.resolve('vite'))] })) as {
  build(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: string; format: string; target: string; logLevel: string }): Promise<unknown>;
};

let prepared: Promise<RegexWorkerFactory> | undefined;
/** Build the real trusted entry, rather than evaluating a different test engine. */
export function regexWorkerFactory(): Promise<RegexWorkerFactory> {
  return prepared ??= (async () => {
    const directory = await fs.mkdtemp(path.resolve('.artifacts/regex-worker-042-'));
    const outfile = path.join(directory, 'regex-preview-worker.cjs');
    await build({ entryPoints: [path.resolve('src/main/regex-preview-worker.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
    return options => new Worker(outfile, options);
  })();
}
