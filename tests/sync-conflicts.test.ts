import test from 'node:test';
import assert from 'node:assert/strict';
import { findSyncConflictCopies } from '../src/core/sync-conflicts';

test('同步冲突副本：识别常见云盘冲突副本命名，原文件不算冲突', () => {
  const found = findSyncConflictCopies([
    '第一章.docx',
    '第一章 (冲突副本 2).docx',
    '第二章.sync-conflict-20261018-120000-ABCDEF.docx',
    '第三章 (1).docx',
    '第四章 - 副本.docx',
    '资料/设定.txt'
  ]);
  assert.deepEqual(found.map(item => item.kind), ['sync-conflict', 'numbered-copy', 'numbered-copy', 'conflict-copy']);
  assert.ok(found.every(item => !item.baseName.startsWith('第一章.docx')));
  assert.deepEqual(found.map(item => item.baseName), [...found.map(item => item.baseName)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
});

test('同步冲突副本：普通章节名、含数字的正文章节都不误报', () => {
  assert.deepEqual(findSyncConflictCopies(['第1章 出发.docx', '2026 年计划.txt', '第一章 第一部（上）.docx']), []);
});

test('同步冲突副本：只报告不改名不删除（纯函数，无副作用）', () => {
  const input = ['第五章 (冲突副本).docx'];
  const snapshot = [...input];
  findSyncConflictCopies(input);
  assert.deepEqual(input, snapshot);
});
