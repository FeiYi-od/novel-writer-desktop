import * as fs from 'node:fs/promises';
import path from 'node:path';
import { appendHistory, type DrillRecord } from '../core/drill-history';

const file = (userData: string) => path.join(userData, 'drill-history.json');
/** 自检结果留档：写入本机 JSON（最多 20 条），下次打开面板还能看到上次跑的结果。 */
export async function saveDrillRecord(userData: string, record: DrillRecord): Promise<DrillRecord[]> {
  const target = file(userData);
  const history = await readDrillHistory(userData);
  const next = appendHistory(history, record, 20);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ schemaVersion: 1, records: next }, null, 2), 'utf8');
  return next;
}
export async function readDrillHistory(userData: string): Promise<DrillRecord[]> {
  try {
    const raw = JSON.parse(await fs.readFile(file(userData), 'utf8')) as { records?: DrillRecord[] };
    return Array.isArray(raw.records) ? raw.records.filter(item => typeof item?.at === 'string' && Array.isArray(item?.steps)) : [];
  } catch { return []; }
}
