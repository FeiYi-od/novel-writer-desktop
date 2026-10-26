export interface MacroContext { characterName?: string; userName?: string; lastMessage?: string }
export interface MacroPreviewResult {
  schemaVersion: 1;
  projectId: string;
  requestId: string;
  sourceHash: string;
  expanded: string;
  applied: string;
  scripts: number;
  notesPresent: boolean;
}
export interface MacroImportResult {
  schemaVersion: 1;
  projectId: string;
  count: number;
  format: 'single' | 'array' | 'scripts';
  unsupportedFields: string[];
  unsupportedFieldCount: number;
  sourceFile: string;
  sourceSha256: string;
}
