/** All indices refer to the snapshot (or to preceding actions in the same batch). */
export interface DocxStructureSafety { editable: boolean; reason?: string }
export interface DocxStructureCell extends DocxStructureSafety { index: number; paragraphs: string[] }
export interface DocxStructureRow { index: number; cells: DocxStructureCell[] }
export interface DocxStructureTable extends DocxStructureSafety { index: number; rows: DocxStructureRow[] }
export interface DocxStructureHeader extends DocxStructureSafety { part: string; paragraphs: string[] }
export interface DocxStructureSnapshot {
  schemaVersion: 1;
  projectId: string;
  path: string;
  hash: string;
  tables: DocxStructureTable[];
  /** Includes existing word/headerN.xml and word/footerN.xml parts. */
  headers: DocxStructureHeader[];
}
export type DocxStructureAction =
  | { kind: 'cell'; tableIndex: number; rowIndex: number; cellIndex: number; paragraphs: string[] }
  | { kind: 'appendRow'; tableIndex: number }
  | { kind: 'removeRow'; tableIndex: number; rowIndex: number }
  | { kind: 'header'; part: string; paragraphs: string[] };
export interface DocxStructureEditResult { projectId: string; sourcePath: string; sourceHash: string; path: string; changed: number }
