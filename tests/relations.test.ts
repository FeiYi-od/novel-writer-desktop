import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRelations, groupRelations, normalizeRelation, type Relation } from '../src/core/relations';

const rel = (from: string, to: string, label: string, extra: Partial<Relation> = {}): Relation => ({ id: '', from, to, label, note: '', mutual: false, strength: 3, ...extra });

test('人物关系：自连、缺名称、强度越界都被拒绝', () => {
  assert.throws(() => normalizeRelation({ from: '林夏', to: '林夏', label: '师徒' }), /不能与自己/u);
  assert.throws(() => normalizeRelation({ from: '林夏', to: '阿岚', label: ' ' }), /关系名称/u);
  assert.throws(() => normalizeRelation({ from: '林夏', to: '阿岚', label: '师徒', strength: 9 }), /强度/u);
  assert.deepEqual(normalizeRelation({ from: ' 林夏 ', to: '阿岚', label: ' 师徒 ', strength: 5 }),
    { id: '', from: '林夏', to: '阿岚', label: '师徒', note: '', mutual: false, strength: 5 });
});

test('人物关系：同一对角色同名关系不允许重复，方向不同也算重复', () => {
  assert.doesNotThrow(() => assertRelations([rel('林夏', '阿岚', '师徒'), rel('林夏', '阿岚', '宿敌')]));
  assert.throws(() => assertRelations([rel('林夏', '阿岚', '师徒'), rel('阿岚', '林夏', '师徒')]), /重复/u);
  assert.throws(() => assertRelations(Array.from({ length: 301 }, (_, index) => rel(`甲${index}`, '乙', '关系'))), /最多/u);
});

test('人物关系：按角色分组，强度高的在前，双方都能看到', () => {
  const groups = groupRelations([rel('林夏', '阿岚', '师徒', { strength: 5 }), rel('林夏', '沈舟', '旧识', { strength: 2 })]);
  const lin = groups.find(item => item.name === '林夏')!;
  assert.deepEqual(lin.items.map(item => `${item.other}:${item.relation.strength}`), ['阿岚:5', '沈舟:2']);
  assert.ok(groups.some(item => item.name === '阿岚' && item.items[0].other === '林夏'), '关系另一端也要能看到');
});
