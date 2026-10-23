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
  assert.equal(applyRegexScripts(input, scripts), '他说你好~~', 'trimStrings 不会清除未匹配原文中的字符');
  assert.equal(applyRegexScripts('不变', [{ findRegex: '不', replaceString: '改', disabled: true }]), '不变');
});

test('正则兼容矩阵：酒馆斜线表达式、默认flags、捕获与局部清理', async t => {
  const cases = [
    { name: 'slash flags决定全局且忽略大小写', text: 'CAT cat', script: { findRegex: '/cat/gi', replaceString: '猫' }, expected: '猫 猫' },
    { name: 'bare表达式默认只替换第一次且区分大小写', text: 'CAT cat cat', script: { findRegex: 'cat', replaceString: '猫' }, expected: 'CAT 猫 cat' },
    { name: 'bare表达式显式flags仍受支持', text: 'CAT cat', script: { findRegex: 'cat', flags: 'gi', replaceString: '猫' }, expected: '猫 猫' },
    { name: 'bare表达式中空格是有意义的模式字符', text: 'cat cat cat', script: { findRegex: ' cat ', replaceString: '猫' }, expected: 'cat猫cat' },
    { name: 'slash表达式使用自身flags', text: 'CAT cat cat', script: { findRegex: '/cat/', flags: 'gi', replaceString: '猫' }, expected: 'CAT 猫 cat' },
    { name: '转义斜线及多行点匹配', text: 'a/b\na/b\na\nb', script: { findRegex: '/a\\/b/g', replaceString: '路' }, expected: '路\n路\na\nb' },
    { name: 'dotAll与multiline', text: 'a\nb', script: { findRegex: '/^a.b$/ms', replaceString: '行' }, expected: '行' },
    { name: 'trim仅清理模板引用的捕获组', text: '~外~(~~内~~)~外~', script: { findRegex: '/\\((.*?)\\)/g', replaceString: '~$1~', trimStrings: ['~'] }, expected: '~外~~内~~外~' },
    { name: '无匹配不应全局清理原文', text: '~~原文~~', script: { findRegex: '/不存在/g', replaceString: '$0', trimStrings: ['~'] }, expected: '~~原文~~' },
    { name: '全匹配宏0与$&别名', text: '[~~林岚~~]', script: { findRegex: '/\\[(.*?)\\]/', replaceString: '{{match}}|$0|$&|$1', trimStrings: ['~'] }, expected: '[林岚]|[林岚]|[林岚]|林岚' },
    { name: '命名与缺省捕获组', text: '林岚', script: { findRegex: '/(?<hero>林岚)(雨)?/', replaceString: '$<hero>|$2|$99|$<missing>' }, expected: '林岚|||' },
    { name: '捕获组内美元符号不会被二次当作替换标记', text: '[$&]', script: { findRegex: '/\\[(.*?)\\]/', replaceString: '$1' }, expected: '$&' },
    { name: '多个编号捕获包含10号', text: 'abcdefghij', script: { findRegex: '/(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/', replaceString: '$10$1$0' }, expected: 'jaabcdefghij' },
    { name: '重复flags非法时仅跳过当前脚本', text: 'cat', script: { findRegex: '/cat/gg', replaceString: '猫' }, expected: 'cat' },
    { name: '不兼容flags不应降级误改', text: 'cat', script: { findRegex: '/cat/x', replaceString: '猫' }, expected: 'cat' },
    { name: '空完整表达式遵循JS零宽替换', text: '林', script: { findRegex: '/(?:)/g', replaceString: '|' }, expected: '|林|' }
  ];
  for (const row of cases) await t.test(row.name, () => assert.equal(applyRegexScripts(row.text, [row.script]), row.expected));
});
