import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStylePrompt } from '../src/core/style-trial-prompt';
import { createStyleTrialSender } from '../src/main/style-trial-sender';
import { StyleTrialService } from '../src/main/style-trial';

test('试写提示词：规则进 system、剧情进 user，并约束只写一段正文', () => {
  const messages = buildStylePrompt({ brief: '林夏抵达北门，月钥发亮。', styleName: '冷峻', rules: '短句，少形容词。', targetChars: 400 });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /冷峻/u);
  assert.match(messages[0].content, /短句，少形容词。/u);
  assert.match(messages[0].content, /约 400 字/u);
  assert.match(messages[0].content, /不要解释/u);
  assert.deepEqual(messages[1], { role: 'user', content: '林夏抵达北门，月钥发亮。' });
});

test('试写提示词：空剧情与超长内容被拒绝，缺规则时给出默认约束', () => {
  assert.throws(() => buildStylePrompt({ brief: '  ', styleName: 'x', rules: '' }), /剧情要求/u);
  assert.throws(() => buildStylePrompt({ brief: 'x'.repeat(4001), styleName: 'x', rules: '' }), /过长/u);
  assert.throws(() => buildStylePrompt({ brief: 'x', styleName: 'x', rules: 'y'.repeat(4001) }), /文风规则过长/u);
  const messages = buildStylePrompt({ brief: '场景', styleName: '', rules: '' });
  assert.match(messages[0].content, /保持该文风一贯的句式/u);
  assert.match(messages[0].content, /指定/u);
});

test('试写发送器：按文风取规则，取消后不再请求模型', async () => {
  const seen: string[] = [];
  const sender = createStyleTrialSender({
    rulesFor: styleId => `规则-${styleId}`,
    complete: async messages => { seen.push(`${messages[0].content.includes('规则-b') ? 'b' : 'a'}`); return '  正文  '; }
  });
  const service = new StyleTrialService(sender);
  const result = await service.run({ brief: '场景', styles: [{ styleId: 'a', styleName: '甲' }, { styleId: 'b', styleName: '乙' }] });
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(result.variants.map(item => item.text), ['正文', '正文'], '发送器应去掉首尾空白');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => sender({ styleId: 'a', styleName: '甲' }, '场景', controller.signal));
});
