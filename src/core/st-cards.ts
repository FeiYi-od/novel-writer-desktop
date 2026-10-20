export interface CardFields {
  name: string; description: string; personality: string; scenario: string;
  firstMessage: string; exampleDialogue: string; creatorNotes: string;
  systemPrompt: string; postHistoryInstructions: string;
  alternateGreetings: string[]; tags: string[]; creator: string; characterVersion: string;
  extensions: Record<string, unknown>;
}
export interface StCard { specVersion: 1 | 2 | 3; data: CardFields; characterBook?: StWorldInfo }
export type SelectiveLogic = 'AND_ANY' | 'NOT_ALL' | 'NOT_ANY' | 'AND_ALL';
export type EntryPosition = 'before_char' | 'after_char' | 'at_depth';
export interface CharacterFilter { isExclude: boolean; names: string[]; tags: string[] }
export interface StWorldEntry {
  id: string; keys: string[]; secondaryKeys: string[]; content: string; comment: string;
  selective: boolean; selectiveLogic: SelectiveLogic; constant: boolean; disabled: boolean;
  order: number; position: EntryPosition; depth: number | null; probability: number; caseSensitive: boolean;
  characterFilter?: CharacterFilter; useProbability?: boolean; extensions?: Record<string, unknown>;
}
export interface WorldScanOptions {
  limit?: number; random?: () => number; characterNames?: string[];
  /** SillyTavern scans inserted content again, up to this many extra passes. */
  maxRecursion?: number; scanDepth?: number;
}
export interface StWorldInfo { name: string; entries: StWorldEntry[]; extensions: Record<string, unknown> }
const asText = (value: unknown) => (typeof value === 'string' ? value : '');
const asArray = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const asBool = (value: unknown, fallback = false) => (typeof value === 'boolean' ? value : value === 1 ? true : value === 0 ? false : fallback);
const asNumber = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const logicCode: Record<SelectiveLogic, number> = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
const positionCode: Record<EntryPosition, number> = { before_char: 0, after_char: 1, at_depth: 4 };
/** Exports the SillyTavern V2 card shape (spec chara_card_v2, spec_version 2.0, 14 required data fields). */
export function buildCardV2(fields: CardFields, characterBook?: StWorldInfo) {
  return {
    spec: 'chara_card_v2' as const, spec_version: '2.0' as const,
    data: {
      name: fields.name, description: fields.description, personality: fields.personality, scenario: fields.scenario,
      first_mes: fields.firstMessage, mes_example: fields.exampleDialogue,
      creator_notes: fields.creatorNotes, system_prompt: fields.systemPrompt,
      post_history_instructions: fields.postHistoryInstructions,
      alternate_greetings: [...fields.alternateGreetings], tags: [...fields.tags],
      creator: fields.creator, character_version: fields.characterVersion, extensions: { ...fields.extensions },
      ...(characterBook ? { character_book: toCharacterBook(characterBook) } : {})
    }
  };
}
/** V3 keeps the same data block; only spec/spec_version change (SillyTavern accepts any 3.x). */
export function buildCardV3(fields: CardFields, characterBook?: StWorldInfo) {
  const v2 = buildCardV2(fields, characterBook);
  return { ...v2, spec: 'chara_card_v3' as const, spec_version: '3.0' as const };
}
export function toCharacterBook(world: StWorldInfo) {
  return {
    name: world.name, extensions: { ...world.extensions },
    entries: world.entries.map((entry, index) => ({
      id: index, keys: [...entry.keys], secondary_keys: [...entry.secondaryKeys], content: entry.content, comment: entry.comment,
      selective: entry.selective, constant: entry.constant, enabled: !entry.disabled,
      insertion_order: entry.order, position: entry.position === 'before_char' ? 'before_char' : 'after_char',
      case_sensitive: entry.caseSensitive,
      // SillyTavern's convertCharacterBook reads these fields from entry.extensions.
      extensions: {
        ...entry.extensions, selectiveLogic: logicCode[entry.selectiveLogic], position: positionCode[entry.position],
        depth: entry.depth ?? 4, probability: entry.probability, useProbability: entry.useProbability ?? true,
        case_sensitive: entry.caseSensitive
      }
    }))
  };
}
/** Reads V1, V2 or V3 cards (including the JSON behind a PNG `chara`/`ccv3` chunk). */
export function parseCard(input: unknown): StCard {
  const card = input as Record<string, unknown>;
  if (!card || typeof card !== 'object') throw new Error('角色卡不是有效的 JSON');
  const spec = asText(card.spec);
  if (spec === 'chara_card_v2' || spec === 'chara_card_v3') {
    const data = card.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') throw new Error('角色卡缺少 data 字段');
    const version = spec === 'chara_card_v3' ? 3 : 2;
    const required = ['name', 'description'] as const;
    for (const key of required) if (typeof data[key] !== 'string') throw new Error(`角色卡 data.${key} 缺失`);
    const extensions = (data.extensions && typeof data.extensions === 'object' ? data.extensions : {}) as Record<string, unknown>;
    return {
      specVersion: version as 2 | 3,
      characterBook: data.character_book ? parseCharacterBook(data.character_book) : undefined,
      data: {
        name: asText(data.name), description: asText(data.description), personality: asText(data.personality), scenario: asText(data.scenario),
        firstMessage: asText(data.first_mes), exampleDialogue: asText(data.mes_example), creatorNotes: asText(data.creator_notes),
        systemPrompt: asText(data.system_prompt), postHistoryInstructions: asText(data.post_history_instructions),
        alternateGreetings: asArray(data.alternate_greetings), tags: asArray(data.tags),
        creator: asText(data.creator), characterVersion: asText(data.character_version), extensions
      }
    };
  }
  // V1: flat fields.
  if (typeof card.name !== 'string' || typeof card.description !== 'string') throw new Error('无法识别的角色卡格式（既不是 V1 也不是 V2/V3）');
  return {
    specVersion: 1,
    data: {
      name: asText(card.name), description: asText(card.description), personality: asText(card.personality), scenario: asText(card.scenario),
      firstMessage: asText(card.first_mes), exampleDialogue: asText(card.mes_example), creatorNotes: asText(card.creator_notes ?? card.creatorcomment),
      systemPrompt: asText(card.system_prompt), postHistoryInstructions: asText(card.post_history_instructions),
      alternateGreetings: asArray(card.alternate_greetings), tags: asArray(card.tags),
      creator: asText(card.creator), characterVersion: asText(card.character_version), extensions: {}
    }
  };
}
/** Cards may embed their own lorebook; it parses with the same rules as a standalone book. */
export function parseCardBook(input: unknown): StWorldInfo { return parseCharacterBook(input); }
function parseCharacterBook(input: unknown): StWorldInfo {
  const book = input as Record<string, unknown>;
  const entries = Array.isArray(book.entries) ? book.entries : [];
  return {
    name: asText(book.name), extensions: (book.extensions && typeof book.extensions === 'object' ? book.extensions : {}) as Record<string, unknown>,
    entries: entries.map((raw, index) => {
      const entry = raw as Record<string, unknown>;
      const extensions = asRecord(entry.extensions);
      const depth = extensions.depth ?? entry.depth;
      return {
        id: String(entry.id ?? index), keys: asArray(entry.keys ?? entry.key), secondaryKeys: asArray(entry.secondary_keys ?? entry.keysecondary),
        content: asText(entry.content), comment: asText(entry.comment ?? entry.name),
        selective: asBool(entry.selective), selectiveLogic: normalizeLogic(extensions.selectiveLogic ?? entry.selectiveLogic),
        constant: asBool(entry.constant), disabled: !asBool(entry.enabled, true),
        order: asNumber(entry.insertion_order ?? entry.order, 100), position: toPosition(extensions.position ?? entry.position),
        characterFilter: toCharacterFilter(entry.characterFilter ?? entry.character_filter),
        depth: typeof depth === 'number' && Number.isFinite(depth) ? depth : null,
        probability: asNumber(extensions.probability ?? entry.probability, 100),
        useProbability: asBool(extensions.useProbability ?? entry.useProbability, true),
        caseSensitive: asBool(extensions.case_sensitive ?? entry.case_sensitive), extensions: { ...extensions }
      };
    })
  };
}
function normalizeLogic(value: unknown): SelectiveLogic {
  if (value === 'AND_ANY' || value === 'NOT_ALL' || value === 'NOT_ANY' || value === 'AND_ALL') return value;
  const raw = asNumber(value, 0);
  if (raw === 1) return 'NOT_ALL'; if (raw === 2) return 'NOT_ANY'; if (raw === 3) return 'AND_ALL';
  return 'AND_ANY';
}
/** World info files are `{ entries: { "0": {...} } }` with string keys, not an array. */
export function parseWorldInfoFile(input: unknown): StWorldInfo {
  const file = input as Record<string, unknown>;
  const raw = file?.entries;
  if (!raw || typeof raw !== 'object') throw new Error('世界书文件缺少 entries');
  const list = Array.isArray(raw) ? raw.map((entry, index) => [String(index), entry] as const) : Object.entries(raw as Record<string, unknown>);
  return {
    name: asText(file.name), extensions: (file.extensions && typeof file.extensions === 'object' ? file.extensions : {}) as Record<string, unknown>,
    entries: list.map(([id, value]) => {
      const entry = value as Record<string, unknown>;
      return {
        id, keys: asArray(entry.key ?? entry.keys), secondaryKeys: asArray(entry.keysecondary ?? entry.secondary_keys),
        content: asText(entry.content), comment: asText(entry.comment ?? entry.name),
        selective: asBool(entry.selective), selectiveLogic: normalizeLogic(entry.selectiveLogic),
        constant: asBool(entry.constant), disabled: asBool(entry.disable) || !asBool(entry.enabled, true),
        order: asNumber(entry.order ?? entry.insertion_order, 100), position: toPosition(entry.position),
        characterFilter: toCharacterFilter(entry.characterFilter ?? entry.character_filter),
        depth: typeof entry.depth === 'number' ? entry.depth : null, probability: asNumber(entry.probability, 100), caseSensitive: asBool(entry.caseSensitive),
        useProbability: asBool(entry.useProbability, true), extensions: { ...asRecord(entry.extensions) }
      };
    })
  };
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
function toPosition(value: unknown): EntryPosition {
  if (value === 'before_char' || value === 'at_depth' || value === 'after_char') return value;
  if (value === 4 || value === '4') return 'at_depth';
  if (value === 0 || value === '0') return 'before_char';
  return 'after_char';
}
function toCharacterFilter(value: unknown): CharacterFilter | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const filter = value as Record<string, unknown>;
  const names = asArray(filter.names), tags = asArray(filter.tags);
  if (!names.length && !tags.length) return undefined;
  return { isExclude: asBool(filter.isExclude ?? filter.is_exclude), names, tags };
}
/** Character filters only apply when the caller tells us which characters are in this scene. */
function passesFilter(entry: StWorldEntry, characterNames?: string[]) {
  const filter = entry.characterFilter;
  if (!filter || !characterNames) return true;
  const matched = filter.names.some(name => characterNames.includes(name));
  return filter.isExclude ? !matched : matched;
}
/** SillyTavern triggers on "any primary key matches"; secondary keys narrow it down by logic.
 * Adds probability, recursion (scan inserted content again) and character filters. */
export function selectWorldEntries(world: StWorldInfo, text: string, options: WorldScanOptions | number = 8): StWorldEntry[] {
  const config: WorldScanOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = config.limit ?? 8, random = config.random ?? Math.random;
  const maxRecursion = Math.max(0, config.maxRecursion ?? 2);
  const scanDepth = Math.max(0, config.scanDepth ?? 4000);
  const hit = (keywords: string[], entry: StWorldEntry, haystack: string) => keywords.some(keyword => {
    const word = keyword.trim();
    if (!word) return false;
    return new RegExp(escapeRegExp(word), entry.caseSensitive ? 'u' : 'iu').test(haystack);
  });
  const matches = (entry: StWorldEntry, haystack: string) => {
    if (!hit(entry.keys, entry, haystack)) return false;
    if (!entry.selective || !entry.secondaryKeys.length) return true;
    const secondary = entry.secondaryKeys.map(keyword => hit([keyword], entry, haystack));
    switch (entry.selectiveLogic) {
      case 'NOT_ALL': return !secondary.every(Boolean);
      case 'NOT_ANY': return !secondary.some(Boolean);
      case 'AND_ALL': return secondary.every(Boolean);
      default: return secondary.some(Boolean);
    }
  };
  const rolls = new Map<string, boolean>();
  const rollPass = (entry: StWorldEntry) => {
    if (entry.useProbability === false) return true;
    if (entry.probability >= 100) return true;
    if (entry.probability <= 0) return false;
    if (!rolls.has(entry.id)) rolls.set(entry.id, random() * 100 < entry.probability);
    return rolls.get(entry.id)!;
  };
  const chosen: StWorldEntry[] = [];
  const seen = new Set<string>();
  const accept = (entry: StWorldEntry) => {
    if (seen.has(entry.id) || !passesFilter(entry, config.characterNames) || !rollPass(entry)) return false;
    seen.add(entry.id); chosen.push(entry); return true;
  };
  for (const entry of world.entries) if (!entry.disabled && entry.constant) accept(entry);
  let haystack = text.slice(-scanDepth);
  for (let pass = 0; pass <= maxRecursion; pass++) {
    // Each pass scans the text as it looked at the start of the pass; content added by this pass is
    // only visible to the next one, which is what "recursion" means in SillyTavern.
    const snapshot = haystack;
    const fresh: StWorldEntry[] = [];
    for (const entry of world.entries) {
      if (entry.disabled || entry.constant || seen.has(entry.id)) continue;
      if (!matches(entry, snapshot)) continue;
      if (!accept(entry)) continue;
      fresh.push(entry);
    }
    if (!fresh.length) break;
    haystack = (snapshot + '\n' + fresh.map(item => item.content).join('\n')).slice(-scanDepth);
  }
  return chosen.sort((left, right) => right.order - left.order).slice(0, limit);
}
