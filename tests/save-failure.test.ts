import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSaveFailure } from '../src/core/save-failure';

const err = (code: string) => Object.assign(new Error(code), { code });

test('保存失败说明：网络目录、占用、只读、空间不足分别给出可行动文案', () => {
  const offline = describeSaveFailure(err('ENOENT'));
  assert.equal(offline.network, true);
  assert.match(offline.message, /网络目录不可用/u);
  assert.match(offline.message, /恢复区/u);
  assert.doesNotMatch(offline.message, /已保存/u);

  assert.match(describeSaveFailure(err('EBUSY')).message, /被占用|没有写权限/u);
  assert.match(describeSaveFailure(err('EROFS')).message, /只读/u);
  assert.match(describeSaveFailure(err('ENOSPC')).message, /空间不足/u);
  assert.equal(describeSaveFailure(err('ENOSPC')).network, false);
  const unknown = describeSaveFailure(new Error('boom'));
  assert.equal(unknown.code, 'UNKNOWN');
  assert.match(unknown.message, /恢复区/u);
});

test('保存失败说明：任何分支都不声称已保存', () => {
  for (const code of ['ENOENT', 'ETIMEDOUT', 'EACCES', 'EROFS', 'ENOSPC', 'UNKNOWN']) {
    const { message } = describeSaveFailure(err(code));
    assert.doesNotMatch(message, /已保存到|已同步/u, `${code} 的文案不应让人以为保存成功`);
  }
});
