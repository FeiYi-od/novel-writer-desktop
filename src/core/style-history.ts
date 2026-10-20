export interface RuleVersion { version: number; rules: string; savedAt: string }
export interface EffectRecord { at: string; source: 'trial' | 'chapter'; characters: number; averageSentence: number; dialogueRatio: number; note?: string }
export interface StyleHistory { styleId: string; current: RuleVersion; history: RuleVersion[]; effects: EffectRecord[] }
export const STYLE_HISTORY_LIMITS = { versions: 10, effects: 50, rules: 20000 } as const;
const clean = (value: unknown, limit: number, field: string) => {
  if (typeof value !== 'string') throw new Error(`${field}必须是文本`);
  const text = value.replace(/\r\n?/gu, '\n').trim();
  if (text.length > limit) throw new Error(`${field}过长（最多 ${limit} 字）`);
  return text;
};
export function emptyHistory(styleId: string, rules: string, savedAt: string): StyleHistory {
  const text = clean(rules, STYLE_HISTORY_LIMITS.rules, '文风规则');
  if (!text) throw new Error('文风规则不能为空');
  return { styleId, current: { version: 1, rules: text, savedAt }, history: [], effects: [] };
}
/** A rule edit only creates a version when the text actually changed; the previous text is kept
 * (capped) so an author can compare or roll back. */
export function reviseRules(entry: StyleHistory, rules: string, savedAt: string): StyleHistory {
  const text = clean(rules, STYLE_HISTORY_LIMITS.rules, '文风规则');
  if (!text) throw new Error('文风规则不能为空');
  if (text === entry.current.rules) return entry;
  const history = [{ ...entry.current }, ...entry.history].slice(0, STYLE_HISTORY_LIMITS.versions);
  return { ...entry, current: { version: entry.current.version + 1, rules: text, savedAt }, history };
}
/** Records what the style actually produced (metrics are counted, not judged). */
export function recordEffect(entry: StyleHistory, effect: EffectRecord): StyleHistory {
  const record: EffectRecord = {
    at: String(effect.at), source: effect.source === 'chapter' ? 'chapter' : 'trial',
    characters: Math.max(0, Math.round(Number(effect.characters) || 0)),
    averageSentence: Math.max(0, Math.round((Number(effect.averageSentence) || 0) * 10) / 10),
    dialogueRatio: Math.min(1, Math.max(0, Math.round((Number(effect.dialogueRatio) || 0) * 1000) / 1000)),
    ...(effect.note ? { note: clean(effect.note, 200, '备注') } : {})
  };
  return { ...entry, effects: [record, ...entry.effects].slice(0, STYLE_HISTORY_LIMITS.effects) };
}
export function restoreVersion(entry: StyleHistory, version: number, savedAt: string): StyleHistory {
  const target = version === entry.current.version ? entry.current : entry.history.find(item => item.version === version);
  if (!target) throw new Error(`找不到第 ${version} 版规则`);
  if (target.rules === entry.current.rules) return entry;
  const history = [{ ...entry.current }, ...entry.history].slice(0, STYLE_HISTORY_LIMITS.versions);
  return { ...entry, current: { version: entry.current.version + 1, rules: target.rules, savedAt }, history };
}
export function summarizeEffects(entry: StyleHistory) {
  if (!entry.effects.length) return null;
  const average = (pick: (record: EffectRecord) => number) => Math.round((entry.effects.reduce((sum, record) => sum + pick(record), 0) / entry.effects.length) * 1000) / 1000;
  return { samples: entry.effects.length, averageCharacters: average(record => record.characters), averageSentence: average(record => record.averageSentence), averageDialogueRatio: average(record => record.dialogueRatio) };
}
