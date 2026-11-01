export interface MacroEnv {
  user?: string; char?: string; description?: string; personality?: string; scenario?: string; persona?: string;
  mesExamples?: string; lastMessage?: string; original?: string;
  /** Explicit, ephemeral Nicknames-extension preview; absent means unknown macros stay visible. */
  nicknamePreviewEnabled?: boolean; useNicknameForMacros?: boolean; userNickname?: string; charNickname?: string;
  /** Stable seed so {{pick}} repeats the same choice for the same text (SillyTavern seeds by chat + content + offset). */
  seed?: string;
}
export interface RegexScript { findRegex: string; replaceString: string; disabled?: boolean; flags?: string; trimStrings?: string[] }
/** Optional for isolated previews; ordinary callers retain the original semantics. */
function outputLimit(value: number | undefined): number {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('正则预览输出上限无效');
  return value;
}
function checkOutput(text: string, limit: number): string {
  if (text.length > limit) throw new Error('宏或正则展开超过预览输出上限');
  return text;
}
/** Bound each completed prefix before native replace can join a large result.
 * The unchanged final suffix is at most one already-bounded input long. */
function boundedReplace(text: string, expression: RegExp, replacer: (...args: any[]) => string, limit: number): string {
  checkOutput(text, limit);
  if (limit === Infinity) return text.replace(expression, replacer);
  let cursor = 0, produced = 0;
  const output = text.replace(expression, (...args: any[]) => {
    const named = typeof args.at(-1) === 'object' && args.at(-1) !== null;
    const offset = args[args.length - (named ? 3 : 2)] as number;
    produced += offset - cursor;
    const replacement = String(replacer(...args));
    produced += replacement.length;
    if (produced > limit) throw new Error('宏或正则展开超过预览输出上限');
    cursor = offset + (args[0] as string).length;
    return replacement;
  });
  return checkOutput(output, limit);
}
const HASH = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash >>> 0;
};
const splitList = (raw: string) => raw.includes('::')
  ? raw.split('::')
  : raw.replace(/\\,/gu, '\u0000').split(',').map(item => item.trim().replace(/\u0000/gu, ','));
/** Rolls standard dice notation: `2d6`, `1d20+3`, plain `6` meaning `1d6`. */
export function rollDice(formula: string, random: () => number = Math.random): number | null {
  const text = formula.trim().toLowerCase();
  const plain = /^\d+$/u.exec(text);
  const notation = plain ? `1d${text}` : text;
  const match = /^(\d*)d(\d+)((?:[+-]\d+)*)$/u.exec(notation);
  if (!match) return null;
  const count = Math.min(100, Number(match[1] || 1));
  const sides = Number(match[2]);
  if (!count || !sides) return null;
  let total = 0;
  for (let index = 0; index < count; index++) total += 1 + Math.floor(random() * sides);
  for (const part of match[3].match(/[+-]\d+/gu) ?? []) total += Number(part);
  return total;
}
/** Substitutes the SillyTavern macros we support; unknown macros are left untouched on purpose so the
 * author can see what the target platform would still expand. */
export function substituteMacros(text: string, env: MacroEnv = {}, random: () => number = Math.random, maxOutputCharacters?: number): string {
  const limit = outputLimit(maxOutputCharacters);
  let output = checkOutput(text, limit);
  output = boundedReplace(output, /{{random\s?::?([^}]+)}}/gi, (_match, list: string) => {
    const items = splitList(list);
    return items.length ? items[Math.floor(random() * items.length)]! : '';
  }, limit);
  output = boundedReplace(output, /{{pick\s?::?([^}]+)}}/gi, (_match, list: string, offset: number) => {
    const items = splitList(list);
    if (!items.length) return '';
    const rng = HASH(`${env.seed ?? ''}-${HASH(text)}-${offset}`) / 0xffffffff;
    return items[Math.floor(rng * items.length)]!;
  }, limit);
  output = boundedReplace(output, /{{roll[ :]([^}]+)}}/gi, (_match, formula: string) => {
    const value = rollDice(formula, random);
    return value === null ? '' : String(value);
  }, limit);
  output = boundedReplace(output, /{{banned\s+"[^"]*"}}/gi, () => '', limit);
  const originalUser = env.user ?? '', originalChar = env.char ?? '';
  const userNickname = env.userNickname?.trim() || originalUser, charNickname = env.charNickname?.trim() || originalChar;
  const overrideNames = env.nicknamePreviewEnabled === true && env.useNicknameForMacros === true;
  const simple: Record<string, string | undefined> = {
    user: overrideNames ? userNickname : env.user, char: overrideNames ? charNickname : env.char, description: env.description, personality: env.personality,
    scenario: env.scenario, persona: env.persona, mesexamples: env.mesExamples, lastmessage: env.lastMessage, original: env.original
  };
  if (env.nicknamePreviewEnabled === true) Object.assign(simple, { userfull: originalUser, charfull: originalChar, usernickname: userNickname, charnickname: charNickname });
  output = boundedReplace(output, /{{(\w+)}}/gi, (match, name: string) => {
    const key = name.toLowerCase();
    if (key === 'newline') return '\n';
    if (key === 'trim') return match; // 占位，收尾时统一处理
    return Object.hasOwn(simple, key) ? (simple[key] ?? '') : match;
  }, limit);
  // {{trim}} removes the surrounding newlines, exactly like the reference implementation.
  output = boundedReplace(output, /[ \t\r\n]*{{trim}}[ \t\r\n]*/gi, () => '', limit);
  return output;
}
/** Parse exported `/pattern/flags` values without adding flags that change script meaning.
 * Bare patterns also accept our explicit `flags` field, for older local scripts. */
function scriptExpression(script: RegexScript): RegExp | null {
  const raw = script.findRegex;
  if (!raw?.trim()) return null;
  let pattern = raw, flags = script.flags ?? '';
  if (raw.startsWith('/')) {
    const closing = raw.lastIndexOf('/');
    if (closing > 0) {
      pattern = raw.slice(1, closing);
      flags = raw.slice(closing + 1);
    }
  }
  try { return new RegExp(pattern, flags); }
  catch { return null; }
}
/** Matches the exported regex engine's capture filtering. `$&` is a local alias for `$0`;
 * unknown macros remain visible. No plugin code or chat lifecycle hooks are executed. */
export function applyRegexScripts(text: string, scripts: RegexScript[], env: MacroEnv = {}, maxOutputCharacters?: number): string {
  const limit = outputLimit(maxOutputCharacters);
  let output = checkOutput(text, limit);
  for (const script of scripts) {
    if (script.disabled) continue;
    const expression = scriptExpression(script);
    if (!expression) continue; // A broken script must not break the whole rewrite.
    const trims = (script.trimStrings ?? []).map(trim => substituteMacros(trim, env, Math.random, maxOutputCharacters)).filter(Boolean);
    const template = (script.replaceString ?? '').replace(/{{match}}/gi, '$0');
    output = boundedReplace(output, expression, (...args: unknown[]) => {
      const last = args[args.length - 1];
      const named = last && typeof last === 'object' ? last as Record<string, unknown> : undefined;
      // The tail also contains match offset and input, neither is a capture group.
      const captures = args.slice(0, args.length - (named ? 3 : 2));
      const replacement = boundedReplace(template, /\$(\d+)|\$<([^>]+)>|\$&/gu, (token, number: string | undefined, name: string | undefined) => {
        const value = token === '$&' ? captures[0] : number !== undefined ? captures[Number(number)] : named?.[name!];
        let filtered = typeof value === 'string' ? value : '';
        for (const trim of trims) filtered = filtered.split(trim).join('');
        return filtered;
      }, limit);
      return substituteMacros(replacement, env, Math.random, maxOutputCharacters);
    }, limit);
  }
  return output;
}
