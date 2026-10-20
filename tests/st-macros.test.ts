import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRegexScripts, rollDice, substituteMacros } from '../src/core/st-macros';

test('宏：常用占位符替换，未知宏原样保留', () => {
  const env = { user: '作者', char: '林夏', description: '雨夜的旅人', scenario: '北门客栈', lastMessage: '你来了。' };
  assert.equal(substituteMacros('{{char}}对{{user}}说：{{lastMessage}}', env), '林夏对作者说：你来了。');
  assert.equal(substituteMacros('{{description}}／{{scenario}}', env), '雨夜的旅人／北门客栈');
  assert.equal(substituteMacros('第一行{{newline}}第二行', env), '第一行\n第二行');
  assert.equal(substituteMacros('{{unknownMacro}}', env), '{{unknownMacro}}', '不认识的宏保持原样，便于作者发现');
  assert.equal(substituteMacros('{{banned "某个词"}}正文', env), '正文');
  assert.equal(substituteMacros('a{{trim}}\nb', env), 'ab', '{{trim}} 去掉周围换行');
});

test('宏：random 用给定随机数，pick 对同一段文本结果稳定', () => {
  assert.equal(substituteMacros('{{random::甲::乙::丙}}', {}, () => 0.99), '丙');
  assert.equal(substituteMacros('{{random:甲, 乙, 丙}}', {}, () => 0), '甲');
  assert.equal(substituteMacros('{{random:a\\,b, c}}', {}, () => 0), 'a,b', '逗号分隔时转义逗号不应被切分');
  const first = substituteMacros('{{pick::红::绿::蓝}}', { seed: 'chat-1' });
  const again = substituteMacros('{{pick::红::绿::蓝}}', { seed: 'chat-1' });
  const other = substituteMacros('{{pick::红::绿::蓝}}', { seed: 'chat-2' });
  assert.equal(first, again, '同一 seed 与文本应得到相同选择');
  assert.ok(['红', '绿', '蓝'].includes(other));
});

test('宏：骰子公式与非法公式', () => {
  assert.equal(rollDice('6', () => 0.5), 4, '纯数字按 1d6 处理');
  assert.equal(rollDice('2d6', () => 0.5), 8);
  assert.equal(rollDice('1d20+3', () => 0), 4);
  assert.equal(rollDice('d'), null);
  assert.equal(rollDice('2x6'), null);
  assert.equal(substituteMacros('{{roll:1d6}}', {}, () => 0.5), '4');
  assert.equal(substituteMacros('{{roll bad}}', {}, () => 0.5), '');
});

test('正则脚本：按顺序应用、支持反向引用与 trimStrings，坏正则会跳过', () => {
  const scripts = [
    { findRegex: '\\((.*?)\\)', replaceString: '（$1）' },
    { findRegex: '（小声）', replaceString: '' },
    { findRegex: '[', replaceString: 'x' },
    { findRegex: '噪声', replaceString: '', trimStrings: ['~'] }
  ];
  const input = '他说(小声)你好~噪声~';
  assert.equal(applyRegexScripts(input, scripts), '他说你好', 'trimStrings 会把需要清理的字符从结果里去掉');
  assert.equal(applyRegexScripts('不变', [{ findRegex: '不', replaceString: '改', disabled: true }]), '不变');
});
