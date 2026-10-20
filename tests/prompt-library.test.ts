import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTemplates, normalizeTemplate, templatesFor, withNewVersion, type PromptTemplate } from '../src/core/prompt-library';

const base = (name: string, body = '按当前章节续写。'): PromptTemplate => normalizeTemplate({ name, body, kind: 'write' });

test('提示词模板：名称与内容必填，类型与版本归一', () => {
  assert.throws(() => normalizeTemplate({ name: '', body: 'x' }), /模板名称/u);
  assert.throws(() => normalizeTemplate({ name: '续写', body: '  ' }), /不能为空/u);
  assert.throws(() => normalizeTemplate({ name: '续写', body: 'x'.repeat(20001) }), /过长/u);
  const template = normalizeTemplate({ name: ' 续写 ', body: ' 内容 ', kind: 'bogus' as never, version: 0 });
  assert.equal(template.name, '续写'); assert.equal(template.kind, 'other'); assert.equal(template.version, 1);
});

test('提示词模板：内容没变不加版本，改了才升版并保留旧内容', () => {
  const first = withNewVersion(base('续写'), '新的内容', '2026-10-18T00:00:00Z');
  assert.equal(first.version, 2);
  assert.equal(first.versions.length, 1);
  assert.equal(first.versions[0].version, 1);
  assert.equal(first.versions[0].body, '按当前章节续写。');
  const same = withNewVersion(first, '新的内容', '2026-10-18T01:00:00Z');
  assert.equal(same.version, 2, '内容相同不应升版');
  assert.equal(same.versions.length, 1);
  const third = withNewVersion(same, '更新的内容', '2026-10-18T02:00:00Z');
  assert.equal(third.version, 3);
  assert.deepEqual(third.versions.map(item => item.version), [2, 1]);
});

test('提示词模板：版本历史上限、名称去重与按类型筛选', () => {
  let template = base('续写');
  for (let index = 0; index < 30; index++) template = withNewVersion(template, `内容 ${index}`, `2026-10-18T00:00:0${index % 10}Z`);
  assert.equal(template.versions.length, 20, '版本历史应有上限');
  assert.throws(() => assertTemplates([base('续写'), base(' 续写 ')]), /重复/u);
  assert.deepEqual(templatesFor([base('B 模板'), base('A 模板'), normalizeTemplate({ name: '审稿', body: 'x', kind: 'review' })], 'write').map(item => item.name), ['A 模板', 'B 模板']);
});
