import test from 'node:test';
import assert from 'node:assert/strict';
import { chatPresets } from '../src/shared/model-presets';

test('模型预设：每个对话预设要么可用并给出协议说明，要么明确禁用并写明原因', () => {
  for (const preset of chatPresets) {
    assert.ok(preset.note.length > 6, `${preset.label} 缺少说明`);
    if (!preset.available) {
      assert.match(preset.note, /尚未适配|暂不提供/u, `${preset.label} 的禁用原因要写清楚`);
      continue;
    }
    assert.ok(preset.value.adapter, `${preset.label} 可用但没有适配器`);
    if (!/自行填写/u.test(preset.note)) assert.ok((preset.value.baseUrl ?? '').length > 0, `${preset.label} 缺接口地址`);
  }
});

test('模型预设：原先禁用的专用协议已落到具体适配器', () => {
  const byLabel = new Map(chatPresets.map(preset => [preset.label, preset]));
  assert.equal(byLabel.get('OpenAI Responses')?.value.adapter, 'responses');
  assert.equal(byLabel.get('DeepSeek Responses')?.value.adapter, 'responses');
  assert.equal(byLabel.get('xAI')?.value.adapter, 'responses');
  assert.equal(byLabel.get('Kimi Coding Plan')?.value.adapter, 'anthropic');
  assert.equal(byLabel.get('MiniMax Token Plan')?.value.adapter, 'anthropic');
  assert.equal(byLabel.get('Xiaomi Token Plan')?.value.adapter, 'anthropic');
  assert.equal(byLabel.get('Xiaomi')?.value.adapter, 'generic');
  assert.equal(byLabel.get('Ollama · 本机原生')?.value.adapter, 'ollama');
  assert.equal(byLabel.get('通义千问 · 百炼北京')?.value.adapter, 'qwen');
  // 不允许出现"可用但适配器未定义"的空档
  assert.equal(chatPresets.filter(preset => preset.available && !preset.value.adapter).length, 0);
});
