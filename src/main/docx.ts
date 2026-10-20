import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { RichNode } from '../shared/contracts';
import { BODY_FONT, BODY_SIZE_PT, normalizeParagraphs } from '../core/typography';

/** 只导出已实现并可往返验证的文档结构，未知节点直接报错。 */
export function validateDocument(node: RichNode): void {
  if (node?.type !== 'doc' || !Array.isArray(node.content)) throw new Error('文档结构无效');
  if (node.content.length > 100000) throw new Error('段落数量过大');
  for (const block of node.content) {
    if (!['paragraph', 'heading'].includes(block.type)) throw new Error(`尚不支持此格式：${block.type}`);
    if (block.type === 'heading' && ![1, 2, 3].includes(Number(block.attrs?.level))) throw new Error('仅支持 1—3 级标题');
    for (const child of block.content ?? []) {
      if (!['text', 'hardBreak'].includes(child.type)) throw new Error(`尚不支持此内容：${child.type}`);
      if (child.type === 'text' && typeof child.text !== 'string') throw new Error('文本内容无效');
      if (child.marks?.some(m => !['bold', 'italic'].includes(m.type))) throw new Error('存在尚不支持的文字样式');
    }
  }
}

export async function encodeDocx(content: RichNode): Promise<Buffer> {
  validateDocument(content);
  content = normalizeParagraphs(content);
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const children = content.content!.map(block => new Paragraph({
    heading: block.type === 'heading' ? headings[Number(block.attrs?.level) - 1] : undefined,
    spacing: { after: 160, line: 360 },
    children: (block.content ?? []).map(run => run.type === 'hardBreak'
      ? new TextRun({ break: 1 })
      : new TextRun({ text: run.text ?? '', bold: run.marks?.some(m => m.type === 'bold'), italics: run.marks?.some(m => m.type === 'italic') }))
  }));
  return Packer.toBuffer(new Document({
    creator: '小说编写器',
    title: '小说章节',
    styles: { default: { document: { run: { font: BODY_FONT, size: BODY_SIZE_PT * 2 } } } },
    sections: [{ children }]
  }));
}
