import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/main/card-parser';

export const v1 = { name: '林夏', description: '守信的图书管理员。', personality: '内向但勇敢', scenario: '雨中的学园', first_mes: '初次见面。', mes_example: '示例对话不进入正史。' };
export const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...v1, creator_notes: '作者私有说明', system_prompt: '卡片系统指令', post_history_instructions: '', alternate_greetings: ['你好。'], tags: ['学园'], creator: '测试作者', character_version: '1', extensions: { custom: { secret: '原样保留' } }, character_book: { extensions: {}, entries: [{ keys: ['学园'], content: '测试世界书', enabled: true, insertion_order: 10, extensions: { custom: true } }] } } };
export function chunk(type: string, data: Buffer) {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
export function cardPng(items: { key: string; value: unknown }[] = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,80,140,110,255]))),
    ...items.map(item => chunk('tEXt', Buffer.from(`${item.key}\0${Buffer.from(JSON.stringify(item.value)).toString('base64')}`))), chunk('IEND', Buffer.alloc(0))]);
}
