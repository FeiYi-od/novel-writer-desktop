import type { CharacterFields } from '../shared/contracts';
import { emptyCharacter } from '../core/characters';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_JSON = 2 * 1024 * 1024;
export function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 原图先读取元数据，显示头像另行缩放，不能先转码再解析卡片。 */
export function pngCardJson(bytes: Buffer): string | null {
  if (bytes.length > 12 * 1024 * 1024 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG 文件无效或超过 12 MB');
  let offset = 8; let ended = false;
  const metadata = new Map<string, string>();
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据块不完整');
    const size = bytes.readUInt32BE(offset); const end = offset + 12 + size;
    if (end > bytes.length) throw new Error('PNG 数据块长度无效');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (bytes.readUInt32BE(end - 4) !== crc32(bytes.subarray(offset + 4, end - 4))) throw new Error('PNG 校验失败，文件可能损坏');
    if (type === 'tEXt') {
      const data = bytes.subarray(offset + 8, end - 4); const separator = data.indexOf(0);
      if (separator > 0 && separator <= 79) {
        const key = data.toString('latin1', 0, separator).toLowerCase();
        if (key === 'chara' || key === 'ccv3') {
          if (metadata.has(key)) throw new Error('PNG 存在重复的角色数据块');
          if (data.length > MAX_JSON * 1.4) throw new Error('角色卡数据过大');
          metadata.set(key, data.toString('ascii', separator + 1));
        }
      }
    }
    offset = end;
    if (type === 'IEND') { if (size !== 0 || offset !== bytes.length) throw new Error('PNG 结束数据无效'); ended = true; break; }
  }
  if (!ended) throw new Error('PNG 缺少结束数据');
  const encoded = metadata.get('ccv3') ?? metadata.get('chara');
  if (encoded === undefined) return null;
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('角色卡 Base64 编码无效');
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('角色卡 Base64 编码无效');
  return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function parseCardJson(text: string) {
  if (Buffer.byteLength(text) > MAX_JSON) throw new Error('角色数据不能超过 2 MB');
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object(raw)) throw new Error('角色卡 JSON 必须是对象');
  // 有界遍历，避免深层扩展耗尽后续序列化/校验调用栈。
  const queue: [unknown, number][] = [[raw, 0]]; let count = 0;
  while (queue.length) {
    const [value, depth] = queue.pop()!;
    if (++count > 100000 || depth > 40) throw new Error('角色卡结构过于复杂');
    if (value && typeof value === 'object') for (const child of Object.values(value)) queue.push([child, depth + 1]);
  }
  const format = raw.spec === undefined ? 'V1' : raw.spec === 'chara_card_v2' ? 'V2' : raw.spec === 'chara_card_v3' ? 'V3' : '';
  if (!format) throw new Error('暂不支持此角色卡规范，原文件未改动');
  const data = format === 'V1' ? raw : raw.data;
  if (!object(data)) throw new Error('角色卡缺少 data 对象');
  const fields = emptyCharacter(); const warnings: string[] = [];
  const mapping: Record<Exclude<keyof CharacterFields, 'alternateGreetings'>, string> = { name: 'name', description: 'description', personality: 'personality', scenario: 'scenario', firstMessage: 'first_mes', examples: 'mes_example', creatorNotes: 'creator_notes', systemPrompt: 'system_prompt', postHistoryInstructions: 'post_history_instructions' };
  for (const [field, key] of Object.entries(mapping)) {
    const value = data[key] ?? (key === 'creator_notes' ? data.creatorcomment : undefined);
    if (value !== undefined && typeof value !== 'string') throw new Error(`角色字段 ${key} 必须是文本`);
    if (typeof value === 'string' && value.length > 100000) throw new Error(`角色字段 ${key} 过长`);
    fields[field as keyof typeof mapping] = value as string ?? '';
  }
  if (!fields.name.trim() || fields.name.length > 200) throw new Error('角色卡名称为空或过长');
  if (data.alternate_greetings !== undefined) {
    if (!Array.isArray(data.alternate_greetings) || data.alternate_greetings.length > 100 || data.alternate_greetings.some(x => typeof x !== 'string' || x.length > 100000)) throw new Error('候选开场白格式无效');
    fields.alternateGreetings = data.alternate_greetings as string[];
  }
  let loreEntries = 0;
  if (data.character_book !== undefined) {
    if (!object(data.character_book) || !Array.isArray(data.character_book.entries)) throw new Error('内嵌世界书格式无效');
    loreEntries = data.character_book.entries.length;
    warnings.push(`内嵌世界书已保留（${loreEntries} 条），尚未启用关键词触发或自动注入。`);
  }
  if (data.extensions && Object.keys(data.extensions).length) warnings.push('扩展字段已保留；插件、正则和脚本不会执行。');
  if (fields.systemPrompt || fields.postHistoryInstructions) warnings.push('卡内系统提示已保留，尚未用于模型请求。');
  if (format === 'V3') warnings.push('V3 基础角色字段可用；资源、昵称宏和群聊等额外行为尚未接入。');
  if (raw.spec_version && raw.spec_version !== (format === 'V3' ? '3.0' : '2.0')) warnings.push(`卡片版本 ${String(raw.spec_version)} 未完整验证；原始数据保留。`);
  return { fields, raw, format, warnings, loreEntries };
}
