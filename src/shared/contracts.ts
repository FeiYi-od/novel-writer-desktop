import type { MaterialSyncRequest, MaterialSyncSnapshot } from './material-sync';

export interface RichNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: { type: string }[];
  content?: RichNode[];
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  root: string;
}

export interface Chapter { path: string; name: string }
export interface ChapterOrderSnapshot { value: { schemaVersion: 1; projectId: string; paths: string[] }; hash: string; entries: (Chapter & { present: boolean })[] }
export interface Manuscript {
  projectId: string;
  path: string;
  hash: string;
  content: RichNode | string;
  managed: boolean;
  warnings: string[];
}

export type NoteKind = 'characters' | 'world' | 'preset' | 'style';
export interface ProjectNotes {
  schemaVersion: 1;
  projectId: string;
  characters: string;
  world: string;
  preset: string;
  style: string;
}
export interface NotesSnapshot { value: ProjectNotes; hash: string }

export interface RenameChapterRequest { projectId: string; path: string; expectedHash: string; name: string }

export interface ChapterConfirmationEntry { id: string; projectId: string; sourcePath: string; sourceHash: string; confirmedAt: string; enabled: boolean }
export interface ChapterConfirmationSnapshot { value: { schemaVersion: 1; projectId: string; entries: ChapterConfirmationEntry[] }; hash: string; staleIds: string[] }
export interface ChapterConfirmationPreview { projectId: string; path: string; hash: string; text: string; characters: number; paragraphCount: number; warnings: string[] }
export interface ConfirmChapterVersionRequest { projectId: string; path: string; sourceHash: string; expectedHash: string }

export interface SaveRequest {
  projectId: string;
  path: string;
  expectedHash: string;
  content: RichNode;
}

export interface ModelDiscoveryRequest {
  /** Ignore the cached list and ask the provider again. */
  refresh?: boolean; connectionId?: string; expectedHash: string; baseUrl: string; apiKey?: string; clearKey?: boolean; adapter?: AIConnection['adapter'] }
export interface AIModelList { connectionId?: string; baseUrl: string; checkedAt: string; cached?: boolean; models: { id: string; name: string; contextWindow?: number; maxOutputTokens?: number }[] }

export interface DiscussionMessageView { id: string; role: 'user' | 'assistant' | 'system'; content: string; at: string; compressedInto?: string }

export interface WriterApi {
  materialSyncStatus(projectId: string, remoteRevision?: string): Promise<MaterialSyncSnapshot>;
  configureMaterialSync(projectId: string, enabled: boolean): Promise<MaterialSyncSnapshot>;
  synchronizeMaterials(request: MaterialSyncRequest): Promise<MaterialSyncSnapshot>;
  chapterConfirmations(projectId: string): Promise<ChapterConfirmationSnapshot>;
  previewChapterConfirmation(projectId: string, path: string): Promise<ChapterConfirmationPreview>;
  confirmChapterVersion(request: ConfirmChapterVersionRequest): Promise<ChapterConfirmationSnapshot>;
  disableChapterConfirmation(projectId: string, entryId: string, expectedHash: string): Promise<ChapterConfirmationSnapshot>;
  knowledgeSources(projectId: string, corpus: KnowledgeSearchRequest['corpus']): Promise<KnowledgeSourceCatalog>;
  knowledgeIndexStatus(projectId: string, corpus: KnowledgeSearchRequest['corpus'], connectionId?: string, dimensions?: number): Promise<KnowledgeIndexStatus>;
  rebuildKnowledgeIndex(projectId: string, corpus: KnowledgeSearchRequest['corpus'], connectionId: string, dimensions: number): Promise<KnowledgeIndexRebuildResult>;
  cancelKnowledgeIndex(projectId: string): Promise<void>;
  saveUiDraft(projectId: string, page: UiDraftPage, values: Record<string, string>): Promise<UiDraft>;
  readUiDraft(projectId: string, page: UiDraftPage): Promise<UiDraft | null>;
  clearUiDraft(projectId: string, page: UiDraftPage): Promise<void>;
  /** Reports sync-tool conflict copies next to chapter files. Never renames, merges or deletes. */
  listSyncConflicts(projectId: string): Promise<{ path: string; baseName: string; kind: 'conflict-copy' | 'sync-conflict' | 'numbered-copy' }[]>;
  /** Watches the book folder so external edits can be announced; returns once the watch is active. */
  watchChapterFiles(projectId: string): Promise<void>;
  onExternalChapterChange(listener: (payload: { projectId: string; paths: string[] }) => void): () => void;
  searchKnowledge(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>;
  cancelKnowledge(projectId: string, requestId: string): Promise<void>;
  testRerankModel(id: string, expectedHash: string, requestId: string): Promise<RerankTestResult>;
  cancelRerankTest(requestId: string): Promise<void>;
  testEmbeddingModel(id: string, expectedHash: string, requestId: string): Promise<EmbeddingTestResult>;
  cancelEmbeddingTest(requestId: string): Promise<void>;
  auxiliaryModels(): Promise<AuxiliaryModelSnapshot>;
  saveAuxiliaryModel(edit: AuxiliaryModelEdit, expectedHash: string): Promise<AuxiliaryModelSnapshot>;
  beginSaveExit(): Promise<string>;
  cancelSaveExit(token: string): Promise<void>;
  finishSaveExit(token: string): Promise<void>;
  discoverAIModels(request: ModelDiscoveryRequest): Promise<AIModelList>;
  checkpointDraft(request: DraftRequest): Promise<void>;
  completeDraft(projectId: string, id: string, revision: number): Promise<void>;
  prunePreviousVersions(projectId: string, dryRun: boolean): Promise<{ total: number; pruned: number; kept: number; ids: string[] }>;
  previousVersions(projectId: string): Promise<{ id: string; fileName: string; kind: 'docx' | 'txt'; bytes: number; at: string; sourcePath: string }[]>;
  readPreviousVersion(projectId: string, versionId: string): Promise<{ id: string; text: string; warnings: string[] }>;
  restorePreviousVersion(projectId: string, versionId: string): Promise<{ path: string }>;
  rawRecoveryDrafts(projectId: string): Promise<{ id: string; fileName: string; kind: 'docx' | 'txt'; bytes: number; at: string; sourcePath: string }[]>;
  readRawRecoveryDraft(projectId: string, draftId: string): Promise<{ id: string; text: string; warnings: string[] }>;
  restoreRawRecoveryDraft(projectId: string, draftId: string): Promise<{ path: string }>;
  pruneRawRecoveryDrafts(projectId: string, dryRun: boolean): Promise<{ total: number; pruned: number; kept: number; ids: string[] }>;
  recoveryDrafts(projectId: string): Promise<RecoveryEntry[]>;
  readRecoveryDraft(projectId: string, id: string): Promise<RecoveryDraft>;
  restoreDraft(projectId: string, id: string): Promise<Manuscript>;
  readMemories(projectId: string): Promise<StoryMemorySnapshot>;
  startSummary(request: SummaryRequest): Promise<AITask>;
  startSummaryBatch(request: SummaryBatchRequest): Promise<AITask>;
  summaryBatch(projectId: string): Promise<SummaryBatchState | null>;
  cancelSummaryBatch(projectId: string): Promise<void>;
  confirmSummary(projectId: string, taskId: string, content: string, expectedHash: string): Promise<StoryMemorySnapshot>;
  updateMemory(projectId: string, entryId: string, enabled: boolean, important: boolean, expectedHash: string): Promise<StoryMemorySnapshot>;
  saveStoryFact(projectId: string, edit: StoryFactEdit, expectedHash: string): Promise<StoryMemorySnapshot>;
  removeStoryFact(projectId: string, factId: string, expectedHash: string): Promise<StoryMemorySnapshot>;
  readPlanning(projectId: string): Promise<PlanningSnapshot>;
  savePlanning(projectId: string, value: PlanningData, expectedHash: string): Promise<PlanningSnapshot>;
  startPlanningAI(request: PlanningAIRequest): Promise<AITask>;
  acceptPlanning(projectId: string, kind: PlanningKind, expectedHash: string, targetHash: string): Promise<void>;
  materialLocation(projectId: string): Promise<string>;
  importMaterialText(projectId: string): Promise<{ projectId: string; name: string; text: string } | null>;
  startMaterialAI(request: MaterialAIRequest): Promise<AITask>;
  saveMaterial(projectId: string, kind: 'character' | 'world', markdown: string, expectedHash: string): Promise<void>;
  detectorConnections(): Promise<AIConnectionSnapshot>;
  saveDetectorConnection(edit: AIConnectionEdit, expectedHash: string): Promise<AIConnectionSnapshot>;
  detectorUsage(connectionId: string): Promise<DetectionUsageSnapshot>;
  saveDetectorQuota(request: DetectionQuotaRequest): Promise<DetectionUsageSnapshot>;
  testDetectorConnection(connectionId: string): Promise<DetectionConnectionTest>;
  detectText(projectId: string, chapterPath: string, sourceHash: string, connectionId: string): Promise<DetectionReport>;
  detectionReports(projectId: string): Promise<DetectionReport[]>;
  detectBatch(projectId: string, request: DetectionBatchRequest): Promise<DetectionBatchState>;
  detectionBatch(projectId: string): Promise<DetectionBatchState | null>;
  cancelDetectionBatch(projectId: string): Promise<void>;
  aiConnections(): Promise<AIConnectionSnapshot>;
  saveAIConnection(edit: AIConnectionEdit, expectedHash: string): Promise<AIConnectionSnapshot>;
  testAIConnection(id: string): Promise<string>;
  startAI(request: AIRequest): Promise<AITask>;
  startReviewBatch(request: ReviewBatchRequest): Promise<AITask>;
  aiTasks(projectId: string): Promise<AITask[]>;
  cancelAI(projectId: string, taskId: string): Promise<void>;
  exportAI(projectId: string, taskId: string): Promise<Manuscript>;
  exportReviewEdits(projectId: string, taskId: string, issueIds: string[], guard?: ReviewExportGuard): Promise<Manuscript>;
  reviewDecisions(projectId: string, taskId: string): Promise<ReviewDecisionSnapshot>;
  setReviewDecision(request: ReviewDecisionRequest): Promise<ReviewDecisionSnapshot>;
  readCharacters(projectId: string): Promise<CharacterSnapshot>;
  previewCharacter(projectId: string, kind: 'image' | 'text'): Promise<CharacterPreview | null>;
  chooseCharacterPortrait(projectId: string): Promise<{ token: string; image: string } | null>;
  saveCharacter(projectId: string, edit: CharacterEdit, expectedHash: string): Promise<CharacterSnapshot>;
  releaseCharacterImport(projectId: string, token: string): Promise<void>;
  readBook(projectId: string): Promise<BookSnapshot>;
  saveBook(projectId: string, value: BookDetails, expectedHash: string): Promise<BookSnapshot>;
  importCover(projectId: string): Promise<{ asset: string; dataUrl: string } | null>;
  importStyleSources(projectId: string, expectedHash: string): Promise<BookSnapshot | null>;
  analyzeStyle(projectId: string, name: string, sourceIds: string[], expectedHash: string): Promise<BookSnapshot>;
  startStyleLearning(request: StyleLearningRequest): Promise<AITask>;
  confirmStyleLearning(projectId: string, taskId: string, name: string, rules: string, expectedHash: string): Promise<BookSnapshot>;
  copyText(text: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  openProject(): Promise<Project | null>;
  chapters(projectId: string): Promise<Chapter[]>;
  chapterOrder(projectId: string): Promise<ChapterOrderSnapshot>;
  saveChapterOrder(projectId: string, paths: string[], expectedHash: string): Promise<ChapterOrderSnapshot>;
  createChapter(projectId: string, format?: 'docx' | 'txt'): Promise<Manuscript>;
  readChapter(projectId: string, path: string): Promise<Manuscript>;
  renameChapter(request: RenameChapterRequest): Promise<Manuscript>;
  /** Moves a chapter into another folder of this novel; refusals never touch the file. */
  moveChapter(request: { projectId: string; path: string; expectedHash: string; folder: string }): Promise<string>;
  previewBookReplace(request: { projectId: string; query: string; replacement: string; caseSensitive?: boolean }): Promise<ReplaceOutcome>;
  /** Read-only capability report for a DOCX chapter: what will and will not survive editing. */
  docxCapabilities(projectId: string, path: string): Promise<{ features: { feature: string; count: number; preserved: boolean; note: string }[]; preservedText: boolean; risks: string[] }>;
  readTimeline(projectId: string): Promise<TimelineSnapshotView>;
  saveTimeline(projectId: string, entries: TimelineEntryView[], expectedHash: string): Promise<TimelineSnapshotView>;
  readRelations(projectId: string): Promise<RelationSnapshotView>;
  saveRelations(projectId: string, relations: RelationView[], expectedHash: string): Promise<RelationSnapshotView>;
  readCharacterStates(projectId: string): Promise<CharacterStateSnapshotView>;
  saveCharacterStates(projectId: string, states: CharacterStateView[], expectedHash: string): Promise<CharacterStateSnapshotView>;
  readPrompts(projectId: string): Promise<PromptSnapshotView>;
  savePrompts(projectId: string, templates: PromptTemplateView[], expectedHash: string): Promise<PromptSnapshotView>;
  readBlueprints(projectId: string): Promise<BlueprintSnapshotView>;
  saveBlueprints(projectId: string, nodes: BlueprintNodeView[], expectedHash: string): Promise<BlueprintSnapshotView>;
  /** Writes the same brief once per style (sequential) and returns objective comparison metrics. */
  compareStyles(request: { projectId: string; connectionId: string; brief: string; styleIds: string[] }): Promise<StyleTrialView>;
  readStyleHistory(projectId: string): Promise<StyleHistorySnapshotView>;
  syncStyleHistory(projectId: string): Promise<StyleHistorySnapshotView>;
  readMacroScripts(projectId: string): Promise<{ findRegex: string; replaceString: string; disabled?: boolean; flags?: string; trimStrings?: string[] }[]>;
  previewMacros(projectId: string, text: string, context: { characterName?: string; userName?: string; lastMessage?: string }): Promise<{ expanded: string; applied: string; scripts: number }>;
  importMacroScripts(projectId: string): Promise<{ count: number } | null>;
  listWorldBooks(projectId: string): Promise<{ name: string; entries: number; keys: number; error?: string }[]>;
  importWorldBook(projectId: string): Promise<{ name: string; entries: number } | null>;
  removeWorldBook(projectId: string, name: string): Promise<boolean>;
  previewWorldInfo(projectId: string, names: string[], text: string, characterNames?: string[]): Promise<{ id: string; book: string; keys: string[]; secondaryKeys: string[]; content: string; comment: string; selective: boolean; selectiveLogic: 'AND_ANY' | 'NOT_ALL' | 'NOT_ANY' | 'AND_ALL'; constant: boolean; disabled: boolean; order: number; position: 'before_char' | 'after_char' | 'at_depth'; depth: number | null; probability: number; caseSensitive: boolean }[]>;
  exportCharacterCard(projectId: string, cardId: string): Promise<{ relative: string; bytes: number; specVersion: number; name: string }>;
  removeCharacterCard(projectId: string, cardId: string, expectedHash: string): Promise<{ snapshot: CharacterSnapshot; backup: string; removed: string }>;
  mergeCharacterCards(projectId: string, keepId: string, dropId: string, expectedHash: string): Promise<{ snapshot: CharacterSnapshot; backup: string; mergedInto: string; dropped: string }>;
  exportBookZip(projectId: string): Promise<{ file: string; files: number; bytes: number } | null>;
  exportChapterText(projectId: string, chapterPath: string, format: 'txt' | 'md'): Promise<{ file: string; characters: number; paragraphs: number; format: 'txt' | 'md' } | null>;
  bookProgress(projectId: string): Promise<{ chapters: { path: string; characters: number; paragraphs: number; updatedAt: string }[]; totalCharacters: number; totalParagraphs: number; stale: string[]; longest: { path: string; characters: number } | null; shortest: { path: string; characters: number } | null }>;
  bookHealth(projectId: string): Promise<{ ok: boolean; checked: number; issues: { level: 'warn' | 'error'; code: string; message: string; path?: string }[] }>;
  drillHistory(): Promise<{ at: string; ok: boolean; steps: { name: string; ok: boolean; detail: string }[] }[]>;
  runOfflineDrill(): Promise<{ ok: boolean; at: string; steps: { name: string; ok: boolean; detail: string }[] }>;
  probeNas(targets: { host: string; port: number; label?: string }[]): Promise<{ host: string; port: number; label?: string; ok: boolean; ms: number; reason?: string }[]>;
  restoreBackupFrom(): Promise<{ folder: string; files: number; bytes: number } | null>;
  backupBookTo(projectId: string): Promise<{ folder: string; files: number; bytes: number; verified: boolean; checked: number } | null>;
  verifyBackupAt(folder: string): Promise<{ ok: boolean; checked: number; mismatch: string[]; missing: string[] }>;
  nasLocation(target: string): Promise<'local' | 'unc' | 'network' | 'unknown'>;
  keyStatus(): Promise<{ file: string; backup: string; connections: { id: string; name: string; state: 'ok' | 'missing' | 'unreadable' }[]; backupUsable: boolean }>;
  recoverKeys(): Promise<AIConnectionSnapshot>;
  docxImages(projectId: string, chapterPath: string): Promise<{ name: string; bytes: number }[]>;
  replaceDocxImage(projectId: string, chapterPath: string, mediaName: string, expectedHash: string): Promise<{ path: string; name: string } | null>;
  docxInsight(projectId: string, chapterPath: string): Promise<{ tables: { index: number; rows: number; cellsPerRow: number[]; preview: string }[]; headers: string[] }>;
  editDocxStructure(projectId: string, chapterPath: string, action: { kind: 'appendRow' | 'removeRow' | 'header'; tableIndex?: number; rowIndex?: number; part?: string; paragraphs?: string[] }, expectedHash: string): Promise<{ changed: number; path: string }>;
  saveFidelityCopy(projectId: string, chapterPath: string, paragraphs: string[], expectedHash: string): Promise<{ path: string; paragraphs: number; changed: number }>;
  readFidelitySource(projectId: string, chapterPath: string, expectedHash: string): Promise<{ projectId: string; path: string; hash: string; paragraphs: string[] }>;
  readDiscussion(projectId: string): Promise<{ messages: DiscussionMessageView[]; hash: string; updatedAt: string }>;
  askDiscussion(projectId: string, input: { text: string; connectionId: string }): Promise<{ snapshot: { messages: DiscussionMessageView[]; hash: string }; compressed: number; finish: string }>;
  expandDiscussion(projectId: string, summaryId: string): Promise<DiscussionMessageView[]>;
  readUsage(): Promise<{ connectionId: string; connectionName: string; model: string; prompt: number; completion: number; calls: number; updatedAt: string }[]>;
  ensureStyleHistory(projectId: string, expectedHash: string, styleId: string, rules: string): Promise<StyleHistorySnapshotView>;
  reviseStyleRules(projectId: string, expectedHash: string, styleId: string, rules: string): Promise<StyleHistorySnapshotView>;
  restoreStyleVersion(projectId: string, expectedHash: string, styleId: string, version: number): Promise<StyleHistorySnapshotView>;
  recordStyleEffect(projectId: string, expectedHash: string, styleId: string, effect: { source: 'trial' | 'chapter'; characters: number; averageSentence: number; dialogueRatio: number; note?: string }): Promise<StyleHistorySnapshotView>;
  runBookReplace(request: { projectId: string; query: string; replacement: string; caseSensitive?: boolean }): Promise<ReplaceOutcome>;
  undoBookReplace(projectId: string, batchId: string): Promise<{ restored: string[]; skipped: { path: string; reason: string }[] }>;
  saveChapter(request: SaveRequest): Promise<Manuscript>;
  copyChapter(projectId: string, content: RichNode, format?: 'docx' | 'txt'): Promise<Manuscript>;
  readNotes(projectId: string): Promise<NotesSnapshot>;
  saveNotes(projectId: string, notes: ProjectNotes, expectedHash: string): Promise<NotesSnapshot>;
}

export const EMPTY_DOCUMENT: RichNode = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '　　' }] }] };
export interface DraftRequest extends SaveRequest { id: string; revision: number }
export interface RecoveryEntry { schemaVersion: 1; id: string; projectId: string; sourcePath: string; sourceHash: string; revision: number; updatedAt: string; status: 'pending' | 'saved'; characters: number }
export interface RecoveryDraft extends RecoveryEntry { content: RichNode }

export interface Volume { id: string; title: string; introduction: string; cover: string; chapters: string[] }
export interface StyleSource { id: string; name: string; characters: number; format?: 'docx' | 'txt' }
export interface LearnedStyle {
  id: string; name: string; rules: string; sourceIds: string[]; createdAt: string;
  method: 'local-statistics-v1' | 'model-analysis-v1';
  analysis?: { taskId: string; model: string; sourceHashes: Record<string, string>; sampled: boolean; sampleCharacters: number; totalCharacters: number };
  metrics: { characters: number; paragraphs: number; meanSentenceLength: number; meanParagraphLength: number; dialogueRatio: number; firstPersonPerThousand: number };
}
export interface BookDetails {
  schemaVersion: 1; projectId: string; title: string; introduction: string; cover: string;
  volumes: Volume[]; sources: StyleSource[]; styles: LearnedStyle[]; activeStyleId: string;
}
export interface BookSnapshot { value: BookDetails; hash: string; covers: Record<string, string> }

export interface CharacterFields {
  name: string; description: string; personality: string; scenario: string;
  firstMessage: string; examples: string; creatorNotes: string; systemPrompt: string;
  postHistoryInstructions: string; alternateGreetings: string[];
}
export interface CharacterCard extends CharacterFields {
  id: string; projectId: string; enabled: boolean; portrait: string;
  source: { name: string; format: string; original: string };
  raw: Record<string, unknown> | null; warnings: string[];
}
export interface CharacterSnapshot {
  value: { schemaVersion: 1; projectId: string; cards: CharacterCard[] };
  hash: string; portraits: Record<string, string>;
}
export interface CharacterPreview {
  projectId: string; token: string; fields: CharacterFields; image: string;
  format: string; sourceName: string; warnings: string[]; loreEntries: number;
}
export interface CharacterEdit {
  id?: string; fields: CharacterFields; enabled: boolean;
  importToken?: string; portraitToken?: string; removePortrait?: boolean;
}

export interface AIConnection {
  id: string; name: string; baseUrl: string; model: string;
  adapter: 'generic' | 'deepseek' | 'qwen' | 'gemini' | 'anthropic' | 'responses' | 'ollama'; thinking: 'default' | 'enabled' | 'disabled'; timeoutSeconds: number;
  contextWindow: number; maxOutputTokens: number;
  keyState?: 'ok' | 'missing' | 'unreadable'; tokenParameter: 'max_tokens' | 'max_completion_tokens'; hasKey: boolean;
}
export interface AIConnectionEdit extends Omit<AIConnection, 'id' | 'hasKey'> {
  id?: string; apiKey?: string; clearKey?: boolean;
}
export interface AIConnectionSnapshot { connections: AIConnection[]; hash: string }
export interface AuxiliaryModelConnection { id: string; kind: 'embedding' | 'rerank'; name: string; type: string; parameters: Record<string, string | number | boolean>; hasKey: boolean }
export interface AuxiliaryModelEdit extends Omit<AuxiliaryModelConnection, 'id' | 'hasKey'> { id?: string; apiKey?: string; clearKey?: boolean }
export interface AuxiliaryModelSnapshot { connections: AuxiliaryModelConnection[]; hash: string }
export type UiDraftPage = 'planning' | 'materials' | 'characters' | 'summary' | 'style';
export interface ReplaceChapterResult { path: string; count: number; status: 'replaced' | 'unchanged' | 'skipped'; message?: string }
export interface ReplaceOutcome { chapters: ReplaceChapterResult[]; total: number; replacedFiles: number; batchId?: string }
export interface TimelineEntryView { id: string; when: string; title: string; note: string; chapterPath?: string }
export interface TimelineSnapshotView { entries: TimelineEntryView[]; updatedAt: string; hash: string }
export interface RelationView { id: string; from: string; to: string; label: string; note: string; mutual: boolean; strength: number }
export interface RelationSnapshotView { relations: RelationView[]; groups: { name: string; items: { relation: RelationView; other: string; outgoing: boolean }[] }[]; updatedAt: string; hash: string }
export interface CharacterStateView { id: string; character: string; label: string; note: string; fromChapter?: number; toChapter?: number }
export interface CharacterStateSnapshotView { states: CharacterStateView[]; updatedAt: string; hash: string }
export interface PromptVersionView { version: number; body: string; savedAt: string }
export interface PromptTemplateView { id: string; name: string; kind: 'write' | 'review' | 'planning' | 'other'; body: string; version: number; updatedAt: string; versions: PromptVersionView[] }
export interface PromptSnapshotView { templates: PromptTemplateView[]; updatedAt: string; hash: string }
export interface BlueprintNodeView { id: string; scope: 'volume' | 'chapter'; ref: string; title: string; goals: string; beats: string[]; sourceHash?: string; updatedAt: string }
export interface BlueprintSnapshotView { nodes: BlueprintNodeView[]; updatedAt: string; hash: string; stale: { ref: string; title: string }[] }
export interface StyleTrialVariantView { styleId: string; styleName: string; text: string; error?: string }
export interface StyleHistoryEntryView {
  styleId: string; current: { version: number; rules: string; savedAt: string };
  history: { version: number; rules: string; savedAt: string }[];
  effects: { at: string; source: 'trial' | 'chapter'; characters: number; averageSentence: number; dialogueRatio: number; note?: string }[];
}
export interface StyleHistorySnapshotView { entries: StyleHistoryEntryView[]; updatedAt: string; hash: string }
export interface StyleTrialView {  variants: StyleTrialVariantView[]; failures: number;
  comparison: {
    rows: { styleId: string; styleName: string; chars: number; sentences: number; paragraphs: number; averageSentence: number; dialogueRatio: number; overlapWithOthers: number }[];
    mostDistinct: string | null; mostSimilar: [string, string] | null;
  };
}
export interface UiDraft { page: UiDraftPage; values: Record<string, string>; updatedAt: string }
export interface EmbeddingTestResult { connectionId: string; requestId: string; projectId: string; dimensions: number; configuredDimensions: number; dimensionMatches: boolean; inputCount: number; elapsedMs: number }
export interface RerankTestResult { connectionId: string; requestId: string; projectId: string; candidateCount: number; results: { index: number; score: number }[]; elapsedMs: number }
export interface KnowledgeIndexStatus {
  projectId: string; corpus: 'discussion' | 'canon' | 'style-reference';
  exists: boolean; entries: number; dimensions: number; updatedAt: string; warnings: string[];
}
export interface KnowledgeIndexRebuildResult {
  fingerprint: string; warnings: string[];
  stats: { embedded: number; reused: number; removed: number; sources: number; dimensions: number };
}
export interface KnowledgeSearchRequest { projectId: string; requestId: string; corpus: 'discussion' | 'canon' | 'style-reference'; query: string; topK: number; sourcePaths?: string[]; catalogHash?: string; mode?: 'keyword' | 'semantic' | 'hybrid'; rerank?: { connectionId: string } }
export interface KnowledgeSourceCatalog {
  projectId: string; corpus: KnowledgeSearchRequest['corpus']; hash: string;
  sources: { sourcePath: string; label: string; kind: KnowledgeSearchHit['sourceKind']; volumeIds: string[] }[];
  volumes: { id: string; title: string }[]; warnings: string[];
}
export interface KnowledgeSearchHit {
  id: string; projectId: string; corpus: 'discussion' | 'canon' | 'style-reference'; sourcePath: string; sourceHash: string; confirmed: boolean;
  sourceLabel: string; sourceKind: 'chapter' | 'world' | 'character' | 'outline' | 'reference';
  startParagraph: number; endParagraph: number; text: string; score: number;
}
export interface KnowledgeSearchResult {
  projectId: string; requestId: string; corpus: 'discussion' | 'canon' | 'style-reference'; query: string;
  usedMode: 'keyword' | 'semantic' | 'hybrid'; hits: KnowledgeSearchHit[]; sourceCount: number; chunkCount: number; warnings: string[];
}
export interface KnowledgeCitationReference { id: string; projectId: string; corpus: 'canon'; sourcePath: string; sourceHash: string; startParagraph: number; endParagraph: number }
export interface KnowledgeCitationBundle { projectId: string; references: KnowledgeCitationReference[]; hits: KnowledgeSearchHit[]; fingerprint: string; context: string }
export interface AIRequest {
  projectId: string; connectionId: string; mode: 'write' | 'review' | 'revise';
  chapterPath: string; sourceHash: string; instruction: string; reviewTaskId?: string;
  reviewFormat?: 'text' | 'issues'; autoReviewConnectionId?: string;
  /** Ordered, unique automatic reviewers (1–3); mutually exclusive with the legacy singular field. */
  autoReviewConnectionIds?: string[];
  /** Optional automatic canon retrieval before the request; explicit citations take precedence. */
  autoRetrieval?: { mode?: 'keyword' | 'hybrid'; topK?: number };
  /** Author-selected report issues for mode "revise"; ids come from that report, never from another. */
  issueIds?: string[];
  knowledgeCitations?: KnowledgeCitationReference[];
}
export interface AIAutoReview {
  connection: Omit<AIConnection, 'hasKey'>;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped' | 'interrupted';
  taskId?: string; error: string;
}
export type ReviewIssueStatus = 'pending' | 'accepted' | 'ignored' | 'false-positive' | 'applied';
export interface ReviewIssueDecision {
  issueId: string; status: ReviewIssueStatus; updatedAt: string;
  outputPath?: string; outputHash?: string;
}
export interface ReviewDecisionSnapshot {
  projectId: string; taskId: string; reportFingerprint: string; hash: string;
  stale: boolean; staleReason: string; items: ReviewIssueDecision[];
}
export interface ReviewDecisionRequest {
  projectId: string; taskId: string; reportFingerprint: string; expectedHash: string;
  issueId: string; status: Exclude<ReviewIssueStatus, 'applied'>;
}
export interface ReviewExportGuard { reportFingerprint: string; expectedHash: string }
export interface AITask {
  schemaVersion: 1; id: string; projectId: string; mode: 'write' | 'review' | 'revise' | 'character' | 'world' | 'plan-outline' | 'plan-world' | 'plan-character' | 'summary' | 'style-analysis';
  chapterPath: string; sourceHash: string; instruction: string; reviewTaskId?: string;
  /** Report issues this revision was asked to address; the candidate text is never auto-applied. */
  reviseIssueIds?: string[];
  connection: Omit<AIConnection, 'hasKey'>; createdAt: string;
  status: 'running' | 'complete' | 'incomplete' | 'cancelled' | 'failed' | 'interrupted';
  text: string; error: string; finishReason: string; contextHash: string;
  context: string; sourceText: string;
  reviewFormat?: 'text' | 'issues';
  /** Hash of the normalized managed document reviewed directly, excluding AI candidates. */
  reviewDocumentHash?: string;
  styleSource?: { name: string; sourceIds: string[]; sourceHashes: Record<string, string>; sampled: boolean; sampleCharacters: number; totalCharacters: number; metrics: LearnedStyle['metrics'] };
  autoReview?: AIAutoReview;
  /** Ordered independent review results; legacy tasks retain autoReview. */
  autoReviews?: AIAutoReview[];
  knowledgeCitations?: KnowledgeCitationReference[];
  citationFingerprint?: string;
  /** What automatic retrieval actually did for this task, including any honest degradation. */
  autoRetrieval?: { requested: string; used: string; hits: number; warning: string };
}
export interface StyleLearningRequest { projectId: string; connectionId: string; name: string; sourceIds: string[]; expectedHash: string }
export interface MaterialAIRequest { projectId: string; connectionId: string; kind: 'character' | 'world'; sourceName: string; sourceText: string }
export interface SummaryRequest { projectId: string; connectionId: string; chapterPath: string; sourceHash: string }
/** Batch summaries run one chapter at a time; each result still needs author confirmation. */
export interface SummaryBatchRequest { projectId: string; connectionId: string; items: { path: string; hash?: string }[] }
export interface SummaryBatchState {
  projectId: string; connectionId: string; startedAt: string; finishedAt?: string;
  running: boolean; total: number; completed: number; created: number; current: string;
  failures: { path: string; message: string }[];
}
export interface StoryMemoryEntry { id: string; projectId: string; sourcePath: string; sourceHash: string; content: string; taskId: string; model: string; createdAt: string; enabled: boolean; important: boolean }
export interface StoryFact {
  id: string; projectId: string; kind: 'fact' | 'foreshadow'; text: string;
  sourcePath?: string; sourceHash?: string; state: 'open' | 'resolved';
  enabled: boolean; createdAt: string;
}
export interface StoryMemorySnapshot { value: { schemaVersion: 1; projectId: string; budgetBytes: number; entries: StoryMemoryEntry[]; facts: StoryFact[] }; hash: string; staleIds: string[] }
export interface StoryFactEdit { id?: string; kind: 'fact' | 'foreshadow'; text: string; sourcePath?: string; sourceHash?: string; state?: 'open' | 'resolved'; enabled?: boolean }
export type PlanningKind = 'outline' | 'world' | 'character';
export interface PlanningData {
  schemaVersion: 1; projectId: string;
  prompts: Record<PlanningKind, string>; briefs: Record<PlanningKind, string>;
  drafts: Record<PlanningKind, string>; originTasks: Record<PlanningKind, string>;
  outline: string;
}
export interface PlanningSnapshot { value: PlanningData; hash: string }
export interface PlanningAIRequest { projectId: string; connectionId: string; kind: PlanningKind; expectedHash: string }
/** Explicit connection IDs for any batch start; 1–3 unique, order preserved. */
export interface ReviewBatchRequest {
  projectId: string; chapterPath: string; sourceHash: string; connectionIds: string[];
  reviewTaskId?: string; reviewFormat: 'text' | 'issues'; instruction: string;
  knowledgeCitations?: KnowledgeCitationReference[];
}
export interface DetectionReport {
  schemaVersion: 1; id: string; projectId: string; chapterPath: string; sourceHash: string;
  provider: 'zhuque-text'; createdAt: string; endpoint: string;
  humanRatio: number; aiRatio: number; suspectedRatio: number; confidence?: number;
  modelTokens?: number; makersTokens?: number; usageWarning?: string;
  segments: { text: string; label: number; confidence: number }[];
}
/** Device-local accounting. Makers tokens, not model usage, consume the free quota. */
export interface DetectionUsageSnapshot {
  connectionId: string; credentialFingerprint: string; hash: string; month: string;
  requests24h: number; errors24h: number; makersTokens24h: number; modelTokens24h: number; unknownUsage24h: number;
  localTokens: number; unknownUsageMonth: number; monthlyLimit: number;
  accountUsed: number | null; baselineLocalTokens: number | null; calibratedAt: string | null;
  estimatedUsed: number; remainingEstimate: number; usageLevel: 'normal' | 'near-limit' | 'exceeded';
  totalEvents: number; capacity: number;
}
export interface DetectionQuotaRequest {
  connectionId: string; credentialFingerprint: string; expectedHash: string; month: string;
  monthlyLimit: number; accountUsed?: number | null;
}
export interface DetectionConnectionTest {
  provider: 'zhuque-text'; checkedAt: string; endpoint: string;
  humanRatio: number; aiRatio: number; suspectedRatio: number; confidence?: number;
  modelTokens?: number; makersTokens?: number; usageWarning?: string;
  usage: DetectionUsageSnapshot;
}
/** Frozen request for a sequential batch. Provide a hash to pin a version; otherwise the
 * service freezes each chapter's current hash before the first billable request. */
export interface DetectionBatchRequest {
  connectionId: string; items: { path: string; hash?: string }[];
}
export interface DetectionBatchFailure { path: string; message: string }
export interface DetectionBatchState {
  projectId: string; connectionId: string; startedAt: string; finishedAt?: string;
  running: boolean; stopped: boolean;
  total: number; completed: number; created: number; current: string;
  failures: DetectionBatchFailure[];
}
