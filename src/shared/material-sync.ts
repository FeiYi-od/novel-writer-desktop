/** Per-book transport snapshots; credentials and app caches are never included. */
export interface MaterialSyncDifference {
  path: string;
  localHash: string | null;
  remoteHash: string | null;
  localBytes: number;
  remoteBytes: number;
  action: 'push' | 'pull' | 'conflict';
  localPreview?: string;
  remotePreview?: string;
}
export interface MaterialSyncSnapshot {
  schemaVersion: 1;
  projectId: string;
  enabled: boolean;
  status: 'disabled' | 'clean' | 'pending' | 'conflicts' | 'blocked';
  fingerprint: string;
  selectedRemoteRevision: string | null;
  remoteRevisions: { id: string; createdAt: string; files: number; bytes: number }[];
  files: MaterialSyncDifference[];
  localFiles: number;
  remoteFiles: number;
  message: string;
  historyDirectory: string;
  lastSyncedAt?: string;
}
export interface MaterialSyncRequest {
  projectId: string;
  fingerprint?: string;
  remoteRevision?: string;
  resolutions?: { path: string; source: 'local' | 'remote' }[];
}

export type MaterialHistorySource = 'local' | 'transport';
export interface MaterialHistoryVersion {
  id: string;
  source: MaterialHistorySource;
  createdAt: string;
  /** Local archives have no manifest; counts are verified when opened. */
  files: number | null;
  bytes: number | null;
}
export interface MaterialHistorySnapshot {
  schemaVersion: 1;
  projectId: string;
  versions: MaterialHistoryVersion[];
}
export interface MaterialHistoryRequest {
  projectId: string;
  source: MaterialHistorySource;
  id: string;
  path?: string;
  /** Reopening a file may require the same verified history/current versions. */
  fingerprint?: string;
}
export interface MaterialHistoryFile {
  path: string;
  change: 'unchanged' | 'history-only' | 'current-only' | 'changed';
  currentHash: string | null;
  historyHash: string | null;
  currentBytes: number;
  historyBytes: number;
}
export interface MaterialHistoryPreview {
  schemaVersion: 1;
  projectId: string;
  source: MaterialHistorySource;
  id: string;
  fingerprint: string;
  files: MaterialHistoryFile[];
  detail?: {
    path: string;
    currentText?: string;
    historyText?: string;
    currentTruncated: boolean;
    historyTruncated: boolean;
  };
}
export interface MaterialHistoryCopyRequest {
  projectId: string;
  source: MaterialHistorySource;
  id: string;
  fingerprint: string;
}
export interface MaterialHistoryCopyResult {
  schemaVersion: 1;
  projectId: string;
  source: MaterialHistorySource;
  id: string;
  directory: string;
  files: number;
  bytes: number;
}
export interface MaterialHistoryArchiveResult extends MaterialHistoryCopyResult {
  file: string;
  archiveBytes: number;
  sha256: string;
}
