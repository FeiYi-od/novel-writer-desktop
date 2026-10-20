import JSZip from 'jszip';

export interface DocxFeature { feature: string; count: number; preserved: boolean; note: string }
export interface DocxCapabilityReport { features: DocxFeature[]; preservedText: boolean; risks: string[] }
const checks: { key: keyof RawParts | 'document'; feature: string; test: RegExp; note: string }[] = [
  { key: 'document', feature: '表格', test: /<w:tbl[ />]/u, note: '当前编辑器只保留正文段落，表格会作为纯文字读入，边框与单元格结构不保留' },
  { key: 'document', feature: '图片', test: /<w:drawing[ />]|<w:pict[ />]/u, note: '图片不会出现在正文中；原件不会被修改，可随时用 Word/WPS 打开' },
  { key: 'document', feature: '超链接', test: /<w:hyperlink[ />]/u, note: '链接地址会丢失，只保留链接文字' },
  { key: 'document', feature: '脚注/尾注引用', test: /<w:(footnoteReference|endnoteReference)[ />]/u, note: '脚注与尾注不会保留' },
  { key: 'document', feature: '公式', test: /<m:oMath[ />]/u, note: '公式不会保留' },
  { key: 'document', feature: '批注', test: /<w:commentReference[ />]/u, note: '批注不会保留' },
  { key: 'document', feature: '页眉页脚引用', test: /<w:headerReference[ />]|<w:footerReference[ />]/u, note: '页眉页脚属于页面设置，当前编辑器不保留' },
  { key: 'document', feature: '分节', test: /<w:sectPr[ />]/u, note: '分节与页面尺寸不保留，保存时按本应用默认页面重建' },
  { key: 'document', feature: '文本框/形状', test: /<w:txbxContent[ />]/u, note: '文本框内容可能丢失' }
];
interface RawParts { document: string; headers: string[]; footnotes: string[] }
const collect = (name: string) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/u.test(name);
/** Reports what this editor will and will not keep when a DOCX is opened. Read-only: the file is
 * never rewritten here, and every unsupported feature is named instead of silently dropped. */
export async function analyzeDocx(bytes: Buffer): Promise<DocxCapabilityReport> {
  const zip = await JSZip.loadAsync(bytes);
  const parts: RawParts = { document: '', headers: [], footnotes: [] };
  for (const name of Object.keys(zip.files)) {
    if (!collect(name) || zip.files[name].dir) continue;
    const xml = await zip.files[name].async('string');
    if (name === 'word/document.xml') parts.document = xml;
    else if (/header|footer/u.test(name)) parts.headers.push(xml);
    else parts.footnotes.push(xml);
  }
  if (!parts.document) throw new Error('不是有效的 DOCX：缺少 word/document.xml');
  const features: DocxFeature[] = [];
  for (const check of checks) {
    const source = check.key === 'document' ? parts.document : [...parts.headers, ...parts.footnotes].join('\n');
    const count = (source.match(new RegExp(check.test.source, 'gu')) ?? []).length;
    if (count) features.push({ feature: check.feature, count, preserved: false, note: check.note });
  }
  if (parts.headers.length && !features.some(item => item.feature.startsWith('页眉'))) {
    features.push({ feature: '页眉/页脚', count: parts.headers.length, preserved: false,
      note: '文档里存在独立的页眉/页脚部件，属于页面设置，当前编辑器不会保留' });
  }
  const bold = /<w:b\/>|<w:b [^>]*\/>/u.test(parts.document);
  const italic = /<w:i\/>|<w:i [^>]*\/>/u.test(parts.document);
  const heading = /<w:pStyle w:val="Heading/u.test(parts.document);
  features.unshift({
    feature: '正文文字与段落', count: 1, preserved: true,
    note: `会保留：文字内容、段落划分${bold ? '、粗体' : ''}${italic ? '、斜体' : ''}${heading ? '、标题层级' : ''}；保存时按本应用默认排版（宋体五号、段首两个全角空格）重写`
  });
  const risks = features.filter(item => !item.preserved).map(item => `${item.feature} ×${item.count}：${item.note}`);
  return { features, preservedText: true, risks };
}
