import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeReportIssues } from '../src/core/report-merge';
import type { ReviewIssue } from '../src/core/review';

const issue = (id: string, quote: string, replacement: string, category = '错别字'): ReviewIssue =>
  ({ id, quote, replacement, category, reason: '理由', evidence: '', start: 0, limitation: '' });

test('合并视图按引文分组，保留每份报告的 issue 身份且不投票取舍', () => {
  const merged = mergeReportIssues([
    { taskId: 'task-a', label: '模型 A', issues: [issue('issue-1', '推开们', '推开门'), issue('issue-2', '雨停了。', '雨停了。')] },
    { taskId: 'task-b', label: '模型 B', issues: [issue('issue-1', '推开们', '推开大门')] }
  ]);
  assert.equal(merged.reportCount, 2); assert.equal(merged.issueCount, 3);
  assert.equal(merged.clusters.length, 2);
  const first = merged.clusters[0];
  assert.equal(first.quote, '推开们');
  assert.deepEqual(first.members.map(member => `${member.taskId}/${member.issueId}`), ['task-a/issue-1', 'task-b/issue-1']);
  assert.equal(first.conflict, true); // same sentence, different replacement
  assert.deepEqual(first.replacements, ['推开门', '推开大门']);
  assert.equal(merged.clusters[1].conflict, false);
  assert.equal(merged.conflictCount, 1);
});

test('同一句子的同类修改不误报冲突，类别不同也算冲突', () => {
  const same = mergeReportIssues([
    { taskId: 'a', label: 'A', issues: [issue('issue-1', '推开们', '推开门')] },
    { taskId: 'b', label: 'B', issues: [issue('issue-3', '推开们', '推开门')] }
  ]);
  assert.equal(same.clusters[0].members.length, 2); assert.equal(same.clusters[0].conflict, false);
  const category = mergeReportIssues([
    { taskId: 'a', label: 'A', issues: [issue('issue-1', '推开们', '推开门', '错别字')] },
    { taskId: 'b', label: 'B', issues: [issue('issue-2', '推开们', '推开门', '角色')] }
  ]);
  assert.equal(category.clusters[0].conflict, true);
  assert.deepEqual(category.clusters[0].categories, ['错别字', '角色']);
});

test('同一报告内的重复引文不算跨报告冲突，空引文忽略，顺序按首次出现', () => {
  const merged = mergeReportIssues([
    { taskId: 'a', label: 'A', issues: [issue('issue-1', '雨停了。', '雨停了！'), issue('issue-2', '雨停了。', '雨停了。')] },
    { taskId: 'b', label: 'B', issues: [issue('issue-1', '他走了', '他离开', '语病')] }
  ]);
  assert.deepEqual(merged.clusters.map(cluster => cluster.key), ['雨停了。', '他走了']);
  assert.equal(merged.clusters[0].conflict, false); // one report repeating itself is not a disagreement
  assert.equal(merged.clusters[0].members.length, 2);
  const empty = mergeReportIssues([{ taskId: 'a', label: 'A', issues: [issue('issue-1', '   ', 'x')] }]);
  assert.equal(empty.clusters.length, 0); assert.equal(empty.issueCount, 1);
  const none = mergeReportIssues([]);
  assert.deepEqual({ clusters: none.clusters, reportCount: none.reportCount, issueCount: none.issueCount, conflictCount: none.conflictCount }, { clusters: [], reportCount: 0, issueCount: 0, conflictCount: 0 });
});

test('引文按空白归一化后分组，保留原始引文文字', () => {
  const merged = mergeReportIssues([
    { taskId: 'a', label: 'A', issues: [issue('issue-1', '推开们。', '推开门。')] },
    { taskId: 'b', label: 'B', issues: [issue('issue-1', '推开们。 \r\n', '推开门。')] }
  ]);
  assert.equal(merged.clusters.length, 1);
  assert.equal(merged.clusters[0].members.length, 2);
  assert.equal(merged.clusters[0].quote, '推开们。'); // the first report's exact text is shown
  assert.equal(merged.clusters[0].conflict, false);
});
