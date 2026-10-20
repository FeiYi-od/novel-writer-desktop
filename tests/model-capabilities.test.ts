import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilitySummary, describeModel, filterModels } from '../src/core/model-capabilities';

test('模型能力：按命名与上报长度识别推理、视觉与长上下文', () => {
  const reasoning = describeModel({ id: 'deepseek-reasoner' });
  assert.equal(reasoning.reasoning, true);
  assert.ok(reasoning.capabilities.includes('reasoning'));
  const vision = describeModel({ id: 'qwen2.5-vl-72b' });
  assert.equal(vision.vision, true);
  const long = describeModel({ id: 'some-model', context_length: 200_000 });
  assert.equal(long.contextLength, 200_000);
  assert.ok(long.capabilities.includes('long-context'));
  assert.match(capabilitySummary(long), /200k/u);
  assert.equal(describeModel({ id: 'plain-chat' }).capabilities.includes('reasoning'), false);
  assert.equal(describeModel({ id: 'text-embedding-3-large' }).capabilities.includes('tools'), false, '向量模型不当作对话模型');
});

test('模型能力：按能力筛选，文本能力隐含', () => {
  const models = [describeModel({ id: 'alpha-chat' }), describeModel({ id: 'beta-vl' }), describeModel({ id: 'gamma-reasoner' })];
  assert.deepEqual(filterModels(models, ['vision']).map(model => model.id), ['beta-vl']);
  assert.deepEqual(filterModels(models, ['reasoning']).map(model => model.id), ['gamma-reasoner']);
  assert.deepEqual(filterModels(models, []).map(model => model.id), ['alpha-chat', 'beta-vl', 'gamma-reasoner'], '不筛选时按 id 排序');
  assert.deepEqual(filterModels(models, ['vision', 'reasoning']), []);
});

test('模型能力：标签可读，未知长度不外推', () => {
  assert.equal(describeModel({ id: 'openai/gpt-4o-mini' }).label, 'gpt 4o mini');
  assert.equal(describeModel({ id: 'x' }).contextLength, null);
  assert.equal(capabilitySummary(describeModel({ id: 'x' })), '工具', '未知模型默认按支持工具处理，只显示能确定的标签');
  assert.match(capabilitySummary(describeModel({ id: 'gemini-2.5-pro' })), /视觉/u);
  assert.equal(describeModel({ id: 'x', context_length: -5 }).contextLength, null, '负数长度视为未上报');
});
