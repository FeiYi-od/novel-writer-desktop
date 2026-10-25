import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { appendTableRow, bodyParagraphTexts, listImages, listTables, removeTableRow, replaceImage, rewriteDocxParagraphs, rewriteHeaderTexts, topLevelParagraphs } from '../src/main/docx-fidelity';

const paragraph = (text: string, run = 1) => `<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${Array.from({ length: run }, () => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`).join('')}</w:p>`;

async function buildDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>`
    + paragraph('　　H 盘同步写入测试，纯虚构内容。')
    + paragraph('　　第二段：验证同步目录读写。')
    + `<w:tbl><w:tr><w:tc>${paragraph('表格里的文字')}</w:tc></w:tr></w:tbl>`
    + `<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>`
    + paragraph('　　第四段：保留页眉与表格。')
    + `</w:body></w:document>`);
  zip.file('word/header1.xml', '<w:hdr><w:p><w:r><w:t>页眉：示例小说</w:t></w:r></w:p></w:hdr>');
  const media = zip.folder('word/media');
  if (!media) throw new Error('media folder');
  media.file('image1.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  zip.file('word/styles.xml', '<w:styles><w:style w:styleId="Normal"/></w:styles>');
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

test('Word 保真改写：只改正文段落文字，表格/图片/页眉/样式原封不动', async () => {
  const original = await buildDocx();
  const before = await bodyParagraphTextsFrom(original);
  assert.deepEqual(before, ['　　H 盘同步写入测试，纯虚构内容。', '　　第二段：验证同步目录读写。', '', '　　第四段：保留页眉与表格。'], '表格内段落不应被当成正文段落');
  const result = await rewriteDocxParagraphs(original, ['　　改写后的第一段。', '　　第二段：验证同步目录读写。', '', '　　改写后的第四段。']);
  assert.equal(result.paragraphs, 4);
  assert.equal(result.changed, 2, '只有两段文字真的变了');
  const after = await bodyParagraphTextsFrom(result.bytes);
  assert.deepEqual(after, ['　　改写后的第一段。', '　　第二段：验证同步目录读写。', '', '　　改写后的第四段。']);

  const zipBefore = await JSZip.loadAsync(original), zipAfter = await JSZip.loadAsync(result.bytes);
  for (const name of ['word/header1.xml', 'word/styles.xml', 'word/media/image1.png', '[Content_Types].xml']) {
    assert.deepEqual(await zipAfter.file(name)!.async('uint8array'), await zipBefore.file(name)!.async('uint8array'), `${name} 必须逐字节保持原样`);
  }
  const body = await zipAfter.file('word/document.xml')!.async('string');
  assert.match(body, /<w:tbl>/u, '表格结构保留');
  assert.match(body, /<w:drawing>/u, '图片保留');
  assert.match(body, /<w:jc w:val="both"\/>/u, '段落属性保留');
  assert.match(body, /表格里的文字/u, '表格内文字不被改写');
});

test('Word 保真改写：段落数不一致时拒绝，避免破坏原稿', async () => {
  const original = await buildDocx();
  await assert.rejects(rewriteDocxParagraphs(original, ['只有一段']), /段落数不一致/u);
  const notDocx = await new JSZip().generateAsync({ type: 'uint8array' });
  await assert.rejects(rewriteDocxParagraphs(notDocx, []), /缺少 word\/document.xml/u);
});

test('段落扫描：多 run 段落拼接、未闭合 XML 保守拒绝', async () => {
  const xml = `<w:body>${paragraph('前半').replace('</w:p>', `<w:r><w:t>后半</w:t></w:r></w:p>`)}<w:tbl>${paragraph('x')}</w:tbl></w:body>`;
  const blocks = topLevelParagraphs(xml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.text, '前半后半');
  assert.throws(() => topLevelParagraphs('<w:body><w:p><w:r><w:t>没有结束</w:t></w:r>'), /未闭合/u, '损坏 XML 不能作为可编辑基准');
});

async function bodyParagraphTextsFrom(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  return bodyParagraphTexts(await zip.file('word/document.xml')!.async('string'));
}

test('Word 保真改写（结构）：新增只复制段落样式，删除文字段不影响表格', async () => {
  const original = await buildDocx();
  const added = await rewriteDocxParagraphs(original, ['　　第一段。', '　　第二段。', '', '　　新增的第四段。', '　　新增的第五段。'], { structural: true });
  assert.equal(added.paragraphs, 5);
  const zipAdded = await JSZip.loadAsync(added.bytes);
  const xmlAdded = await zipAdded.file('word/document.xml')!.async('string');
  assert.match(xmlAdded, /新增的第四段/u);
  assert.match(xmlAdded, /新增的第五段/u);
  assert.match(xmlAdded, /<w:jc w:val="both"\/>/u, '新增段落继承段落属性');
  assert.match(xmlAdded, /<w:tbl>/u, '表格仍在');
  assert.match(xmlAdded, /表格里的文字/u, '表格文字未被改写');
  assert.match(xmlAdded, /<w:drawing>/u, '图片仍在');
  assert.deepEqual(await (await JSZip.loadAsync(added.bytes)).file('word/header1.xml')!.async('uint8array'), await (await JSZip.loadAsync(original)).file('word/header1.xml')!.async('uint8array'));

  const removed = await rewriteDocxParagraphs(original, ['　　只剩第一段。', '　　第二段：验证同步目录读写。', ''], { structural: true });
  assert.equal(removed.paragraphs, 3);
  const xmlRemoved = await (await JSZip.loadAsync(removed.bytes)).file('word/document.xml')!.async('string');
  assert.equal(bodyParagraphTexts(xmlRemoved).length, 3, '返回段落数与实际输出一致');
  assert.match(xmlRemoved, /只剩第一段/u);
  assert.doesNotMatch(xmlRemoved, /第四段：保留页眉与表格/u, '真正被删段落不再出现');
  assert.match(xmlRemoved, /<w:tbl>/u, '删段落不影响表格');
  assert.match(xmlRemoved, /<w:drawing>/u, '未被删除段落里的图片保留');
});

async function docxFromBody(body: string) {
  const zip = new JSZip();
  zip.file('word/document.xml', `<w:document><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array' });
}

test('Word 删段安全：带图片、节属性、书签的尾段明确拒绝，不能静默删掉引用', async () => {
  for (const anchored of ['<w:r><w:drawing><wp:inline/></w:drawing></w:r>', '<w:pPr><w:sectPr/></w:pPr>', '<w:bookmarkStart w:id="3" w:name="目标"/>']) {
    const original = await docxFromBody(`${paragraph('保留')}<w:p>${anchored}<w:r><w:t>尾段</w:t></w:r></w:p>`);
    await assert.rejects(rewriteDocxParagraphs(original, ['保留'], { structural: true }), /无法安全删除|图片|节属性|书签/u);
  }
});

test('Word 新增段落：复制文字样式而不复制末段图片或重复标识', async () => {
  const original = await docxFromBody('<w:p w14:paraId="12345678"><w:pPr><w:jc w:val="both"/></w:pPr><w:bookmarkStart w:id="4" w:name="原段"/><w:r><w:rPr><w:b/></w:rPr><w:t>原文</w:t><w:drawing><wp:inline/></w:drawing></w:r></w:p>');
  const next = await rewriteDocxParagraphs(original, ['原文', '　　新增。'], { structural: true });
  const xml = await (await JSZip.loadAsync(next.bytes)).file('word/document.xml')!.async('string');
  assert.deepEqual(bodyParagraphTexts(xml), ['原文', '　　新增。']);
  assert.equal((xml.match(/<w:drawing>/gu) ?? []).length, 1, '新增段落不复制图片');
  assert.equal((xml.match(/<w:bookmarkStart/gu) ?? []).length, 1, '不复制书签 id');
  assert.equal((xml.match(/w14:paraId=/gu) ?? []).length, 1, '不复制段落 id');
  assert.equal((xml.match(/<w:jc w:val="both"\/>/gu) ?? []).length, 2, '仍继承段落样式');
  assert.equal((xml.match(/<w:b\/>/gu) ?? []).length, 2, '仍继承文字样式');
});

test('Word 空段和多文本片段：空段能写入，重写不多出旧片段空格', async () => {
  const original = await docxFromBody('<w:p/><w:p><w:pPr><w:jc w:val="both"/></w:pPr></w:p>' + paragraph('旧', 2));
  assert.deepEqual(await bodyParagraphTextsFrom(original), ['', '', '旧旧'], '自闭合空段独立计数');
  const next = await rewriteDocxParagraphs(original, ['　　第一空段。', '　　第二空段。', '　　改写。']);
  assert.deepEqual(await bodyParagraphTextsFrom(next.bytes), ['　　第一空段。', '　　第二空段。', '　　改写。']);
  const xml = await (await JSZip.loadAsync(next.bytes)).file('word/document.xml')!.async('string');
  assert.match(xml, /xml:space="preserve">　　第一空段。/u);
});

test('Word 未改文字保留整个段落；文本框文字不与外层段落混改', async () => {
  const block = '<w:p><w:r><w:t xml:space="preserve">甲</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">乙</w:t></w:r></w:p>';
  const original = await docxFromBody(block);
  const next = await rewriteDocxParagraphs(original, ['甲乙']);
  const xml = await (await JSZip.loadAsync(next.bytes)).file('word/document.xml')!.async('string');
  assert.ok(xml.includes(block), '无改动时不清空后续格式片段');
  const nested = await docxFromBody('<w:p><w:r><w:t>外层</w:t><w:drawing><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r></w:p>' + paragraph('下一段'));
  assert.equal((await bodyParagraphTextsFrom(nested)).length, 2, '内嵌文本框不能提前结束外层段落');
  await assert.rejects(rewriteDocxParagraphs(nested, ['修改', '下一段']), /文本框|无法安全改写/u);
});

test('Word 自闭合文本节点：不吞并后面的文字，空节点可填写', async () => {
  const original = await docxFromBody('<w:p><w:r><w:t xml:space="preserve"/></w:r><w:r><w:t>旧文</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve"/></w:r></w:p>');
  assert.deepEqual(await bodyParagraphTextsFrom(original), ['旧文', '']);
  const next = await rewriteDocxParagraphs(original, ['新文', '　　填写。']);
  assert.deepEqual(await bodyParagraphTextsFrom(next.bytes), ['新文', '　　填写。']);
  const xml = await (await JSZip.loadAsync(next.bytes)).file('word/document.xml')!.async('string');
  assert.equal((xml.match(/<w:r>/gu) ?? []).length, (xml.match(/<\/w:r>/gu) ?? []).length, '文字改写不能吞掉run结束标签');
});

test('Word 注释与 PI 中的伪段落/表格/文字不参与扫描，改写只修改真实节点且保留原标记', async () => {
  const outsideComment = '<!-- <w:tbl><w:p><w:r><w:t>伪正文</w:t></w:r></w:p> -->';
  const outsidePi = '<?ignore <w:p><w:r><w:t>伪PI段落</w:t></w:r></w:p> ?>';
  const fakeStyle = '<!-- <w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>伪文字</w:t></w:r> -->';
  const inTextComment = '<!-- </w:t><w:t>伪结束文字</w:t><w:p/> -->', inTextPi = '<?ignore </w:t><w:t>伪PI文字</w:t> ?>';
  const real = `<w:p>${fakeStyle}<w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>前${inTextComment}${inTextPi}后&amp;文</w:t></w:r></w:p>`;
  const table = `<w:tbl><w:tr><w:tc>${paragraph('表格不动')}</w:tc></w:tr></w:tbl>`;
  const original = await docxFromBody(outsideComment + outsidePi + real + table), before = await JSZip.loadAsync(original), beforeXml = await before.file('word/document.xml')!.async('string');
  assert.deepEqual(bodyParagraphTexts(beforeXml), ['前后&文']);
  const unchanged = await rewriteDocxParagraphs(original, ['前后&文']);
  assert.equal(await (await JSZip.loadAsync(unchanged.bytes)).file('word/document.xml')!.async('string'), beforeXml);
  const edited = await rewriteDocxParagraphs(original, ['　　改写<&>😀', '　　新增正文'], { structural: true });
  const xml = await (await JSZip.loadAsync(edited.bytes)).file('word/document.xml')!.async('string');
  assert.deepEqual(bodyParagraphTexts(xml), ['　　改写<&>😀', '　　新增正文']);
  for (const token of [outsideComment, outsidePi, fakeStyle, inTextComment, inTextPi, table]) assert.ok(xml.includes(token), `原标记/表格必须原字节保留：${token}`);
  const added = topLevelParagraphs(xml)[1]!, addedXml = xml.slice(added.start, added.end);
  assert.match(addedXml, /<w:jc w:val="center"\/>/u); assert.match(addedXml, /<w:i\/>/u);
  assert.doesNotMatch(addedXml, /<w:b\/>|伪文字|w:val="right"/u, '新增段落不能从注释伪标签复制样式');
});

test('Word 删除尾部纯文字段落不把注释中的伪书签/域当作真实关联对象', async () => {
  const fake = '<!-- <w:bookmarkStart w:id="1"/><w:fldChar/><w:sectPr/> -->';
  const original = await docxFromBody(paragraph('保留') + `<w:p>${fake}<w:r><w:t>纯文字尾段</w:t></w:r></w:p>`);
  const edited = await rewriteDocxParagraphs(original, ['保留'], { structural: true });
  assert.deepEqual(await bodyParagraphTextsFrom(edited.bytes), ['保留']);
});

test('Word 文本节点的 CDATA、未知实体和非法数值实体明确拒绝，不能隐式修复', async () => {
  for (const text of ['<![CDATA[不支持]]>', '&unknown;', '&#0;', '&#xD800;', '\u0001']) {
    const original = await docxFromBody(`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`);
    await assert.rejects(rewriteDocxParagraphs(original, ['不能写入']), /CDATA|XML|实体|字符/u);
  }
  const valid = await docxFromBody('<w:p><w:r><w:t>&#x4E2D;&#x6587;&#x1F600;</w:t></w:r></w:p>');
  assert.deepEqual(await bodyParagraphTextsFrom(valid), ['中文😀']);
});
test('表格行增删：追加空行继承样式、删除指定行，表格外内容与页眉图片不动', async () => {
  const original = await buildDocx();
  const tablesBefore = listTables(await (await JSZip.loadAsync(original)).file('word/document.xml')!.async('string'));
  assert.equal(tablesBefore.length, 1);
  assert.equal(tablesBefore[0]!.rows, 1);
  const added = await appendTableRow(original, 0);
  const xmlAdded = await (await JSZip.loadAsync(added.bytes)).file('word/document.xml')!.async('string');
  const tablesAdded = listTables(xmlAdded);
  assert.equal(tablesAdded[0]!.rows, 2, '应多出一行');
  assert.equal(tablesAdded[0]!.cellsPerRow[1], tablesAdded[0]!.cellsPerRow[0], '新行列数与原来一致');
  assert.equal(tablesAdded[0]!.preview.includes('表格里的文字'), true, '原来的行文字保留');
  assert.equal((xmlAdded.match(/<w:tbl>/gu) ?? []).length, 1, '仍然只有一个表格');
  assert.match(xmlAdded, /<w:drawing>/u, '图片仍在');
  assert.deepEqual(await (await JSZip.loadAsync(added.bytes)).file('word/header1.xml')!.async('uint8array'), await (await JSZip.loadAsync(original)).file('word/header1.xml')!.async('uint8array'));
  // 删掉刚加的行
  const removed = await removeTableRow(added.bytes, 0, 1);
  assert.equal(listTables(await (await JSZip.loadAsync(removed.bytes)).file('word/document.xml')!.async('string'))[0]!.rows, 1);
  // 只有一行时不能再删
  await assert.rejects(removeTableRow(original, 0, 0), /至少保留一行/u);
  await assert.rejects(appendTableRow(original, 3), /不存在/u);
});

test('页眉改写：只换页眉文字，正文与图片不受影响', async () => {
  const original = await buildDocx();
  const result = await rewriteHeaderTexts(original, 'word/header1.xml', ['页眉：改名后的书稿']);
  assert.equal(result.changed, 1);
  const zip = await JSZip.loadAsync(result.bytes);
  assert.match(await zip.file('word/header1.xml')!.async('string'), /改名后的书稿/u);
  const body = await zip.file('word/document.xml')!.async('string');
  assert.match(body, /H 盘同步写入测试/u, '正文不动');
  assert.match(body, /<w:drawing>/u, '图片仍在');
  assert.deepEqual(await zip.file('word/media/image1.png')!.async('uint8array'), await (await JSZip.loadAsync(original)).file('word/media/image1.png')!.async('uint8array'));
  await assert.rejects(rewriteHeaderTexts(original, 'word/footer9.xml', ['x']), /没有 word\/footer9\.xml/u);
});
test('图片替换：只换目标图片，正文/表格/页眉不动；扩展名变化会补 Content_Types', async () => {
  const original = await buildDocx();
  const images = await listImages(original);
  assert.deepEqual(images.map(item => item.name), ['word/media/image1.png']);
  const replacement = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc]);
  const result = await replaceImage(original, 'word/media/image1.png', replacement);
  const zip = await JSZip.loadAsync(result.bytes), before = await JSZip.loadAsync(original);
  assert.deepEqual(await zip.file('word/media/image1.png')!.async('uint8array'), replacement, '图片已替换');
  assert.deepEqual(await zip.file('word/document.xml')!.async('uint8array'), await before.file('word/document.xml')!.async('uint8array'), '正文 XML 未改');
  assert.deepEqual(await zip.file('word/header1.xml')!.async('uint8array'), await before.file('word/header1.xml')!.async('uint8array'));
  await assert.rejects(replaceImage(original, 'word/media/missing.png', replacement), /没有 word\/media\/missing\.png/u);
  await assert.rejects(replaceImage(original, 'word/document.xml', replacement), /只能替换/u);
  // 扩展名变化时补 Default
  const changedExt = await replaceImage(original, 'word/media/image1.png', replacement);
  const typesXml = await (await JSZip.loadAsync(changedExt.bytes)).file('[Content_Types].xml')!.async('string');
  assert.match(typesXml, /image\/png|<\/Types>/u);
});
