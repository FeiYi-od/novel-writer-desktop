import type { RichNode } from '../shared/contracts';
import { normalizeParagraphs } from '../core/typography';
export function decodeText(bytes: Buffer) {
  if (bytes[0] === 255 && bytes[1] === 254) return { text: new TextDecoder('utf-16le', { fatal: true }).decode(bytes), encoding: 'utf-16le' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('gb18030', { fatal: true }).decode(bytes), encoding: 'gb18030' }; }
}
export function textDocument(text: string): RichNode {
  const paragraphs = text.split(/\r\n|\n|\r/).filter(line => line.trim());
  return normalizeParagraphs({ type: 'doc', content: (paragraphs.length ? paragraphs : ['']).map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
}

/** TXT 正文按行导入：空行和文件末尾的换行都是用户内容。 */
export function txtDocument(text: string): RichNode {
  return normalizeParagraphs({ type: 'doc', content: text.split(/\r\n|\n|\r/).map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) });
}

/** TXT 的换行分隔符与用于复制到平台的双换行格式不同。 */
export function txtText(document: RichNode): string {
  return (normalizeParagraphs(document).content ?? []).map(block =>
    (block.content ?? []).map(run => run.type === 'hardBreak' ? '\n' : run.text ?? '').join('')
  ).join('\n');
}
