import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSaveBadge, toFailure } from '../src/core/save-status';

test('保存状态：失败后即使之前成功过也要显示失败，并说明草稿位置', () => {
  const now = new Date('2026-10-18T10:00:00Z');
  const success = '2026-10-18T09:50:00Z';
  const failure = toFailure('保存失败：网络目录不可用（可能已断线或同步客户端未就绪），本机稿件仍在恢复区，原文件未改动', new Date('2026-10-18T09:58:00Z'));
  const badge = describeSaveBadge({ lastSuccessAt: success, lastFailure: failure }, now);
  assert.equal(badge.tone, 'danger');
  assert.match(badge.label, /上次保存失败/u);
  assert.match(badge.label, /恢复区/u);
  assert.match(badge.detail, /网络目录不可用/u);
  assert.match(badge.detail, /2 分钟前/u);
  assert.equal(toFailure('普通错误').draftKept, false);
});

test('保存状态：重新保存成功后回到正常，未保存过时提示尚未保存', () => {
  const now = new Date('2026-10-18T10:05:00Z');
  const badge = describeSaveBadge({ lastSuccessAt: '2026-10-18T10:04:00Z', lastFailure: toFailure('旧的失败', new Date('2026-10-18T09:00:00Z')) }, now);
  assert.equal(badge.tone, 'ok');
  assert.equal(badge.label, '已保存到所选文件夹');
  const initial = describeSaveBadge({}, now);
  assert.equal(initial.tone, 'warn');
  assert.match(initial.label, /尚未保存/u);
});

test('保存状态：失败文案被截断，避免把整段堆栈塞进状态栏', () => {
  const failure = toFailure('错'.repeat(1000));
  assert.ok(failure.message.length <= 300);
});

test('保存状态：保存过后继续打字不能仍然显示全部已保存，失败仍优先', () => {
  const state = { lastSuccessAt: '2026-10-18T10:04:00Z', unsaved: true };
  assert.equal(describeSaveBadge(state).tone, 'warn');
  assert.match(describeSaveBadge(state).label, /未保存修改/u);
  assert.equal(describeSaveBadge({ ...state, lastFailure: toFailure('失败', new Date('2026-10-18T10:05:00Z')) }).tone, 'danger');
});

test('保存状态：恢复区不可用不能误称已留草稿；明确暂存结果可覆盖文案推断', () => {
  assert.equal(toFailure('恢复区不可用，写入失败').draftKept, false);
  assert.equal(toFailure('当前草稿已保存在本机恢复区').draftKept, true);
  assert.equal(toFailure('文件路径不可用', new Date(), true).draftKept, true);
  assert.equal(toFailure('草稿已保存在本机恢复区', new Date(), false).draftKept, false);
});
