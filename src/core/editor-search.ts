import type { Node } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';

export interface SearchOptions { query: string; matchCase: boolean }
export interface SearchMatch { from: number; to: number }
export interface SearchResult { matches: SearchMatch[]; truncated: boolean }
export const SEARCH_LIMIT = 10000;

/** Literal, non-overlapping matches within one text block/line. Positions remain
 * accurate across differently styled text runs and Unicode surrogate pairs. */
export function findChapterMatches(doc: Node, options: SearchOptions): SearchResult {
  const result: SearchResult = { matches: [], truncated: false };
  if (!options.query || /[\r\n]/u.test(options.query)) return result;
  const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, options.matchCase ? 'gu' : 'giu');
  doc.descendants((block, position) => {
    if (result.truncated || !['paragraph', 'heading'].includes(block.type.name)) return false;
    let text = '', start = position + 1;
    const flush = () => {
      // Mandatory paragraph prefix is typography, not a replaceable match.
      const prefix = block.type.name === 'paragraph' && start === position + 1
        ? text.match(/^[\u3000 \t]*/u)?.[0].length ?? 0 : 0;
      const searchable = text.slice(prefix);
      pattern.lastIndex = 0;
      for (let match = pattern.exec(searchable); match; match = pattern.exec(searchable)) {
        if (result.matches.length === SEARCH_LIMIT) { result.truncated = true; break; }
        const from = start + prefix + match.index;
        result.matches.push({ from, to: from + match[0].length });
      }
    };
    block.forEach((child, offset) => {
      if (child.isText) text += child.text;
      else { flush(); text = ''; start = position + 1 + offset + child.nodeSize; }
    });
    if (!result.truncated) flush();
    return false;
  });
  return result;
}

/** Recompute against the current document; never apply cached search ranges.
 * Replacement inherits the first matched character's marks. Unmatched runs
 * and block structure are retained; the whole operation is one undo step. */
export function replaceChapterMatches(state: EditorState, options: SearchOptions, replacement: string, onlyFrom?: number): { transaction: Transaction; count: number } {
  if (!options.query || /[\r\n]/u.test(options.query + replacement)) throw new Error('查找和替换仅支持单行文字');
  const result = findChapterMatches(state.doc, options);
  if (onlyFrom === undefined && result.truncated) throw new Error('匹配超过10000处，请缩小查找范围后替换');
  const matches = onlyFrom === undefined ? result.matches : result.matches.filter(match => match.from === onlyFrom);
  if (onlyFrom !== undefined && !matches.length) throw new Error('当前匹配已变化，请重新查找');
  const tr = closeHistory(state.tr);
  for (const match of [...matches].reverse()) {
    if (replacement) tr.replaceWith(match.from, match.to, state.schema.text(replacement, state.doc.nodeAt(match.from)?.marks));
    else tr.delete(match.from, match.to);
  }
  return { transaction: tr.scrollIntoView(), count: matches.length };
}
