import * as fs from 'node:fs/promises';
import path from 'node:path';

export interface CachedModels { models: { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }[]; checkedAt: string }
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Small on-disk cache so opening the settings page does not hit every provider again. Keyed by
 * protocol + base URL for anonymous requests only; expired and legacy entries are ignored. */
export class ModelCache {
  private memory: Record<string, CachedModels> | null = null;
  constructor(private readonly file: string, private readonly now: () => number = () => Date.now()) {}
  // Earlier versions mixed authenticated and anonymous lists. Never reuse them.
  static key(adapter: string, baseUrl: string) { return `anonymous-v2|${adapter}|${baseUrl}`; }
  private async load() {
    if (this.memory) return this.memory;
    try { this.memory = JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, CachedModels>; }
    catch { this.memory = {}; }
    return this.memory;
  }
  async get(adapter: string, baseUrl: string): Promise<CachedModels | null> {
    const store = await this.load();
    const hit = store[ModelCache.key(adapter, baseUrl)];
    if (!hit?.checkedAt) return null;
    const age = this.now() - new Date(hit.checkedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < MODEL_CACHE_TTL_MS ? hit : null;
  }
  async set(adapter: string, baseUrl: string, models: CachedModels['models'], checkedAt = new Date(this.now()).toISOString()) {
    const store = await this.load();
    store[ModelCache.key(adapter, baseUrl)] = { models, checkedAt };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(store, null, 2));
    await fs.rename(temporary, this.file);
  }
  async clear() { this.memory = {}; await fs.rm(this.file, { force: true }); }
}
