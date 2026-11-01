import type { DocxBodyAction, DocxBodySnapshot } from '../shared/docx-body';

export interface BodyDraftParagraph {
  key: string;
  sourceIndex: number | null;
  text: string;
  anchor: number;
  position: 'before' | 'after';
  editable: boolean;
  insertable: boolean;
  removable: boolean;
  reason?: string;
}

export function bodyDraft(snapshot: DocxBodySnapshot): BodyDraftParagraph[] {
  return snapshot.paragraphs.map(p => ({ ...p, key: `original-${p.index}`, sourceIndex: p.index, anchor: p.index, position: 'after' }));
}

/** New paragraphs retain an original XML anchor even when that original is removed. */
export function insertBodyParagraph(draft: BodyDraftParagraph[], selected: number, position: 'before' | 'after', key: string): BodyDraftParagraph[] {
  const reference = draft[selected];
  if (!reference?.insertable || draft.some(p => p.key === key)) throw new Error('所选段落不能插入新段落');
  const added: BodyDraftParagraph = {
    key, sourceIndex: null, text: '\u3000\u3000', anchor: reference.sourceIndex ?? reference.anchor,
    position: reference.sourceIndex === null ? reference.position : position,
    editable: true, insertable: true, removable: true
  };
  const at = selected + (position === 'after' ? 1 : 0);
  return [...draft.slice(0, at), added, ...draft.slice(at)];
}

export function bodyActions(snapshot: DocxBodySnapshot | null, draft: BodyDraftParagraph[]): DocxBodyAction[] {
  if (!snapshot) return [];
  const originals = new Map(draft.filter(p => p.sourceIndex !== null).map(p => [p.sourceIndex, p]));
  const actions: DocxBodyAction[] = [];
  for (const original of snapshot.paragraphs) {
    const item = originals.get(original.index);
    if (!item) actions.push({ kind: 'remove', index: original.index });
    else if (item.text !== original.text) actions.push({ kind: 'update', index: original.index, text: item.text });
  }
  const inserts = new Map<string, Extract<DocxBodyAction, { kind: 'insert' }>>();
  for (const item of draft) if (item.sourceIndex === null) {
    const key = `${item.anchor}:${item.position}`;
    let action = inserts.get(key);
    if (!action) { action = { kind: 'insert', index: item.anchor, position: item.position, paragraphs: [] }; inserts.set(key, action); }
    action.paragraphs.push(item.text);
  }
  return [...actions, ...inserts.values()];
}

export function bodyStructuralChanges(snapshot: DocxBodySnapshot | null, draft: BodyDraftParagraph[]): number {
  return bodyActions(snapshot, draft).reduce((sum, action) => sum + (action.kind === 'remove' ? 1 : action.kind === 'insert' ? action.paragraphs.length : 0), 0);
}
