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
  /** 本机活动区或保留区；旧客户端不认识保留区。 */
  location?: 'active' | 'retained';
  createdAt: string;
  /** Local archives have no manifest; counts are verified when opened. */
  files: number | null;
  bytes: number | null;
}
export interface MaterialHistoryRetainRequest { projectId: string; id: string; fingerprint: string }
export interface MaterialHistoryRetainResult { schemaVersion: 1; projectId: string; id: string; location: 'retained'; files: number; bytes: number }
/** 回收保留区历史：只在作者两次确认后，删除保留区的那一份本机历史以释放磁盘。
 * 活动区、书内传输版本和完整ZIP归档都不受影响；被其他版本当作父版本的条目会被拒绝。 */
export interface MaterialHistoryReclaimRequest { projectId: string; id: string; fingerprint: string; confirm: '回收' }
/** 回收书内传输历史的一个叶子版本：只在作者确认后删除该版本目录以释放磁盘与名额。
 * 仍被其他版本当作父版本时拒绝，避免破坏父链与完整历史归档。 */
export interface MaterialHistoryTransportReclaimRequest { projectId: string; id: string; fingerprint: string; confirm: '回收' }export interface MaterialHistoryReclaimResult { schemaVersion: 1; projectId: string; id: string; files: number; bytes: number; reclaimedAt: string }
export interface MaterialHistorySnapshot {
  schemaVersion: 1;
  projectId: string;
  versions: MaterialHistoryVersion[];
}
export const MATERIAL_HISTORY_LIMIT = 1000;
export const MATERIAL_HISTORY_WARNING_AT = 800;
/** Root directory entries, including incomplete snapshots; not verified versions or disk usage. */
export interface MaterialHistoryCapacity {
  entries: number;
  exact: boolean;
  remaining: number;
  level: 'normal' | 'warning' | 'full' | 'over-limit';
}
export interface MaterialHistoryCapacitySnapshot {
  schemaVersion: 1;
  projectId: string;
  checkedAt: string;
  limit: number;
  warningAt: number;
  local: MaterialHistoryCapacity;
  transport: MaterialHistoryCapacity;
}
/** A verified, complete history set; no canonical content or synchronization state is included. */
export interface MaterialHistoryDagPreview {
  schemaVersion: 1;
  projectId: string;
  fingerprint: string;
  transportVersions: number;
  localArchives: number;
  branches: number;
  files: number;
  blobs: number;
  bytes: number;
}
export interface MaterialHistoryDagRequest { projectId: string; fingerprint: string }
export interface MaterialHistoryDagArchiveResult extends MaterialHistoryDagPreview {
  archiveId: string;
  directory: string;
  file: string;
  archiveBytes: number;
  sha256: string;
}
export interface MaterialHistoryDagImportRequest { projectId: string; token: string; fingerprint: string }
/** Main-process ticket authorizes one inspected archive, not an arbitrary renderer path. */
export interface MaterialHistoryDagImportPreview extends MaterialHistoryDagPreview {
  token: string;
  archiveId: string;
  name: string;
  archiveBytes: number;
  sha256: string;
  directories: number;
}
export interface MaterialHistoryDagImportResult extends MaterialHistoryDagImportPreview {
  copyId: string;
  directory: string;
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
/** Explicitly confirmed restore swaps only this project's local fixed materials. */
export interface MaterialHistoryRestoreResult {
  schemaVersion: 1;
  projectId: string;
  source: MaterialHistorySource;
  id: string;
  backupId: string | null;
  changed: boolean;
}
export interface MaterialHistoryArchiveResult extends MaterialHistoryCopyResult {
  file: string;
  archiveBytes: number;
  sha256: string;
}

/** Only the main process authorizes archive paths; the renderer receives an expiring ticket. */
export interface MaterialHistoryImportRequest {
  projectId: string;
  token: string;
  fingerprint: string;
  path?: string;
}
export interface MaterialHistoryImportCopyRequest {
  projectId: string;
  token: string;
  fingerprint: string;
}
export interface MaterialHistoryImportPreview extends MaterialHistoryPreview {
  token: string;
  name: string;
  archiveId: string;
  archiveBytes: number;
  sha256: string;
}
export interface MaterialHistoryImportResult extends MaterialHistoryCopyResult {
  archiveId: string;
  sha256: string;
}
