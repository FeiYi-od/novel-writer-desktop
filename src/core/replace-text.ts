import type { RichNode } from '../shared/contracts';

export interface ReplaceOptions { caseSensitive?: boolean; maxPerChapter?: number }
export interface ReplaceResult { document: RichNode; count: number; truncated: boolean }
/** Replaces text inside ordinary text nodes and keeps every mark, attribute and structure intact.
 * Only text changes; nothing is inserted into headings' attrs, code blocks or non-text nodes. */
export function replaceInDocument(document: RichNode, query: string, replacement: string, options: ReplaceOptions = {}): ReplaceResult {
  const needle = query ?? '';
  if (!needle.trim()) throw new Error('查找内容不能为空');
  if (needle.length > 2000) throw new Error('查找内容过长（最多 2000 字）');
  const limit = Math.max(1, Math.min(100_000, options.maxPerChapter ?? 100_000));
  const caseSensitive = options.caseSensitive ?? true;
  let count = 0, truncated = false;
  const compare = (text: string, at: number) => {
    const slice = text.slice(at, at + needle.length);
    return caseSensitive ? slice === needle : slice.toLowerCase() === needle.toLowerCase();
  };
  const walk = (node: RichNode): RichNode => {
    if (node.type === 'text') {
      const text = String(node.text ?? '');
      if (!text) return node;
      let output = '', index = 0;
      while (index < text.length) {
        if (count >= limit) { truncated = true; output += text.slice(index); break; }
        if (index + needle.length <= text.length && compare(text, index)) {
          output += replacement; count += 1; index += needle.length;
        } else { output += text[index]; index += 1; }
      }
      return { ...node, text: output };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(walk) };
  };
  return { document: walk(document), count, truncated };
}
