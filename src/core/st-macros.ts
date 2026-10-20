export interface MacroEnv {
  user?: string; char?: string; description?: string; personality?: string; scenario?: string; persona?: string;
  mesExamples?: string; lastMessage?: string; original?: string;
  /** Stable seed so {{pick}} repeats the same choice for the same text (SillyTavern seeds by chat + content + offset). */
  seed?: string;
}
export interface RegexScript { findRegex: string; replaceString: string; disabled?: boolean; flags?: string; trimStrings?: string[] }
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
export function substituteMacros(text: string, env: MacroEnv = {}, random: () => number = Math.random): string {
  let output = text;
  output = output.replace(/{{random\s?::?([^}]+)}}/gi, (_match, list: string) => {
    const items = splitList(list);
    return items.length ? items[Math.floor(random() * items.length)]! : '';
  });
  output = output.replace(/{{pick\s?::?([^}]+)}}/gi, (match, list: string) => {
    const items = splitList(list);
    if (!items.length) return '';
    const offset = text.indexOf(match);
    const rng = HASH(`${env.seed ?? ''}-${HASH(text)}-${offset}`) / 0xffffffff;
    return items[Math.floor(rng * items.length)]!;
  });
  output = output.replace(/{{roll[ :]([^}]+)}}/gi, (_match, formula: string) => {
    const value = rollDice(formula, random);
    return value === null ? '' : String(value);
  });
  output = output.replace(/{{banned\s+"[^"]*"}}/gi, '');
  const simple: Record<string, string | undefined> = {
    user: env.user, char: env.char, description: env.description, personality: env.personality,
    scenario: env.scenario, persona: env.persona, mesexamples: env.mesExamples, lastmessage: env.lastMessage, original: env.original
  };
  output = output.replace(/{{(\w+)}}/gi, (match, name: string) => {
    const key = name.toLowerCase();
    if (key === 'newline') return '\n';
    if (key === 'trim') return match; // 占位，收尾时统一处理
    return key in simple ? (simple[key] ?? '') : match;
  });
  // {{trim}} removes the surrounding newlines, exactly like the reference implementation.
  output = output.replace(/[ \t\r\n]*{{trim}}[ \t\r\n]*/gi, '');
  return output;
}
/** Applies SillyTavern regex scripts in order; `$1`-style backreferences work like JavaScript replace. */
export function applyRegexScripts(text: string, scripts: RegexScript[]): string {
  let output = text;
  for (const script of scripts) {
    if (script.disabled) continue;
    const pattern = script.findRegex?.trim();
    if (!pattern) continue;
    let expression: RegExp;
    try { expression = new RegExp(pattern, script.flags ?? 'giu'); }
    catch { continue; } // A broken script must not break the whole rewrite.
    output = output.replace(expression, script.replaceString ?? '');
    for (const trim of script.trimStrings ?? []) if (trim) output = output.split(trim).join('');
  }
  return output;
}
