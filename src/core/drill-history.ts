export interface DrillRecord { at: string; ok: boolean; steps: { name: string; ok: boolean; detail: string }[] }
/** 历史只留最近若干次，避免越写越大；返回新数组，不改入参。 */
export function appendHistory(history: DrillRecord[], record: DrillRecord, limit = 20): DrillRecord[] {
  const next = [record, ...history.filter(item => item.at !== record.at)];
  return next.slice(0, Math.max(1, limit));
}
export function summarizeHistory(history: DrillRecord[], limit = 5) {
  return history.slice(0, limit).map(record => ({
    at: record.at,
    ok: record.ok,
    passed: record.steps.filter(step => step.ok).length,
    total: record.steps.length
  }));
}
