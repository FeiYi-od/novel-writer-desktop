import { types } from 'node:util';
import type { RegexScript } from '../core/st-macros';
import { REGEX_PREVIEW_LIMITS } from './regex-preview';

export interface RegexImportAnalysis {
  scripts: RegexScript[];
  format: 'single' | 'array' | 'scripts';
  /** Names only: values and original data are retained separately, never executed here. */
  unsupportedFields: string[];
  unsupportedFieldCount: number;
}

type Json = null | boolean | number | string | Json[] | { [name: string]: Json };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SCRIPT_FIELDS = new Set(['findRegex', 'find_regex', 'replaceString', 'replace_string', 'disabled', 'flags', 'trimStrings']);
const CONTROL_FIELDS = new Set(['schemaVersion', 'projectId']);
const invalidShape = () => new Error('正则脚本应为数组、单条对象或scripts包装（SillyTavern导出的格式）');

/** Walk plain JSON data with an exact serialized UTF-8 budget. No getter,
 * toJSON method or proxy trap is called, and JSON.stringify is never applied
 * to caller-owned input. The resulting snapshot cannot change during analysis. */
function jsonSnapshot(input: unknown): Json {
  const max = REGEX_PREVIEW_LIMITS.payloadBytes, ancestors = new WeakSet<object>();
  let bytes = 0;
  const add = (count: number) => { bytes += count; if (bytes > max) throw new Error('正则导入数据超过1 MiB'); };
  const string = (value: string) => {
    if (value.length > max - bytes) throw new Error('正则导入数据超过1 MiB');
    add(2);
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || [8, 9, 10, 12, 13].includes(code)) add(2);
      else if (code <= 0x1f) add(6);
      else if (code < 0x80) add(1);
      else if (code < 0x800) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); index++; } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (value: unknown, depth: number): Json => {
    if (depth > 80) throw new Error('正则导入JSON层级超过80层');
    if (value === null) { add(4); return null; }
    if (typeof value === 'string') { string(value); return value; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { add(String(value).length); return value; }
    if (!value || typeof value !== 'object') throw new Error('正则导入只能包含普通JSON数据');
    if (types.isProxy(value)) throw new Error('正则导入不接收代理对象');
    if (ancestors.has(value)) throw new Error('正则导入不能包含循环JSON数据');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('正则导入只能包含普通JSON对象');
    const keys = Reflect.ownKeys(value);
    // Each property needs at least a name, colon and value, so a larger set
    // cannot fit the byte budget even before its values are inspected.
    if (keys.length > Math.floor(max / 4) + 1) throw new Error('正则导入数据超过1 MiB');
    ancestors.add(value);
    try {
      add(2);
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
        if (length > Math.floor((max - bytes + 1) / 2)) throw new Error('正则导入数据超过1 MiB');
        if (keys.length !== length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length)))
          throw new Error('正则导入数组不能包含空洞或额外属性');
        const result: Json[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('正则导入不接收动态属性或稀疏数组');
          if (index) add(1);
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const result = Object.create(null) as { [name: string]: Json };
      let index = 0;
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('正则导入不接收Symbol字段');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('正则导入不接收动态或隐藏属性');
        if (index++) add(1);
        string(key); add(1);
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  return visit(input, 0);
}

const isObject = (value: Json): value is { [name: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name);

/** Normalize supported data fields only. Raw source preservation belongs to
 * MacroStore, so metadata and unknown lifecycle settings are not lost there. */
export function analyzeRegexImport(input: unknown, projectId: string): RegexImportAnalysis {
  if (typeof projectId !== 'string' || !uuid.test(projectId)) throw new Error('正则导入小说标识无效');
  const value = jsonSnapshot(input), unsupported = new Set<string>();
  let format: RegexImportAnalysis['format'], items: Json[];
  if (Array.isArray(value)) { format = 'array'; items = value; }
  else if (isObject(value)) {
    if (own(value, 'schemaVersion') && value.schemaVersion !== 1) throw new Error('不支持的正则脚本文件版本，原文件保持不变');
    if (own(value, 'projectId') && value.projectId !== projectId) throw new Error('正则脚本属于另一部小说，原文件保持不变');
    if (own(value, 'scripts')) {
      if (!Array.isArray(value.scripts)) throw invalidShape();
      format = 'scripts'; items = value.scripts;
      for (const key of Object.keys(value)) if (!CONTROL_FIELDS.has(key) && key !== 'scripts') unsupported.add(key);
    } else if (typeof value.findRegex === 'string' || typeof value.find_regex === 'string') { format = 'single'; items = [value]; }
    else throw invalidShape();
  } else throw invalidShape();
  const limits = REGEX_PREVIEW_LIMITS;
  if (items.length > limits.scripts) throw new Error('正则脚本超过256条，请分开导入');
  const scripts: RegexScript[] = items.map((item, index) => {
    if (!isObject(item)) throw new Error(`第 ${index + 1} 条脚本缺少 findRegex`);
    const findRegex = typeof item.findRegex === 'string' ? item.findRegex : typeof item.find_regex === 'string' ? item.find_regex : '';
    if (!findRegex.trim()) throw new Error(`第 ${index + 1} 条脚本缺少 findRegex`);
    const replaceString = typeof item.replaceString === 'string' ? item.replaceString : typeof item.replace_string === 'string' ? item.replace_string : '';
    const trimStrings = Array.isArray(item.trimStrings) ? item.trimStrings.filter((entry): entry is string => typeof entry === 'string') : [];
    if (findRegex.length > limits.patternCharacters || replaceString.length > limits.replacementCharacters
      || trimStrings.length > limits.trimEntries || trimStrings.some(entry => entry.length > limits.trimCharacters)) throw new Error(`第 ${index + 1} 条正则脚本超过安全长度限制，原文件保持不变`);
    if (typeof item.flags === 'string' && item.flags.length > 64) throw new Error('正则flags过长，原文件保持不变');
    for (const key of Object.keys(item)) if (!SCRIPT_FIELDS.has(key) && !(format === 'single' && CONTROL_FIELDS.has(key))) unsupported.add(key);
    return { findRegex, replaceString, disabled: item.disabled === true, flags: typeof item.flags === 'string' ? item.flags : undefined, trimStrings };
  });
  // Only freshly constructed, bounded data reaches this serialization. Preserve
  // the existing normalized-script budget, including defaults added above.
  if (Buffer.byteLength(JSON.stringify(scripts), 'utf8') > limits.payloadBytes) throw new Error('正则脚本总数据超过1 MiB，原文件保持不变');
  return { scripts, format, unsupportedFields: [...unsupported].slice(0, 64).map(name => name.length > 128 ? `${name.slice(0, 127)}…` : name), unsupportedFieldCount: unsupported.size };
}
