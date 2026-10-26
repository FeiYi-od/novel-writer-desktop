import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { analyzeRegexImport } from '../src/main/regex-import';
import { REGEX_PREVIEW_LIMITS as LIMITS } from '../src/main/regex-preview';

const projectId = randomUUID();
const single = () => ({ id: randomUUID(), scriptName: '虚构社区单条导出', findRegex: '/cat/gi', replaceString: '猫', disabled: false, trimStrings: ['~'] });

test('社区正则导入：上游单条对象与批量数组得到同样受支持数据', () => {
  const exported = { ...single(), placement: [2], markdownOnly: true, promptOnly: false, runOnEdit: true, minDepth: 1, maxDepth: 10, substituteRegex: 0 };
  const before = JSON.stringify(exported), one = analyzeRegexImport(exported, projectId), bulk = analyzeRegexImport([exported], projectId);
  assert.equal(one.format, 'single'); assert.equal(bulk.format, 'array');
  assert.deepEqual(one.scripts, bulk.scripts);
  assert.deepEqual(one.scripts, [{ findRegex: '/cat/gi', replaceString: '猫', disabled: false, flags: undefined, trimStrings: ['~'] }]);
  for (const field of ['id', 'scriptName', 'placement', 'markdownOnly', 'promptOnly', 'runOnEdit', 'minDepth', 'maxDepth', 'substituteRegex']) assert.ok(one.unsupportedFields.includes(field));
  assert.equal(one.unsupportedFieldCount, 9);
  assert.equal(JSON.stringify(exported), before, '分析不能删除或改写原对象中的扩展字段');
});

test('社区正则导入：旧数组和本应用scripts包装、项目及版本检查继续可用', () => {
  const exported = single(), wrapped = { schemaVersion: 1, projectId, scripts: [exported], annotation: { original: '保留' } };
  const result = analyzeRegexImport(wrapped, projectId);
  assert.equal(result.format, 'scripts'); assert.deepEqual(result.scripts, analyzeRegexImport([exported], projectId).scripts);
  assert.deepEqual(result.unsupportedFields, ['annotation', 'id', 'scriptName']);
  assert.equal(result.unsupportedFieldCount, 3);
  assert.ok(!result.unsupportedFields.includes('schemaVersion')); assert.ok(!result.unsupportedFields.includes('projectId'));
  assert.deepEqual(analyzeRegexImport([], projectId).scripts, []);
  assert.deepEqual(analyzeRegexImport({ scripts: [] }, projectId).scripts, []);
  assert.throws(() => analyzeRegexImport({ ...wrapped, schemaVersion: 99 }, projectId), /版本/);
  assert.throws(() => analyzeRegexImport({ ...wrapped, projectId: randomUUID() }, projectId), /另一部小说/);
  assert.throws(() => analyzeRegexImport({ ...exported, projectId: randomUUID() }, projectId), /另一部小说/);
  assert.throws(() => analyzeRegexImport({ ...exported, schemaVersion: 2 }, projectId), /版本/);
  assert.equal(analyzeRegexImport(exported, projectId).scripts.length, 1, '单条脚本id不能被误判为小说id');
});

test('社区正则导入：snake_case别名与已有flags、trim、禁用归一化行为不变', () => {
  const result = analyzeRegexImport([
    { find_regex: 'cat', replace_string: '猫', flags: '', trimStrings: ['~', 5, null], disabled: true },
    { findRegex: '/cat/gg', find_regex: '错误备用', replaceString: '甲', replace_string: '错误备用', flags: 'x', disabled: 'true' }
  ], projectId);
  assert.deepEqual(result.scripts, [
    { findRegex: 'cat', replaceString: '猫', flags: '', trimStrings: ['~'], disabled: true },
    { findRegex: '/cat/gg', replaceString: '甲', flags: 'x', trimStrings: [], disabled: false }
  ]);
  assert.equal(result.unsupportedFieldCount, 0);
  assert.deepEqual(analyzeRegexImport({ find_regex: ' cat ' }, projectId).scripts[0], { findRegex: ' cat ', replaceString: '', disabled: false, flags: undefined, trimStrings: [] });
});

test('社区正则导入：无效形状和预设引用不能被误当成功空脚本', () => {
  for (const value of [null, 5, true, '', { foo: 1 }, { global: [{ id: randomUUID() }], name: '预设引用' }, { scripts: null }, { scripts: 'bad', findRegex: 'x' }])
    assert.throws(() => analyzeRegexImport(value, projectId), /正则脚本应为数组/);
  for (const value of [[null], [7], [{}], [{ replaceString: 'x' }], [{ findRegex: '  ' }]]) assert.throws(() => analyzeRegexImport(value, projectId), /第 1 条/);
  for (const id of ['', 'not-a-project', '0'.repeat(36)]) assert.throws(() => analyzeRegexImport(single(), id), /小说标识/);
});

test('社区正则导入：输入/输出独立，不共享调用者的数组或trim对象', () => {
  const exported = single(), input = { scripts: [exported] }, result = analyzeRegexImport(input, projectId);
  exported.findRegex = '/changed/'; exported.trimStrings.push('后写'); input.scripts.push(single());
  assert.equal(result.scripts.length, 1); assert.equal(result.scripts[0].findRegex, '/cat/gi'); assert.deepEqual(result.scripts[0].trimStrings, ['~']);
  result.scripts[0].trimStrings!.push('输出修改'); assert.deepEqual(exported.trimStrings, ['~', '后写']);
});

test('社区正则导入：字段报告按实际唯一名称计数、保留元数据、限64项和128字符', () => {
  const exported: Record<string, unknown> = { findRegex: 'cat' };
  for (let index = 0; index < 70; index++) exported[`字段${index}`] = { notExecuted: true };
  const first = analyzeRegexImport([exported, { ...exported }], projectId);
  assert.equal(first.unsupportedFieldCount, 70); assert.equal(first.unsupportedFields.length, 64);
  assert.ok(first.unsupportedFields.every(name => name.length <= 128));
  const long = '保留字段'.repeat(100), value = analyzeRegexImport({ findRegex: 'cat', [long]: 1 }, projectId);
  assert.equal(value.unsupportedFieldCount, 1); assert.equal(value.unsupportedFields[0].length, 128); assert.ok(value.unsupportedFields[0].endsWith('…'));
});

test('社区正则导入：__proto__、constructor只作为原始字段报告，不污染输出原型', () => {
  const exported = JSON.parse('{"findRegex":"cat","__proto__":{"polluted":"fixture"},"constructor":"元数据"}');
  const result = analyzeRegexImport(exported, projectId);
  assert.deepEqual(result.unsupportedFields, ['__proto__', 'constructor']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined); assert.equal((result.scripts[0] as unknown as Record<string, unknown>).polluted, undefined);
});

test('社区正则导入：先拒绝getter/toJSON与代理，不能执行调用者代码', () => {
  let calls = 0;
  const accessor = { findRegex: 'cat', get unknown() { calls++; return '不可执行'; } };
  assert.throws(() => analyzeRegexImport(accessor, projectId), /动态/); assert.equal(calls, 0);
  const source = { findRegex: 'cat', toJSON() { calls++; return {}; } };
  assert.throws(() => analyzeRegexImport(source, projectId), /普通JSON/); assert.equal(calls, 0);
  const proxy = new Proxy({ findRegex: 'cat' }, { ownKeys() { calls++; throw new Error('不能执行'); }, getPrototypeOf() { calls++; throw new Error('不能执行'); } });
  assert.throws(() => analyzeRegexImport(proxy, projectId), /代理/); assert.equal(calls, 0);
  const array = [{ findRegex: 'cat' }]; Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return single(); } });
  assert.throws(() => analyzeRegexImport(array, projectId), /动态/); assert.equal(calls, 0);
});

test('社区正则导入：非JSON、循环、过深结构及额外/稀疏数组拒绝', () => {
  const circular: Record<string, unknown> = { findRegex: 'cat' }; circular.self = circular;
  assert.throws(() => analyzeRegexImport(circular, projectId), /循环/);
  for (const extension of [undefined, Symbol('fixture'), 1n, Infinity, NaN, new Date(), /fixture/])
    assert.throws(() => analyzeRegexImport({ findRegex: 'cat', extension }, projectId), /普通JSON/);
  const hidden = { findRegex: 'cat' }; Object.defineProperty(hidden, 'extension', { value: 1, enumerable: false });
  assert.throws(() => analyzeRegexImport(hidden, projectId), /隐藏/);
  const symbolic = { findRegex: 'cat', [Symbol('extension')]: 1 };
  assert.throws(() => analyzeRegexImport(symbolic, projectId), /Symbol/);
  const sparse: unknown[] = []; sparse.length = 1;
  assert.throws(() => analyzeRegexImport(sparse, projectId), /空洞|稀疏/);
  const extra = Object.assign([single()], { extra: 1 }); assert.throws(() => analyzeRegexImport(extra, projectId), /额外/);
  let nested: unknown = '末尾'; for (let index = 0; index < 81; index++) nested = { nested };
  assert.throws(() => analyzeRegexImport({ findRegex: 'cat', nested }, projectId), /80层/);
  const shared = { immutable: '共享可重复的JSON值' };
  assert.equal(analyzeRegexImport({ findRegex: 'cat', left: shared, right: shared }, projectId).scripts.length, 1, '共享但不成环的数据可安全复制');
});

test('社区正则导入：脚本与字段恰好上限可用，超限在归一化前后明确拒绝', () => {
  assert.equal(analyzeRegexImport(Array.from({ length: LIMITS.scripts }, () => ({ findRegex: 'x' })), projectId).scripts.length, LIMITS.scripts);
  assert.throws(() => analyzeRegexImport(Array.from({ length: LIMITS.scripts + 1 }, () => ({ findRegex: 'x' })), projectId), /256条/);
  const boundary = { findRegex: 'x'.repeat(LIMITS.patternCharacters), replaceString: 'y'.repeat(LIMITS.replacementCharacters), flags: 'i'.repeat(64), trimStrings: ['z'.repeat(LIMITS.trimCharacters)] };
  assert.equal(analyzeRegexImport(boundary, projectId).scripts[0].replaceString.length, LIMITS.replacementCharacters);
  for (const value of [
    { findRegex: 'x'.repeat(LIMITS.patternCharacters + 1) },
    { findRegex: 'x', replaceString: 'y'.repeat(LIMITS.replacementCharacters + 1) },
    { findRegex: 'x', trimStrings: Array.from({ length: LIMITS.trimEntries + 1 }, () => 'x') },
    { findRegex: 'x', trimStrings: ['x'.repeat(LIMITS.trimCharacters + 1)] }
  ]) assert.throws(() => analyzeRegexImport(value, projectId), /安全长度/);
  assert.throws(() => analyzeRegexImport({ findRegex: 'x', flags: 'i'.repeat(65) }, projectId), /flags过长/);
});

test('社区正则导入：实际序列化UTF8字节预算准确包含转义、中文、emoji与孤立代理项', async t => {
  for (const unit of ['a', '\n', '"', '\u0000', '汉', '😀', '\ud800', '\udc00']) await t.test(JSON.stringify(unit), () => {
    const base = { findRegex: 'x', extension: '' }, overhead = Buffer.byteLength(JSON.stringify(base));
    const cost = Buffer.byteLength(JSON.stringify(unit)) - 2, remaining = LIMITS.payloadBytes - overhead;
    const extension = unit.repeat(Math.floor(remaining / cost)) + 'a'.repeat(remaining % cost);
    const exact = { ...base, extension };
    assert.equal(Buffer.byteLength(JSON.stringify(exact)), LIMITS.payloadBytes);
    assert.equal(analyzeRegexImport(exact, projectId).scripts[0].findRegex, 'x');
    assert.throws(() => analyzeRegexImport({ ...exact, extension: extension + 'a' }, projectId), /1 MiB/);
  });
});

test('社区正则导入：新增默认字段导致规范数据超限也拒绝，不默默放宽042限制', () => {
  const scripts = Array.from({ length: 32 }, () => ({ findRegex: 'x', replaceString: 'a'.repeat(32768) }));
  const excess = Buffer.byteLength(JSON.stringify(scripts)) - LIMITS.payloadBytes;
  assert.ok(excess > 0 && excess < 32768);
  scripts[0].replaceString = scripts[0].replaceString.slice(excess);
  assert.equal(Buffer.byteLength(JSON.stringify(scripts)), LIMITS.payloadBytes);
  assert.throws(() => analyzeRegexImport(scripts, projectId), /总数据超过1 MiB/);
});
