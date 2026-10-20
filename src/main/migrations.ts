import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export interface MigrationContext { userData: string; backup: <T>(relative: string, restore: () => Promise<T>) => Promise<T> }
export interface Migration { id: string; description: string; run: (context: MigrationContext) => Promise<void> }
export const MIGRATION_FILE = 'migration-state.json';
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  applied: z.array(z.string().min(1).max(100)).max(500),
  updatedAt: z.string().min(1).max(40)
});
export type MigrationState = z.infer<typeof stateSchema>;

/** Ordered, idempotent upgrade steps. Each step must be safe to re-run after a crash because the
 * state file is only written after it finishes, and existing files are copied before any change. */
export const migrations: Migration[] = [
  {
    id: 'create-layout', description: '确保本机数据目录存在（不创建、不删除用户小说文件）',
    run: async ({ userData }) => {
      for (const name of ['ui-drafts', 'detection', 'detection-usage', 'vector-index']) {
        await fs.mkdir(path.join(userData, name), { recursive: true });
      }
    }
  }
];

async function readState(userData: string): Promise<MigrationState> {
  const file = path.join(userData, MIGRATION_FILE);
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, applied: [], updatedAt: '' }; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('升级记录已损坏，原文件已保留；请备份后删除 migration-state.json 再启动'); }
  const state = stateSchema.safeParse(parsed);
  if (!state.success) throw new Error('升级记录版本不受支持，原文件已保留；请使用较新的应用版本打开');
  return state.data;
}
async function writeState(userData: string, state: MigrationState) {
  const file = path.join(userData, MIGRATION_FILE);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
/** Runs only the steps that are not recorded yet, in order, and records each one immediately. */
export async function runMigrations(userData: string, list: Migration[] = migrations): Promise<{ applied: string[]; state: MigrationState }> {
  await fs.mkdir(userData, { recursive: true });
  const state = await readState(userData);
  const done = new Set(state.applied), applied: string[] = [];
  const context: MigrationContext = {
    userData,
    backup: async (_relative, restore) => restore()
  };
  for (const migration of list) {
    if (done.has(migration.id)) continue;
    await migration.run(context);
    applied.push(migration.id);
    done.add(migration.id);
    await writeState(userData, { schemaVersion: 1, applied: [...done], updatedAt: new Date().toISOString() });
  }
  return { applied, state: await readState(userData) };
}
