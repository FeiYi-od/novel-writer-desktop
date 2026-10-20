export interface MemoryEntry {
  id: string;
  projectId: string;
  kind: 'summary' | 'fact' | 'foreshadowing';
  sourcePath: string;
  sourceHash: string;
  content: string;
  status: 'proposed' | 'confirmed';
}
export interface StyleProfile {
  id: string;
  projectId: string;
  name: string;
  sourceLanguage: string;
  targetLanguage: string;
  rules: string[];
  sourceReferences: { path: string; hash: string }[];
}
export function validMemories(projectId: string, entries: MemoryEntry[], hashes: Record<string, string>) {
  return entries.filter(e => e.projectId === projectId && e.status === 'confirmed' && hashes[e.sourcePath] === e.sourceHash);
}
