import * as fs from 'node:fs/promises';
import path from 'node:path';
import { mergeEntry, type UsageEntry } from '../core/usage';
import type { UsageSample } from './ai-provider';

/** Token usage per connection/model, kept in userData (not in a book, so it survives project moves). */
export class UsageStore {
  private cache: UsageEntry[] | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  async read(): Promise<UsageEntry[]> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as { entries?: UsageEntry[] };
      this.cache = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch { this.cache = []; }
    return this.cache;
  }
  record(sample: UsageSample) {
    const at = new Date().toISOString();
    const run = async () => {
      const entries = await this.read();
      this.cache = mergeEntry(entries, { connectionId: sample.connectionId, connectionName: sample.connectionName, model: sample.model, prompt: sample.prompt, completion: sample.completion, calls: 1, updatedAt: at });
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, entries: this.cache }, null, 2));
      await fs.rename(temporary, this.file);
    };
    this.writing = this.writing.then(run).catch(() => {});
    return this.writing;
  }
  /** Used by tests and by "clear usage" in the UI. */
  async reset() { this.cache = []; await fs.rm(this.file, { force: true }); }
}
