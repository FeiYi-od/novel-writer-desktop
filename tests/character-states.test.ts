import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStates, describeRange, normalizeState, statesForChapter, type CharacterState } from '../src/core/character-states';

const state = (character: string, label: string, extra: Partial<CharacterState> = {}): CharacterState =>
  ({ id: '', character, label, note: '', ...extra });

test('人物状态：校验角色、名称、章节范围与重复', () => {
  assert.throws(() => normalizeState({ character: '', label: '受伤' }), /请选择角色/u);
  assert.throws(() => normalizeState({ character: '林夏', label: ' ' }), /状态名称/u);
  assert.throws(() => normalizeState({ character: '林夏', label: '受伤', fromChapter: 5, toChapter: 3 }), /不能早于/u);
  assert.throws(() => normalizeState({ character: '林夏', label: '受伤', fromChapter: 0 }), /正整数/u);
  assert.doesNotThrow(() => assertStates([state('林夏', '受伤'), state('林夏', '失忆')]));
  assert.throws(() => assertStates([state('林夏', '受伤'), state('林夏', '受伤')]), /重复/u);
});

test('人物状态：按章节位置取用，开区间两端都生效', () => {
  const states = [state('林夏', '受伤', { fromChapter: 3, toChapter: 5 }), state('阿岚', '结盟', { fromChapter: 6 }), state('沈舟', '失踪', { toChapter: 2 }), state('林夏', '失忆')];
  assert.deepEqual(statesForChapter(states, 1).map(item => item.label), ['失忆', '失踪']);
  assert.deepEqual(statesForChapter(states, 4).map(item => item.label), ['失忆', '受伤']);
  assert.deepEqual(statesForChapter(states, 9).map(item => item.label), ['结盟', '失忆']);
  assert.deepEqual(statesForChapter(states, 0), [], '非法章节位置不返回任何状态');
});

test('人物状态：范围描述面向作者可读', () => {
  assert.equal(describeRange(state('林夏', 'a')), '全书适用');
  assert.equal(describeRange(state('林夏', 'a', { fromChapter: 3 })), '第3章起');
  assert.equal(describeRange(state('林夏', 'a', { toChapter: 2 })), '第2章前');
  assert.equal(describeRange(state('林夏', 'a', { fromChapter: 3, toChapter: 5 })), '第3–5章');
  assert.equal(describeRange(state('林夏', 'a', { fromChapter: 4, toChapter: 4 })), '仅第4章');
});
