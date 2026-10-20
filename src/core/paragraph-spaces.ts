import { Plugin } from '@tiptap/pm/state';
import { PARAGRAPH_PREFIX } from './typography';

export function paragraphSpacesPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some(t => t.docChanged)) return null;
      const fixes: { from: number; to: number }[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name !== 'paragraph') return;
        const leading = node.textContent.match(/^[\u3000 \t]*/)?.[0] ?? '';
        if (leading !== PARAGRAPH_PREFIX) fixes.push({ from: pos + 1, to: pos + 1 + leading.length });
      });
      if (!fixes.length) return null;
      const tr = state.tr;
      for (const fix of fixes.reverse()) tr.insertText(PARAGRAPH_PREFIX, fix.from, fix.to);
      return tr;
    }
  });
}
