/** Every index always refers to the frozen source, never to earlier actions. */
export type DocxBodyAction =
  | { kind: 'update'; index: number; text: string }
  | { kind: 'remove'; index: number }
  | { kind: 'insert'; index: number; position: 'before' | 'after'; paragraphs: string[] };

export interface DocxBodyParagraph {
  index: number;
  text: string;
  editable: boolean;
  insertable: boolean;
  removable: boolean;
  reason?: string;
}
export interface DocxBodySnapshot {
  schemaVersion: 1;
  projectId: string;
  path: string;
  hash: string;
  paragraphs: DocxBodyParagraph[];
}
export interface DocxBodyEditResult {
  projectId: string;
  sourcePath: string;
  sourceHash: string;
  path: string;
  paragraphs: number;
  changed: number;
}
