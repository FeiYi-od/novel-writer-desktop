import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { bodyParagraphTexts, bodyStructureParagraphs, editDocxBody } from '../src/main/docx-fidelity';
import { DocxCopyService } from '../src/main/docx-copy-service';
import { Workspace } from '../src/main/workspace';
import type { DocxBodyAction } from '../src/shared/docx-body';
import { bodyActions as draftActions, bodyDraft, insertBodyParagraph } from '../src/core/docx-body-draft';

const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const doc = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
async function source(body: string) {
  const zip = new JSZip();
  zip.file('word/document.xml', doc(body));
  zip.file('word/header1.xml', '<w:hdr>虚构页眉原字节</w:hdr>');
  zip.file('word/_rels/document.xml.rels', '<Relationships/>');
  zip.file('word/media/image.png', Uint8Array.of(1, 2, 3, 4));
  return zip.generateAsync({ type: 'uint8array' });
}
async function xml(bytes: Uint8Array) { return (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string'); }
async function text(bytes: Uint8Array) { return bodyParagraphTexts(await xml(bytes)); }

test('界面草稿的新增段和被删除锚点依原始位置稳定保存，不受其他段删除影响', async () => {
  const original = await source(p('甲') + '<w:tbl><w:tr><w:tc>' + p('表') + '</w:tc></w:tr></w:tbl>' + p('乙') + p('丙'));
  const snapshot = { schemaVersion: 1 as const, projectId: randomUUID(), path: '虚构.docx', hash: 'a'.repeat(64), paragraphs: bodyStructureParagraphs(await xml(original)) };
  let draft = bodyDraft(snapshot);
  draft = insertBodyParagraph(draft, 0, 'after', 'new-1'); draft[1].text = '　　甲后';
  draft = insertBodyParagraph(draft, 2, 'before', 'new-2'); draft[2].text = '　　乙前';
  draft = draft.filter(item => item.text !== '甲');
  draft = insertBodyParagraph(draft, 0, 'after', 'new-3'); draft[1].text = '　　新增段后再新增';
  draft = draft.filter(item => item.text !== '乙');
  const result = await editDocxBody(original, draftActions(snapshot, draft));
  assert.deepEqual(await text(result.bytes), draft.map(item => item.text));
  const output = await xml(result.bytes);
  assert.ok(output.indexOf('甲后') < output.indexOf('<w:tbl>') && output.indexOf('乙前') > output.indexOf('</w:tbl>'), '原表格仍位于两个原始锚点之间');
});

test('正文计划按原段索引插入/删除/更新：表格和未改段原字节保持，无中间错位', async () => {
  const table = `<w:tbl><w:tr><w:tc>${p('表格原字节')}</w:tc></w:tr></w:tbl>`;
  const comment = '<!--段间注释 <w:p>伪段</w:p> -->';
  const tail = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const original = await source(p('　　甲') + table + p('　　乙') + comment + p('　　丙') + p('　　丁') + tail);
  const actions: DocxBodyAction[] = [
    { kind: 'update', index: 2, text: '　　改丙<&>😀' },
    { kind: 'insert', index: 1, position: 'after', paragraphs: ['　　乙后新增一', '　　乙后新增二'] },
    { kind: 'remove', index: 1 },
    { kind: 'insert', index: 1, position: 'before', paragraphs: ['　　乙前新增'] },
    { kind: 'insert', index: 1, position: 'after', paragraphs: ['　　乙后新增三'] }
  ];
  const result = await editDocxBody(original, actions), output = await xml(result.bytes);
  assert.deepEqual(await text(result.bytes), ['　　甲', '　　乙前新增', '　　乙后新增一', '　　乙后新增二', '　　乙后新增三', '　　改丙<&>😀', '　　丁']);
  assert.equal(result.paragraphs, 7); assert.equal(result.changed, 6);
  for (const token of [table, comment, tail, p('　　甲'), p('　　丁')]) assert.ok(output.includes(token));
  assert.ok(output.indexOf(table) < output.indexOf('乙前新增'));
  assert.ok(output.indexOf(comment) > output.indexOf('乙后新增三'));
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(result.bytes);
  for (const part of Object.keys(before.files).filter(name => name !== 'word/document.xml' && !before.files[name].dir))
    assert.deepEqual(await after.file(part)!.async('uint8array'), await before.file(part)!.async('uint8array'));
  assert.equal(await xml(original), doc(p('　　甲') + table + p('　　乙') + comment + p('　　丙') + p('　　丁') + tail));
});

test('新段使用宋体五号、真实空格，不克隆节、编号、书签或重复 ID', async () => {
  const originalParagraph = '<w:p w14:paraId="12345678"><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr><w:sectPr/></w:pPr><w:bookmarkStart w:id="2"/><w:r><w:rPr><w:rStyle w:val="ComplexStyle"/></w:rPr><w:t>带结构原段</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>';
  const original = await source(originalParagraph);
  const descriptor = bodyStructureParagraphs(await xml(original))[0];
  assert.equal(descriptor.insertable, true); assert.equal(descriptor.removable, false); assert.equal(descriptor.editable, false);
  const result = await editDocxBody(original, [{ kind: 'insert', index: 0, position: 'before', paragraphs: ['　　新段'] }]);
  const output = await xml(result.bytes);
  assert.deepEqual(await text(result.bytes), ['　　新段', '带结构原段']);
  assert.ok(output.includes(originalParagraph));
  assert.equal((output.match(/w14:paraId/g) ?? []).length, 1);
  assert.equal((output.match(/w:sectPr/g) ?? []).length, 1);
  assert.equal((output.match(/w:bookmarkStart/g) ?? []).length, 1);
  assert.equal((output.match(/w:numId/g) ?? []).length, 1);
  assert.match(output, /<w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体"\/>/u);
  assert.match(output, /<w:sz w:val="21"\/>/u);
  assert.match(output, /<w:t xml:space="preserve">　　新段<\/w:t>/u);
  assert.doesNotMatch(output.slice(output.indexOf('<w:body>'), output.indexOf(originalParagraph)), /w:ind|w:numPr|w:sectPr|ComplexStyle/u);
});

test('正文计划同源重复更新/删除冲突、无效锚点、未知字段均拒绝', async () => {
  const original = await source(p('甲') + p('乙'));
  const invalid: unknown[] = [
    [{ kind: 'update', index: 0, text: '新' }, { kind: 'remove', index: 0 }],
    [{ kind: 'remove', index: 1 }, { kind: 'remove', index: 1 }],
    [{ kind: 'update', index: 0, text: '新' }, { kind: 'update', index: 0, text: '后' }],
    [{ kind: 'remove', index: 2 }], [{ kind: 'insert', index: 0.5, position: 'before', paragraphs: ['新'] }],
    [{ kind: 'insert', index: 0, position: 'middle', paragraphs: ['新'] }],
    [{ kind: 'insert', index: 0, position: 'before', paragraphs: [] }],
    [{ kind: 'remove', index: 0, path: '../other' }], []
  ];
  for (const actions of invalid) await assert.rejects(editDocxBody(original, actions as DocxBodyAction[]));
  assert.deepEqual(await text(original), ['甲', '乙']);
});

test('结构变更计数按插入与删除合计，不允许净差掩盖超限', async () => {
  const original = await source(Array.from({ length: 200 }, (_, index) => p(String(index))).join(''));
  const actions: DocxBodyAction[] = Array.from({ length: 100 }, (_, index) => ({ kind: 'remove', index }));
  actions.push({ kind: 'insert', index: 199, position: 'after', paragraphs: Array.from({ length: 101 }, () => '　　新') });
  await assert.rejects(editDocxBody(original, actions), /合计不能超过200段/u);
  (actions[100] as Extract<DocxBodyAction, { kind: 'insert' }>).paragraphs.pop();
  assert.equal((await editDocxBody(original, actions)).paragraphs, 200);
});

test('正文计划不能删空，支持原空段与前后插入，零文字更改保留整个压缩包', async () => {
  const original = await source('<w:p/>' + p('　　保留'));
  await assert.rejects(editDocxBody(original, [{ kind: 'remove', index: 0 }, { kind: 'remove', index: 1 }]), /保留1至10000段/u);
  const unchanged = await editDocxBody(original, [{ kind: 'update', index: 1, text: '　　保留' }]);
  assert.deepEqual(unchanged.bytes, original); assert.equal(unchanged.changed, 0);
  const changed = await editDocxBody(original, [{ kind: 'update', index: 0, text: '　　填空段' }, { kind: 'insert', index: 1, position: 'after', paragraphs: [''] }]);
  assert.deepEqual(await text(changed.bytes), ['　　填空段', '　　保留', '']);
});

test('图片、超链接、书签、脚注、节、修订、公式、制表等复杂段拒绝删除/改字但可在旁插入', async () => {
  for (const content of [
    '<w:r><w:drawing/></w:r>', '<w:hyperlink r:id="rId1"><w:r><w:t>链接</w:t></w:r></w:hyperlink>',
    '<w:bookmarkStart w:id="1"/><w:bookmarkEnd w:id="1"/>', '<w:r><w:footnoteReference w:id="1"/></w:r>',
    '<w:pPr><w:sectPr/></w:pPr>', '<w:ins w:id="1"><w:r><w:t>修订</w:t></w:r></w:ins>', '<w:fldSimple w:instr="PAGE"/>',
    '<w:commentRangeStart w:id="1"/><w:commentRangeEnd w:id="1"/>', '<m:oMath/>', '<w:r><w:tab/></w:r>'
  ]) {
    const block = `<w:p>${content}<w:r><w:t>原文</w:t></w:r></w:p>`, original = await source(p('前') + block);
    const descriptor = bodyStructureParagraphs(await xml(original))[1];
    assert.equal(descriptor.removable, false, content); assert.equal(descriptor.editable, false, content); assert.equal(descriptor.insertable, true, content);
    await assert.rejects(editDocxBody(original, [{ kind: 'remove', index: 1 }]), /复杂结构/u);
    await assert.rejects(editDocxBody(original, [{ kind: 'update', index: 1, text: '改文' }]), /复杂结构/u);
    const result = await editDocxBody(original, [{ kind: 'insert', index: 1, position: 'after', paragraphs: ['　　追加'] }]);
    assert.ok((await xml(result.bytes)).includes(block));
  }
});

test('跨段域和修订范围使全文只读；中间看似纯文字段不得被编辑或删除', async () => {
  for (const marker of ['<w:r><w:fldChar w:fldCharType="begin"/></w:r>', '<w:moveFromRangeStart w:id="1"/>', '<w:moveToRangeEnd w:id="1"/>', '<w:customXmlInsRangeStart w:id="1"/>']) {
    const original = await source(`<w:p>${marker}</w:p>` + p('域中间原文') + p('末尾'));
    assert.ok(bodyStructureParagraphs(await xml(original)).every(item => !item.editable && !item.insertable && !item.removable));
    for (const action of [{ kind: 'remove', index: 1 }, { kind: 'insert', index: 1, position: 'after', paragraphs: ['新'] }, { kind: 'update', index: 1, text: '改' }] as DocxBodyAction[])
      await assert.rejects(editDocxBody(original, [action]), /跨段域或修订范围/u);
    assert.deepEqual((await editDocxBody(original, [{ kind: 'update', index: 1, text: '域中间原文' }])).bytes, original);
  }
});

test('跨段书签、批注及权限范围也要阻止改动中间文字；单段内的书签不影响其他段', async () => {
  for (const [start, end] of [
    ['<w:bookmarkStart w:id="5" w:name="跨段"/>', '<w:bookmarkEnd w:id="5"/>'],
    ['<w:commentRangeStart w:id="5"/>', '<w:commentRangeEnd w:id="5"/>'],
    ['<w:permStart w:id="5" w:edGrp="everyone"/>', '<w:permEnd w:id="5"/>']
  ]) {
    const original = await source(`<w:p>${start}<w:r><w:t>起点</w:t></w:r></w:p>${p('中间')}` + `<w:p><w:r><w:t>终点</w:t></w:r>${end}</w:p>`);
    const descriptors = bodyStructureParagraphs(await xml(original));
    assert.ok(descriptors.every(item => !item.editable && !item.insertable && !item.removable));
    await assert.rejects(editDocxBody(original, [{ kind: 'update', index: 1, text: '不允许改' }]), /范围|只读/u);
    await assert.rejects(editDocxBody(original, [{ kind: 'remove', index: 1 }]), /范围|只读/u);
  }
  const single = await source(`<w:p><w:bookmarkStart w:id="3" w:name="同段"/><w:r><w:t>范围</w:t></w:r><w:bookmarkEnd w:id="3"/></w:p>${p('普通段')}`);
  const descriptors = bodyStructureParagraphs(await xml(single));
  assert.equal(descriptors[0].removable, false);
  assert.equal(descriptors[1].editable, true);
  assert.equal(descriptors[1].insertable, true);
  for (const malformed of ['<w:bookmarkStart w:id="3"/>', '<w:commentRangeEnd w:id="3"/>', '<w:permStart/>']) {
    const broken = await source(`<w:p>${malformed}<w:r><w:t>异常范围</w:t></w:r></w:p>${p('普通段')}`);
    assert.ok(bodyStructureParagraphs(await xml(broken)).every(item => !item.editable && !item.insertable && !item.removable));
  }
});

test('内容控件中的段落只读，直接正文段可编辑，表格段仍不计入索引', async () => {
  const wrapper = `<w:sdt><w:sdtContent>${p('控件原字节')}</w:sdtContent></w:sdt>`;
  const table = `<w:tbl><w:tr><w:tc>${p('表格原字节')}</w:tc></w:tr></w:tbl>`;
  const original = await source(wrapper + table + p('正文'));
  const descriptors = bodyStructureParagraphs(await xml(original));
  assert.equal(descriptors.length, 2);
  assert.equal(descriptors[0].editable, false); assert.equal(descriptors[0].insertable, false); assert.equal(descriptors[0].removable, false);
  for (const action of [{ kind: 'remove', index: 0 }, { kind: 'insert', index: 0, position: 'before', paragraphs: ['新'] }, { kind: 'update', index: 0, text: '改' }] as DocxBodyAction[])
    await assert.rejects(editDocxBody(original, [action]), /容器/u);
  const edited = await editDocxBody(original, [{ kind: 'update', index: 1, text: '新正文' }]);
  const output = await xml(edited.bytes); assert.ok(output.includes(wrapper)); assert.ok(output.includes(table));
  assert.deepEqual(await text(edited.bytes), ['控件原字节', '新正文']);
});

test('源段与动作预算：无效XML字符、非法UTF8、超长单段、总输出与10000段上限拒绝', async () => {
  const original = await source(p('旧文'));
  for (const bad of ['\u0000', '\ud800', '\uffff', 'x'.repeat(100001)]) {
    await assert.rejects(editDocxBody(original, [{ kind: 'update', index: 0, text: bad }]));
    await assert.rejects(editDocxBody(original, [{ kind: 'insert', index: 0, position: 'after', paragraphs: [bad] }]));
  }
  const zip = new JSZip(); zip.file('word/document.xml', Uint8Array.of(0xc0, 0xc0));
  await assert.rejects(editDocxBody(await zip.generateAsync({ type: 'uint8array' }), [{ kind: 'update', index: 0, text: 'x' }]), /UTF-8/u);
  const crowded = await source(Array.from({ length: 10000 }, () => '<w:p/>').join(''));
  await assert.rejects(editDocxBody(crowded, [{ kind: 'insert', index: 0, position: 'before', paragraphs: ['新'] }]), /1至10000段/u);
  assert.throws(() => bodyStructureParagraphs(doc(p('x'.repeat(100001)))), /100000/u);
  const large = await source(Array.from({ length: 80 }, () => p('x'.repeat(100000))).join(''));
  await assert.rejects(editDocxBody(large, [{ kind: 'insert', index: 0, position: 'before', paragraphs: Array.from({ length: 4 }, () => 'x'.repeat(100000)) }]), /编辑后正文文字超过8 MiB/u);
});

test('XML注释和PI中的伪结构标记不影响正文能力，段间标签不会被误改', async () => {
  const note = '<!-- <w:p><w:fldChar/><w:bookmarkStart/></w:p> --><?ignore <w:moveFromRangeStart/> ?>';
  const original = await source(note + p('一') + note + p('二'));
  assert.ok(bodyStructureParagraphs(await xml(original)).every(item => item.editable && item.insertable && item.removable));
  const edited = await editDocxBody(original, [{ kind: 'remove', index: 0 }, { kind: 'insert', index: 1, position: 'before', paragraphs: ['　　新'] }]);
  assert.equal((await xml(edited.bytes)).split(note).length - 1, 2);
  assert.deepEqual(await text(edited.bytes), ['　　新', '二']);
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-docx-body-'));
  const workspace = new Workspace(path.join(root, 'local'), path.join(root, 'materials')); await workspace.initialize();
  const book = path.join(root, 'book'); await fs.mkdir(book); const project = await workspace.attach(book);
  const original = await source(p('　　甲') + p('　　乙') + p('　　丙'));
  await fs.writeFile(path.join(book, '原稿.docx'), original);
  const frozen = await workspace.readOriginalChapter(project.id, '原稿.docx'), service = new DocxCopyService(workspace);
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, book, project, original, frozen, service };
}

test('服务读取稳定索引与权限，批量另存只生成一份副本，原稿保持', async t => {
  const f = await fixture(t), snapshot = await f.service.bodyStructure(f.project.id, '原稿.docx', f.frozen.hash);
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.projectId, f.project.id); assert.equal(snapshot.path, '原稿.docx'); assert.equal(snapshot.hash, f.frozen.hash);
  assert.deepEqual(snapshot.paragraphs.map(item => [item.index, item.text, item.editable, item.insertable, item.removable]), [[0, '　　甲', true, true, true], [1, '　　乙', true, true, true], [2, '　　丙', true, true, true]]);
  const result = await f.service.editBody(f.project.id, '原稿.docx', [{ kind: 'remove', index: 1 }, { kind: 'insert', index: 2, position: 'before', paragraphs: ['　　新增'] }, { kind: 'update', index: 2, text: '　　改丙' }], f.frozen.hash);
  assert.equal(result.projectId, f.project.id); assert.equal(result.sourcePath, '原稿.docx'); assert.equal(result.sourceHash, f.frozen.hash);
  assert.equal(result.paragraphs, 3); assert.equal(result.changed, 3); assert.notEqual(result.path, '原稿.docx');
  assert.deepEqual(await text(await fs.readFile(path.join(f.book, result.path))), ['　　甲', '　　新增', '　　改丙']);
  assert.equal((await fs.readdir(f.book)).filter(name => name.endsWith('.docx')).length, 2);
  assert.deepEqual(await fs.readFile(path.join(f.book, '原稿.docx')), Buffer.from(f.original));
});

test('服务拒绝错书、路径越界、缺少来源哈希、未知动作及无改动，不生成副本', async t => {
  const f = await fixture(t), actions: DocxBodyAction[] = [{ kind: 'remove', index: 1 }];
  const second = path.join(f.root, 'other'); await fs.mkdir(second); const other = await f.workspace.attach(second);
  for (const request of [
    () => f.service.bodyStructure(randomUUID(), '原稿.docx', f.frozen.hash),
    () => f.service.bodyStructure(f.project.id, '../原稿.docx', f.frozen.hash),
    () => f.service.editBody(other.id, '原稿.docx', actions, f.frozen.hash),
    () => f.service.editBody(f.project.id, '../原稿.docx', actions, f.frozen.hash),
    () => f.service.editBody(f.project.id, '原稿.docx', actions, undefined as never),
    () => f.service.editBody(f.project.id, '原稿.docx', [{ kind: 'update', index: 0, text: '新', path: '/secret' }], f.frozen.hash),
    () => f.service.editBody(f.project.id, '原稿.docx', [{ kind: 'update', index: 0, text: '　　甲' }], f.frozen.hash)
  ]) await assert.rejects(request);
  assert.equal((await fs.readdir(f.book)).filter(name => name.endsWith('.docx')).length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.book, '原稿.docx')), Buffer.from(f.original));
});

test('读取结束复核来源和发布前外部变化拒绝，外部版本保留', async t => {
  const f = await fixture(t), read = f.workspace.readOriginalChapter.bind(f.workspace), external = await source(p('外部改动'));
  let reads = 0;
  f.workspace.readOriginalChapter = async (...args) => {
    if (++reads === 2) await fs.writeFile(path.join(f.book, '原稿.docx'), external);
    return read(...args);
  };
  await assert.rejects(f.service.bodyStructure(f.project.id, '原稿.docx', f.frozen.hash), /版本|变化/u);
  f.workspace.readOriginalChapter = read; await fs.writeFile(path.join(f.book, '原稿.docx'), f.original);
  const publish = f.workspace.publishOriginalCopy.bind(f.workspace);
  f.workspace.publishOriginalCopy = async (...args) => { await fs.writeFile(path.join(f.book, '原稿.docx'), external); return publish(...args); };
  await assert.rejects(f.service.editBody(f.project.id, '原稿.docx', [{ kind: 'remove', index: 1 }], f.frozen.hash), /版本|变化/u);
  assert.equal((await fs.readdir(f.book)).filter(name => name.endsWith('.docx')).length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.book, '原稿.docx')), Buffer.from(external));
});

test('服务在读取之前冻结动作，异步期间调用方变更不改写计划', async t => {
  const f = await fixture(t), read = f.workspace.readOriginalChapter.bind(f.workspace);
  const actions: DocxBodyAction[] = [{ kind: 'update', index: 1, text: '　　原计划改乙' }];
  f.workspace.readOriginalChapter = async (...args) => { (actions[0] as Extract<DocxBodyAction, { kind: 'update' }>).text = '不该写入'; return read(...args); };
  const result = await f.service.editBody(f.project.id, '原稿.docx', actions, f.frozen.hash);
  assert.deepEqual(await text(await fs.readFile(path.join(f.book, result.path))), ['　　甲', '　　原计划改乙', '　　丙']);
});
