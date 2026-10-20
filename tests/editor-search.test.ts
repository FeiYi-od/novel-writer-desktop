import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import { findChapterMatches, replaceChapterMatches, SEARCH_LIMIT } from '../src/core/editor-search';
import { paragraphSpacesPlugin } from '../src/core/paragraph-spaces';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { content: 'inline*', group: 'block' },
  heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
  text: { group: 'inline' }, hardBreak: { inline: true, group: 'inline' }
}, marks: { bold: {}, italic: {} } });
const text = (value: string) => schema.text(value);
const options = { query: '林夏', matchCase: false };

test('本章查找跨样式准确定位，Unicode/字面量/大小写与换行边界正确', () => {
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 2 }, text('林夏')),
    schema.node('paragraph', null, [text('　　'), schema.text('林', [schema.mark('bold')]), text('夏 ABC abc 😀 [a+b]。')]),
    schema.node('paragraph', null, [text('　　林'), schema.node('hardBreak'), text('夏')])
  ]);
  const found = findChapterMatches(doc, options);
  assert.equal(found.matches.length, 2);
  for (const match of found.matches) assert.equal(doc.textBetween(match.from, match.to), '林夏');
  const find = (query: string, matchCase = false) => findChapterMatches(doc, { query, matchCase }).matches;
  assert.equal(find('ABC').length, 2); assert.equal(find('ABC', true).length, 1);
  assert.equal(find('[a+b]').length, 1); assert.equal(find('😀').length, 1);
  assert.equal(find('　　').length, 0); assert.equal(find('林\n夏').length, 0);
  assert.equal(find('').length, 0);
});

test('全部替换保留标题及未匹配样式，第一字样式继承，单次撤销/重做且空段保留真实空格', () => {
  const original = schema.node('doc', null, [
    schema.node('heading', { level: 3 }, text('林夏登场')),
    schema.node('paragraph', null, [text('　　'), schema.text('林', [schema.mark('bold')]), text('夏遇见'), schema.text('朋友', [schema.mark('italic')]), text('林夏')]),
    schema.node('paragraph', null, text('　　林夏'))
  ]);
  let state = EditorState.create({ schema, doc: original, plugins: [history(), paragraphSpacesPlugin()] });
  const changed = replaceChapterMatches(state, options, '小雨'); assert.equal(changed.count, 4);
  state = state.applyTransaction(changed.transaction).state;
  assert.equal(state.doc.child(0).type.name, 'heading'); assert.equal(state.doc.child(0).attrs.level, 3);
  assert.equal(state.doc.child(0).textContent, '小雨登场');
  assert.equal(state.doc.child(1).child(1).text, '小雨'); assert.equal(state.doc.child(1).child(1).marks[0].type.name, 'bold');
  assert.equal(state.doc.child(1).child(3).marks[0].type.name, 'italic');
  const revised = state.doc;
  assert.equal(undo(state, tr => { state = state.applyTransaction(tr).state; }), true); assert.ok(state.doc.eq(original));
  assert.equal(redo(state, tr => { state = state.applyTransaction(tr).state; }), true); assert.ok(state.doc.eq(revised));
  state = state.applyTransaction(replaceChapterMatches(state, { query: '小雨', matchCase: true }, '').transaction).state;
  assert.equal(state.doc.child(2).textContent, '　　');
});

test('当前匹配失效拒绝替换，替换文本按字面写入且不跨段、不触碰段首', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text('　　ABC abc'))]);
  let state = EditorState.create({ schema, doc, plugins: [paragraphSpacesPlugin()] });
  const first = findChapterMatches(doc, { query: 'ABC', matchCase: false }).matches[0];
  const changed = replaceChapterMatches(state, { query: 'ABC', matchCase: false }, '<b>字</b> 😀', first.from);
  assert.equal(changed.count, 1); state = state.applyTransaction(changed.transaction).state;
  assert.equal(state.doc.textContent, '　　<b>字</b> 😀 abc');
  assert.throws(() => replaceChapterMatches(state, { query: 'ABC', matchCase: false }, 'X', first.from), /已变化/);
  assert.throws(() => replaceChapterMatches(state, { query: 'abc', matchCase: true }, 'A\nB'), /单行/);
  assert.equal(replaceChapterMatches(state, { query: '　　', matchCase: true }, '').count, 0);
});

test('超过匹配上限禁止部分冒充全部替换，上限以内操作不循环处理新替换词', () => {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text('　　' + 'a'.repeat(SEARCH_LIMIT + 1)))]);
  const state = EditorState.create({ schema, doc }); const query = { query: 'a', matchCase: true };
  assert.equal(findChapterMatches(doc, query).matches.length, SEARCH_LIMIT); assert.equal(findChapterMatches(doc, query).truncated, true);
  assert.throws(() => replaceChapterMatches(state, query, 'b'), /超过10000/);
  const small = EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, text('　　aa'))]) });
  const result = replaceChapterMatches(small, query, 'aa'); assert.equal(result.count, 2);
  assert.equal(small.apply(result.transaction).doc.textContent, '　　aaaa');
});
