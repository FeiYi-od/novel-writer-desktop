import type { RichNode } from '../shared/contracts';

export const PARAGRAPH_PREFIX = '\u3000\u3000';
export const BODY_FONT = '宋体';
export const BODY_SIZE_PT = 10.5;

export function copyableText(document: RichNode): string {
  return (normalizeParagraphs(document).content ?? []).map(block =>
    (block.content ?? []).map(run => run.type === 'hardBreak' ? '\n' : run.text ?? '').join('')
  ).join('\n\n');
}

/** 使用真实字符，复制到纯文本平台时仍保留；标题不加段首空格。 */
export function normalizeParagraphs(document: RichNode): RichNode {
  return { ...document, content: document.content?.map(block => {
    if (block.type !== 'paragraph') return block;
    const children = [...(block.content ?? [])].map(child => ({ ...child }));
    // 跨多个样式片段清除旧的前导空白，统一成两个全角空格。
    while (children[0]?.type === 'text') {
      children[0].text = children[0].text!.replace(/^[\u3000 \t]+/, '');
      if (children[0].text) break;
      children.shift();
    }
    if (children[0]?.type === 'text') children[0].text = PARAGRAPH_PREFIX + children[0].text;
    else children.unshift({ type: 'text', text: PARAGRAPH_PREFIX });
    return { ...block, content: children };
  }) };
}
