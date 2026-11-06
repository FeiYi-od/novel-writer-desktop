import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSettingCandidates, characterFieldsFrom, worldEntryFrom } from '../src/core/setting-extract';

const text = [
  '角色：林夏',
  '别名：夏夏',
  '外貌：短发，总穿旧外套。',
  '性格：嘴硬心软。',
  '经历：在雾港长大。',
  '目标：找到失踪的哥哥。',
  '说话方式：短句，偶尔反问。',
  '',
  '地点：雾港',
  '类型：地点',
  '正文：终年大雾的海港城，码头分三层。',
  '关键词：雾港,码头,海雾',
  '',
  '这一块没有标题，应被忽略。'
].join('\n');

test('设定提取：角色与地点各成一条候选，字段齐全，无标题块忽略', () => {
  const candidates = extractSettingCandidates(text);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(item => [item.kind, item.name]), [['character', '林夏'], ['world', '雾港']]);
  assert.equal(candidates[0]!.fields['性格'], '嘴硬心软。');
  assert.equal(candidates[1]!.fields['关键词'], '雾港,码头,海雾');
  assert.ok(candidates[0]!.source.includes('林夏'));
});

test('设定提取：人物卡字段映射与世界书条目结构正确', () => {
  const [character, world] = extractSettingCandidates(text);
  const card = characterFieldsFrom(character!);
  assert.equal(card.name, '林夏');
  assert.match(card.creatorNotes, /别名：夏夏/u);
  assert.match(card.description, /外貌|在雾港长大/u);
  assert.equal(card.personality, '嘴硬心软。');
  assert.equal(card.examples, '短句，偶尔反问。');
  const entry = worldEntryFrom(world!);
  assert.deepEqual(entry.key, ['雾港', '码头', '海雾']);
  assert.equal(entry.comment, '雾港');
  assert.match(entry.content, /类型：地点/u);
  assert.match(entry.content, /终年大雾/u);
});

test('设定提取：未知字段不写入，空文本返回空数组', () => {
  const candidates = extractSettingCandidates('角色：甲\n乱写：忽略\n未知：也忽略');
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.fields, {});
  assert.deepEqual(extractSettingCandidates('   \n\n  '), []);
});

test('设定提取：未提供的字段被标出来，不自动补成正史', () => {
  const [character] = extractSettingCandidates('角色：林夏\n性格：嘴硬心软。');
  assert.deepEqual(character!.missing, ['别名', '外貌', '经历', '目标', '关系', '说话方式']);
  const [world] = extractSettingCandidates('地点：雾港\n关键词：雾港');
  assert.deepEqual(world!.missing, ['正文']);
});
