export interface SyncConflictCopy { path: string; baseName: string; kind: 'conflict-copy' | 'sync-conflict' | 'numbered-copy' }
const patterns: { kind: SyncConflictCopy['kind']; test: RegExp }[] = [
  // Windows/OneDrive style: 第一章 (冲突副本 2).docx / 第一章-冲突副本.docx
  { kind: 'conflict-copy', test: /[（(]\s*(?:冲突副本|conflicted copy)\s*\d*\s*[)）]/iu },
  // Syncthing / 坚果云 style: 第一章.sync-conflict-20261018-120000-ABCDEF.docx
  { kind: 'sync-conflict', test: /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+/iu },
  // Generic duplicate: 第一章 (2).docx 或 第一章 - 副本.docx
  { kind: 'numbered-copy', test: /[（(]\s*\d+\s*[)）]|[-—]\s*副本/u }
];
/** Synchronisation tools never merge DOCX; they leave a copy next to the original. This only
 * reports those copies so the author can decide. Nothing is renamed, merged or deleted. */
export function findSyncConflictCopies(paths: string[]): SyncConflictCopy[] {
  const found: SyncConflictCopy[] = [];
  for (const file of paths) {
    const name = file.split(/[\\/]/u).pop() ?? file;
    const stem = name.replace(/\.[^.]+$/u, '');
    for (const pattern of patterns) {
      if (!pattern.test.test(stem)) continue;
      found.push({ path: file, baseName: name, kind: pattern.kind });
      break;
    }
  }
  return found.sort((left, right) => left.baseName.localeCompare(right.baseName, 'zh-Hans-CN'));
}
