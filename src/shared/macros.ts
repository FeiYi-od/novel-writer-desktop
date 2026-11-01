/** Preview-only explicit inputs; nothing is stored or applied to AI requests. */
export interface MacroContext { characterName?: string; userName?: string; lastMessage?: string;
  nicknamePreviewEnabled?: boolean; useNicknameForMacros?: boolean; userNickname?: string; characterNickname?: string }
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
