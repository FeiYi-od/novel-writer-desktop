import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { Workspace } from '../src/main/workspace';
import { DocxCopyService } from '../src/main/docx-copy-service';
import { bodyParagraphTexts, structureTables } from '../src/main/docx-fidelity';
import type { DocxStructureAction } from '../src/shared/docx-structure';

const paragraph = (text: string) => `<w:p w14:paraId="ABCDEF12"><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (text: string) => `<w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr>${paragraph(text)}</w:tc>`;
const table = `<w:tbl w:rsidR="01234567"><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid>`
  + `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell('甲')}${cell('乙')}</w:tr><w:tr>${cell('丙')}${cell('丁').replace('</w:tc>', `${paragraph('丁第二段')}</w:tc>`)}</w:tr></w:tbl>`;
async function fixture(t: TestContext, options: { table?: string; header?: string; document?: string | Buffer } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-structure-037-')), book = path.join(root, '虚构书'); await fs.mkdir(book);
  const workspace = new Workspace(path.join(root, 'profile'), path.join(root, '创作资料')); await workspace.initialize(); const project = await workspace.attach(book);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', options.document ?? `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${paragraph('　　正文保留。')}${options.table ?? table}<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p></w:body></w:document>`);
  zip.file('word/header1.xml', options.header ?? `<w:hdr>${paragraph('原页眉')}</w:hdr>`);
  zip.file('word/footer1.xml', `<w:ftr>${paragraph('原页脚')}</w:ftr>`);
  zip.file('word/styles.xml', '<w:styles><w:style w:styleId="TableGrid"><w:name w:val="虚构样式"/></w:style></w:styles>');
  zip.file('word/media/keep.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]));
  const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), file = path.join(book, '外部原稿.docx'); await fs.writeFile(file, original);
  const source = await workspace.readOriginalChapter(project.id, '外部原稿.docx'), service = new DocxCopyService(workspace);
  const copies = async () => (await fs.readdir(book)).filter(name => name.endsWith('.docx') && name !== '外部原稿.docx');
  const load = async (relative: string) => JSZip.loadAsync(await fs.readFile(path.join(book, relative)));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, book, workspace, project, zip, original, file, source, service, copies, load };
}

test('结构快照显式绑定ID/路径/hash，读取有属性的表格和现有页眉页脚', async t => {
  const f = await fixture(t), snapshot = await f.service.structure(f.project.id, f.source.path, f.source.hash);
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.projectId, f.project.id); assert.equal(snapshot.path, f.source.path); assert.equal(snapshot.hash, f.source.hash);
  assert.equal(snapshot.tables.length, 1); assert.equal(snapshot.tables[0].editable, true); assert.equal(snapshot.tables[0].rows.length, 2); assert.deepEqual(snapshot.tables[0].rows[1].cells[1].paragraphs, ['丁', '丁第二段']);
  assert.deepEqual(snapshot.headers.map(header => [header.part, header.paragraphs, header.editable]), [['word/footer1.xml', ['原页脚'], true], ['word/header1.xml', ['原页眉'], true]]);
  assert.deepEqual(await fs.readFile(f.file), f.original); assert.deepEqual(await f.copies(), []);
});

test('单元格多段落改写保持真实双全角空格、空段、XML转义和既有样式，其余部件字节不变', async t => {
  const f = await fixture(t), paragraphs = ['　　新文<&>😀', '', '　　最后一段'];
  const result = await f.service.edit(f.project.id, f.source.path, { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs }, f.source.hash), after = await f.load(result.path), xml = await after.file('word/document.xml')!.async('string');
  assert.deepEqual(structureTables(xml)[0].rows[0].cells[0].paragraphs, paragraphs); assert.match(xml, /xml:space="preserve">　　新文&lt;&amp;&gt;😀/u); assert.match(xml, /<w:jc w:val="both"\/>/u); assert.match(xml, /<w:b\/>/u);
  assert.deepEqual(bodyParagraphTexts(xml), ['　　正文保留。', '']);
  for (const part of ['word/styles.xml', 'word/header1.xml', 'word/footer1.xml', 'word/media/keep.png', '[Content_Types].xml']) assert.deepEqual(await after.file(part)!.async('uint8array'), await f.zip.file(part)!.async('uint8array'));
  assert.deepEqual(await fs.readFile(f.file), f.original); assert.equal((await f.copies()).length, 1);
});

test('空单元格段落可填写；段落数量减少只删该格多余纯段落', async t => {
  const emptyTable = '<w:tbl><w:tr><w:tc><w:tcPr/><w:p/></w:tc></w:tr></w:tbl>', f = await fixture(t, { table: emptyTable });
  const fill = await f.service.edit(f.project.id, f.source.path, { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['　　空格可复制', '', '末段'] }, f.source.hash);
  const source = await f.workspace.readOriginalChapter(f.project.id, fill.path), reduce = await f.service.edit(f.project.id, fill.path, { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: [''] }, source.hash);
  assert.deepEqual(structureTables(await (await f.load(reduce.path)).file('word/document.xml')!.async('string'))[0].rows[0].cells[0].paragraphs, ['']);
  assert.deepEqual(await fs.readFile(f.file), f.original);
});

test('一批单元格/增删行/页眉页脚动作只发布一份副本，顺序坐标生效且新增行不复制段落ID', async t => {
  const f = await fixture(t); let published = 0; const publish = f.workspace.publishOriginalCopy.bind(f.workspace);
  f.workspace.publishOriginalCopy = async (...args) => { published++; return publish(...args); };
  const actions: DocxStructureAction[] = [
    { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['首格新文'] },
    { kind: 'appendRow', tableIndex: 0 }, { kind: 'cell', tableIndex: 0, rowIndex: 2, cellIndex: 1, paragraphs: ['新增行', ''] },
    { kind: 'removeRow', tableIndex: 0, rowIndex: 1 }, { kind: 'header', part: 'word/header1.xml', paragraphs: ['新页眉'] }, { kind: 'header', part: 'word/footer1.xml', paragraphs: [''] }
  ];
  const result = await f.service.batchEdit(f.project.id, f.source.path, actions, f.source.hash), zip = await f.load(result.path), xml = await zip.file('word/document.xml')!.async('string'), tables = structureTables(xml);
  assert.equal(published, 1); assert.equal((await f.copies()).length, 1); assert.equal(result.projectId, f.project.id); assert.equal(result.sourcePath, f.source.path); assert.equal(result.sourceHash, f.source.hash);
  assert.equal(tables[0].rows.length, 2); assert.deepEqual(tables[0].rows[0].cells[0].paragraphs, ['首格新文']); assert.deepEqual(tables[0].rows[1].cells[0].paragraphs, ['']); assert.deepEqual(tables[0].rows[1].cells[1].paragraphs, ['新增行', '']);
  assert.equal((xml.match(/w14:paraId=/gu) ?? []).length, 3, '仅正文和两个原始单元格保留旧ID，新行无重复ID');
  assert.match(await zip.file('word/header1.xml')!.async('string'), /新页眉/u); assert.deepEqual(await zip.file('word/media/keep.png')!.async('uint8array'), await f.zip.file('word/media/keep.png')!.async('uint8array')); assert.deepEqual(await fs.readFile(f.file), f.original);
});

test('异步处理冻结外部actions数组，调用后修改不能改变保存对象', async t => {
  const f = await fixture(t), actions = [{ kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['冻结文本'] }];
  const resultPromise = f.service.batchEdit(f.project.id, f.source.path, actions, f.source.hash); actions[0].paragraphs[0] = '迟到修改'; actions[0].tableIndex = 9999; actions.push({ ...actions[0] });
  const result = await resultPromise, xml = await (await f.load(result.path)).file('word/document.xml')!.async('string'); assert.deepEqual(structureTables(xml)[0].rows[0].cells[0].paragraphs, ['冻结文本']);
});

test('合并/嵌套/域/修订/复杂对象/书签/超链接表格只读，行和单元格操作全部拒绝', async t => {
  const variants = {
    merged: table.replace('<w:tcPr>', '<w:tcPr><w:gridSpan w:val="2"/>'),
    nested: table.replace(paragraph('甲'), `<w:tbl><w:tr>${cell('嵌套')}</w:tr></w:tbl>${paragraph('甲')}`),
    field: table.replace(paragraph('甲'), '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p>'),
    revision: table.replace(paragraph('甲'), `<w:p><w:ins>${paragraph('修订')}</w:ins></w:p>`),
    drawing: table.replace(paragraph('甲'), '<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>'),
    bookmark: table.replace(paragraph('甲'), '<w:p><w:bookmarkStart w:id="1"/><w:r><w:t>关联</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>'),
    hyperlink: table.replace(paragraph('甲'), '<w:p><w:hyperlink r:id="rId1"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>'),
    omittedGrid: table.replace('<w:trPr>', '<w:trPr><w:gridBefore w:val="1"/>')
  };
  for (const [name, xml] of Object.entries(variants)) await t.test(name, async sub => {
    const f = await fixture(sub, { table: xml }), snapshot = await f.service.structure(f.project.id, f.source.path, f.source.hash); assert.equal(snapshot.tables.length, 1); assert.equal(snapshot.tables[0].editable, false); assert.ok(snapshot.tables[0].reason);
    for (const action of [{ kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['拒绝'] }, { kind: 'appendRow', tableIndex: 0 }, { kind: 'removeRow', tableIndex: 0, rowIndex: 0 }]) await assert.rejects(f.service.edit(f.project.id, f.source.path, action, f.source.hash));
    assert.deepEqual(await f.copies(), []); assert.deepEqual(await fs.readFile(f.file), f.original);
  });
});

test('未编辑的复杂表格不阻止另一个简单表格安全改写，原复杂XML保持原字节', async t => {
  const complex = '<w:tbl><w:tr><w:tc><w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p></w:tc></w:tr></w:tbl>', f = await fixture(t, { table: complex + table });
  const snapshot = await f.service.structure(f.project.id, f.source.path, f.source.hash); assert.equal(snapshot.tables[0].editable, false); assert.equal(snapshot.tables[1].editable, true);
  const result = await f.service.edit(f.project.id, f.source.path, { kind: 'cell', tableIndex: 1, rowIndex: 0, cellIndex: 0, paragraphs: ['简单表新文'] }, f.source.hash), xml = await (await f.load(result.path)).file('word/document.xml')!.async('string'); assert.ok(xml.includes(complex)); assert.deepEqual(structureTables(xml)[1].rows[0].cells[0].paragraphs, ['简单表新文']);
});

test('页码域或图片页眉保持只读，不能通过旧edit接口绕过安全判断', async t => {
  for (const object of ['<w:r><w:fldChar w:fldCharType="begin"/></w:r>', '<w:r><w:drawing><wp:inline/></w:drawing></w:r>']) await t.test(object.includes('fldChar') ? 'field' : 'image', async sub => {
    const f = await fixture(sub, { header: `<w:hdr><w:p>${object}<w:r><w:t>复杂页眉</w:t></w:r></w:p></w:hdr>` }), snapshot = await f.service.structure(f.project.id, f.source.path, f.source.hash);
    assert.equal(snapshot.headers.find(header => header.part === 'word/header1.xml')!.editable, false); await assert.rejects(f.service.edit(f.project.id, f.source.path, { kind: 'header', part: 'word/header1.xml', paragraphs: ['不得覆盖'] }, f.source.hash), /复杂|Word/u); assert.deepEqual(await f.copies(), []);
  });
});

test('錯书/越界/缺失版本/过期原稿/非法索引均拒绝，不生成副本', async t => {
  const f = await fixture(t), action = { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['新文'] };
  for (const operation of [
    () => f.service.structure(f.project.id, '../外部原稿.docx', f.source.hash), () => f.service.structure(randomUUID(), f.source.path, f.source.hash), () => f.service.structure(f.project.id, f.source.path, undefined as never), () => f.service.structure(f.project.id, f.source.path, '0'.repeat(64)),
    () => f.service.batchEdit(f.project.id, '../外部原稿.docx', [action], f.source.hash), () => f.service.batchEdit(randomUUID(), f.source.path, [action], f.source.hash), () => f.service.batchEdit(f.project.id, f.source.path, [action], undefined as never), () => f.service.batchEdit(f.project.id, f.source.path, [action], '0'.repeat(64)),
    () => f.service.edit(f.project.id, f.source.path, { ...action, cellIndex: -1 }, f.source.hash), () => f.service.edit(f.project.id, f.source.path, { ...action, rowIndex: 9999 }, f.source.hash), () => f.service.edit(f.project.id, f.source.path, { ...action, tableIndex: 9999 }, f.source.hash)
  ]) await assert.rejects(operation);
  assert.deepEqual(await f.copies(), []); assert.deepEqual(await fs.readFile(f.file), f.original);
});

test('来源在发布前外部变化时整批拒绝，保留外部新版且没有混合副本', async t => {
  const f = await fixture(t), publish = f.workspace.publishOriginalCopy.bind(f.workspace), changed = Buffer.concat([f.original, Buffer.from('external')]);
  f.workspace.publishOriginalCopy = async (...args) => { await fs.writeFile(f.file, changed); return publish(...args); };
  await assert.rejects(f.service.batchEdit(f.project.id, f.source.path, [{ kind: 'appendRow', tableIndex: 0 }, { kind: 'header', part: 'word/header1.xml', paragraphs: ['不能落盘'] }], f.source.hash), /版本|变化/u); assert.deepEqual(await f.copies(), []); assert.deepEqual(await fs.readFile(f.file), changed);
});

test('结构读取完成前再次核对原件，迟到变化不返回旧hash快照', async t => {
  const f = await fixture(t), read = f.workspace.readOriginalChapter.bind(f.workspace); let calls = 0;
  f.workspace.readOriginalChapter = async (...args) => { if (++calls === 2) await fs.writeFile(f.file, Buffer.concat([f.original, Buffer.from('changed')])); return read(...args); };
  await assert.rejects(f.service.structure(f.project.id, f.source.path, f.source.hash), /版本|变化/u); assert.equal(calls, 2); assert.deepEqual(await f.copies(), []);
});

test('整批后项失败、最后一行删除、页眉增段均不发布半成品', async t => {
  const f = await fixture(t);
  for (const actions of [
    [{ kind: 'appendRow', tableIndex: 0 }, { kind: 'removeRow', tableIndex: 0, rowIndex: 9999 }],
    [{ kind: 'removeRow', tableIndex: 0, rowIndex: 1 }, { kind: 'removeRow', tableIndex: 0, rowIndex: 0 }],
    [{ kind: 'header', part: 'word/header1.xml', paragraphs: ['增加', '额外'] }],
    [{ kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: [] }]
  ]) await assert.rejects(f.service.batchEdit(f.project.id, f.source.path, actions, f.source.hash));
  assert.deepEqual(await f.copies(), []); assert.deepEqual(await fs.readFile(f.file), f.original);
});

test('动作数/整批文字/XML控制字符及孤立代理字符受到有界校验', async t => {
  const f = await fixture(t), action = { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['新文'] };
  for (const actions of [[], Array.from({ length: 101 }, () => action), Array.from({ length: 100 }, () => ({ ...action, paragraphs: ['字'.repeat(30000)] })), [{ ...action, paragraphs: ['\u0001'] }], [{ ...action, paragraphs: ['\ud800'] }]]) await assert.rejects(f.service.batchEdit(f.project.id, f.source.path, actions, f.source.hash));
  assert.deepEqual(await f.copies(), []); assert.deepEqual(await fs.readFile(f.file), f.original);
});

test('ZIP预检同样保护新增读取和整批入口，伪造尺寸不可绕过', async t => {
  const f = await fixture(t), forged = Buffer.from(f.original), central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); assert.ok(central > 0); forged.writeUInt32LE(1, central + 24); await fs.writeFile(f.file, forged); const source = await f.workspace.readOriginalChapter(f.project.id, f.source.path);
  await assert.rejects(f.service.structure(f.project.id, f.source.path, source.hash), /DOCX|解压|大小/u); await assert.rejects(f.service.batchEdit(f.project.id, f.source.path, [{ kind: 'appendRow', tableIndex: 0 }], source.hash), /DOCX|解压|大小/u); assert.deepEqual(await fs.readFile(f.file), forged); assert.deepEqual(await f.copies(), []);
});

test('无效UTF-8、未闭合XML及DTD不能被结构副本静默修复', async t => {
  for (const [name, document] of Object.entries({ invalidUTF8: Buffer.concat([Buffer.from('<w:document><w:body>'), Buffer.from([0xff]), Buffer.from('</w:body></w:document>')]), unclosed: `<w:document><w:body>${table}</w:document>`, dtd: `<!DOCTYPE w:document [<!ENTITY x "x">]><w:document><w:body>${table}</w:body></w:document>` })) await t.test(name, async sub => {
    const f = await fixture(sub, { document }); await assert.rejects(f.service.structure(f.project.id, f.source.path, f.source.hash)); await assert.rejects(f.service.batchEdit(f.project.id, f.source.path, [{ kind: 'appendRow', tableIndex: 0 }], f.source.hash)); assert.deepEqual(await f.copies(), []); assert.deepEqual(await fs.readFile(f.file), f.original);
  });
});

test('数值实体被正确读取；链接目录中的原稿拒绝，外部原件保持不变', async t => {
  const f = await fixture(t, { table: table.replace('甲', '&#x3000;&#12288;甲&amp;乙&#38;lt;<!--无显示注释-->') }), snapshot = await f.service.structure(f.project.id, f.source.path, f.source.hash); assert.deepEqual(snapshot.tables[0].rows[0].cells[0].paragraphs, ['　　甲&乙&lt;']);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, '外稿.docx'), f.original); await fs.symlink(outside, path.join(f.book, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.structure(f.project.id, 'linked/外稿.docx', f.source.hash)); await assert.rejects(f.service.batchEdit(f.project.id, 'linked/外稿.docx', [{ kind: 'appendRow', tableIndex: 0 }], f.source.hash)); assert.deepEqual(await fs.readFile(path.join(outside, '外稿.docx')), f.original);
});

test('结构单元格和页眉忽略注释/PI伪标签，改写保留标记并写入真实可见节点', async t => {
  const fake = '<!-- <w:r><w:rPr><w:b/></w:rPr><w:t>注释不能显示</w:t></w:r><w:p/><w:tbl/> -->';
  const pi = '<?ignore <w:r><w:t>PI不能显示</w:t></w:r> ?>';
  const inlineComment = '<!-- </w:t><w:t>注释伪结尾</w:t> -->', inlinePi = '<?ignore </w:t><w:t>PI伪结尾</w:t> ?>';
  const p = `<w:p>${fake}${pi}<w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>真${inlineComment}${inlinePi}文</w:t></w:r></w:p>`;
  const f = await fixture(t, { table: `<w:tbl><w:tr><w:tc>${p}</w:tc></w:tr></w:tbl>`, header: `<w:hdr>${p}</w:hdr>` });
  const snapshot = await f.service.structure(f.project.id, f.source.path, f.source.hash);
  assert.equal(snapshot.tables.length, 1); assert.equal(snapshot.tables[0].editable, true); assert.deepEqual(snapshot.tables[0].rows[0].cells[0].paragraphs, ['真文']);
  assert.equal(snapshot.headers.find(header => header.part === 'word/header1.xml')!.editable, true); assert.deepEqual(snapshot.headers.find(header => header.part === 'word/header1.xml')!.paragraphs, ['真文']);
  const result = await f.service.batchEdit(f.project.id, f.source.path, [
    { kind: 'cell', tableIndex: 0, rowIndex: 0, cellIndex: 0, paragraphs: ['　　单元格<&>😀', '　　新增格段'] },
    { kind: 'header', part: 'word/header1.xml', paragraphs: ['新页眉'] }
  ], f.source.hash), after = await f.load(result.path), xml = await after.file('word/document.xml')!.async('string'), headerXml = await after.file('word/header1.xml')!.async('string');
  assert.deepEqual(structureTables(xml)[0].rows[0].cells[0].paragraphs, ['　　单元格<&>😀', '　　新增格段']);
  assert.match(headerXml, /新页眉/u); assert.doesNotMatch(headerXml, /<w:t>真/u);
  for (const part of [xml, headerXml]) for (const token of [fake, pi, inlineComment, inlinePi]) assert.ok(part.includes(token), `原注释及PI保持原字节：${token}`);
  assert.deepEqual(await after.file('word/footer1.xml')!.async('uint8array'), await f.zip.file('word/footer1.xml')!.async('uint8array'));
  assert.deepEqual(await after.file('word/media/keep.png')!.async('uint8array'), await f.zip.file('word/media/keep.png')!.async('uint8array'));
  assert.deepEqual(await fs.readFile(f.file), f.original); assert.equal((await f.copies()).length, 1);
});
