import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, safeStorage } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import mammoth from 'mammoth';
import { LibraryStore } from './library';
import { CharacterStore } from './characters';
import { Workspace } from './workspace';
import { MaterialSyncService } from './material-sync';
import { OperationGate } from './operation-gate';
import { protectLegacyMaterials } from './material-upgrade';
import { ChapterOrderStore } from './chapter-order';
import { BookReplace } from './book-replace';
import { analyzeDocx } from './docx-capabilities';
import { TimelineStore } from './timeline';
import { RelationStore } from './relations';
import { CharacterStateStore } from './character-states';
import { PromptLibraryStore } from './prompt-library';
import { StyleHistoryStore } from './style-history';
import { UsageStore } from './usage-store';
import { CharacterLibrary } from './character-library';
import { WorldInfoStore } from './world-info';
import { isStorageHost, MAX_STORAGE_TARGETS } from '../core/storage-targets';
import { MacroStore } from './macros';
import { RegexPreviewRunner } from './regex-preview';
import createRegexWorker from './regex-preview-worker?nodeWorker';
import { setUsageSink } from './ai-provider';
import { createStyleTrial } from './style-trial-run';
import { BlueprintStore } from './blueprint';
import { AIConnections } from './ai-connections';
import { AuxiliaryModels } from './auxiliary-models';
import { EmbeddingService } from './embedding-service';
import { RerankService } from './rerank-service';
import { KnowledgeService } from './knowledge-service';
import { ChapterConfirmationStore } from './chapter-confirmation';
import { randomUUID } from 'node:crypto';
import { AIService } from './ai-service';
import { ModelDiscoveryService } from './model-discovery';
import { ModelCache } from './model-cache';
import { probeTargets } from './nas-probe';
import { detectPathLocation } from './drive-type';
import { backupBook, restoreBackup, verifyBackup } from './nas-backup';
import { DocxCopyService } from './docx-copy-service';
import { validateReplacementImage } from './image-limits';
import { runOfflineDrill } from './drill';
import { inspectKeys, restoreFromBackup } from './key-recovery';
import { listPreviousVersions, listRawDrafts, prunePreviousVersions, pruneRawDrafts, readPreviousVersion, readRawDraft, restorePreviousVersion, restoreRawDraft } from './recovery';
import { DiscussionStore } from './discussion';
import { streamChat } from './ai-provider';
import { readDrillHistory, saveDrillRecord } from './drill-history';
import { inspectBook } from './book-health';
import { exportBookZip } from './book-export';
import { collectChapterStats } from './chapter-stats';
import { exportChapterText } from './chapter-export';
import type { ModelDiscoveryRequest } from '../shared/contracts';
import { DetectionService } from './detection';
import { DetectionUsageStore } from './detection-usage';
import { VectorIndexStore } from './vector-index-store';
import { VectorService } from './vector-service';
import { KnowledgeIndexService } from './knowledge-index';
import { createEmbedder } from './embedding-embedder';
import { PlanningStore } from './planning';
import { StoryMemoryStore } from './story-memory';
import { UiDraftStore } from './ui-drafts';
import { runMigrations } from './migrations';
import { findSyncConflictCopies } from '../core/sync-conflicts';
import { RecoveryStore } from './recovery';
import { materialDirectory } from './markdown-materials';
import { ChapterWatcher } from './file-watcher';
import { decodeText } from './text-import';
import { parseMaterial } from '../core/material-conversion';
import type { BookDetails, CharacterEdit, ProjectNotes, RichNode, SaveRequest, RenameChapterRequest } from '../shared/contracts';

if (process.env.NOVEL_WRITER_TEST_DATA) app.setPath('userData', process.env.NOVEL_WRITER_TEST_DATA);
// Packaged apps hide stdout on Windows, so a startup failure is also written next to user data.
const startupLog = () => { try { return path.join(app.getPath('userData'), 'startup-error.log'); } catch { return null; } };
const recordStartupError = (kind: string, error: unknown) => {
  const text = `[${new Date().toISOString()}] ${kind}: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`;
  console.error(text);
  const file = startupLog(); if (!file) return;
  try { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, text, 'utf8'); } catch { /* logging must never mask the original failure */ }
};
process.on('uncaughtException', error => recordStartupError('uncaughtException', error));
process.on('unhandledRejection', error => recordStartupError('unhandledRejection', error));
let window: BrowserWindow | null = null;

async function bootstrap() {
  // Upgrade steps run before any store opens; each recorded step runs at most once.
  await runMigrations(app.getPath('userData'));
  // Keep author data outside the installation tree, which NSIS replaces on upgrade.
  const materialsRoot = path.join(app.getPath('userData'), '创作资料');
  if (!process.env.NOVEL_WRITER_TEST_DATA) {
    const sourceInstall = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../..');
    const script = app.isPackaged ? path.join(process.resourcesPath, 'protect-upgrade-materials.ps1') : path.join(sourceInstall, 'scripts/protect-upgrade-materials.ps1');
    await protectLegacyMaterials(sourceInstall, app.getPath('userData'), script, app.isPackaged ? process.pid : 0);
  }
  const workspace = new Workspace(app.getPath('userData'), materialsRoot);
  const materialSync = new MaterialSyncService(workspace, materialsRoot, app.getPath('userData'));
  const materialGate = new OperationGate();
  const docxCopies = new DocxCopyService(workspace);
  await workspace.initialize();
  const chapterOrder = new ChapterOrderStore(workspace);
  const bookReplace = new BookReplace(workspace, app.getPath('userData'));
  const timeline = new TimelineStore(workspace);
  const relations = new RelationStore(workspace);
  const characterStates = new CharacterStateStore(workspace);
  const prompts = new PromptLibraryStore(workspace);
  const blueprints = new BlueprintStore(workspace);
  const styleHistory = new StyleHistoryStore(workspace);
  const usage = new UsageStore(path.join(app.getPath('userData'), 'ai-usage.json'));
  setUsageSink(sample => void usage.record(sample));
  const recovery = new RecoveryStore(path.join(app.getPath('userData'), 'recovery-checkpoints'), workspace);
  const library = new LibraryStore(id => workspace.getProject(id), materialsRoot, (id, relative) => workspace.resolveChapterPath(id, relative));
  const characters = new CharacterStore(id => workspace.getProject(id), materialsRoot);
  const characterLibrary = new CharacterLibrary(characters);
  const discussion = new DiscussionStore(workspace);
  const worldInfo = new WorldInfoStore(workspace);
  const macros = new MacroStore(workspace, new RegexPreviewRunner(createRegexWorker), action => materialGate.shared(action));
  const keyCodec = {
    encrypt: (value: string) => { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，未保存密钥'); return safeStorage.encryptString(value); },
    decrypt: (value: Buffer) => safeStorage.decryptString(value)
  };
  const connections = new AIConnections(app.getPath('userData'), keyCodec);
  const auxiliaryModels = new AuxiliaryModels(app.getPath('userData'), {
    encrypt: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，未保存密钥'); return safeStorage.encryptString(value); },
    decrypt: value => safeStorage.decryptString(value)
  });
  const embeddings = new EmbeddingService(auxiliaryModels);
  const reranks = new RerankService(auxiliaryModels);
  let exitToken: string | null = null; let activeRequests = 0; let finishingExit = false;
  const planning = new PlanningStore(id => workspace.getProject(id), materialsRoot);
  const confirmations = new ChapterConfirmationStore(workspace, materialsRoot);
  const vectorIndexStore = new VectorIndexStore(app.getPath('userData'), workspace);
  const vectorService = new VectorService(vectorIndexStore);
  // The chunk provider needs the search service, and the search service needs this index, so the
  // provider resolves the service lazily instead of creating a construction cycle.
  let knowledgeHolder: KnowledgeService | null = null;
  const knowledgeIndex = new KnowledgeIndexService({ collectChunks: (id, corpus, signal) => {
    if (!knowledgeHolder) throw new Error('检索服务尚未就绪，请稍后重试');
    return knowledgeHolder.collectChunks(id, corpus, signal);
  } }, vectorIndexStore, vectorService, workspace);
  // Query-time port: nothing is embedded unless the author explicitly asks for semantic/hybrid.
  const knowledgeIndexPort = {
    async capability(projectId: string, corpus: 'canon' | 'discussion' | 'style-reference') {
      const active = await vectorIndexStore.readActive(projectId, corpus);
      if (!active) return { embedding: false, index: false, stale: false };
      const connections = (await auxiliaryModels.read()).connections.filter(connection => connection.kind === 'embedding');
      if (!connections.length) return { embedding: false, index: false, stale: false, fingerprint: active.fingerprint };
      const snapshot = await vectorIndexStore.read({ projectId, corpus, embeddingFingerprint: active.fingerprint });
      return { embedding: true, index: !!snapshot, stale: false, fingerprint: active.fingerprint };
    },
    async embedQuery(projectId: string, corpus: 'canon' | 'discussion' | 'style-reference', query: string, signal: AbortSignal) {
      const active = await vectorIndexStore.readActive(projectId, corpus);
      if (!active) return null;
      const snapshot = await auxiliaryModels.read();
      const connection = snapshot.connections.find(item => item.kind === 'embedding');
      if (!connection) return null;
      const { profile, key } = await auxiliaryModels.resolve(connection.id, snapshot.hash);
      const bundle = createEmbedder(profile, key, active.dimensions, projectId, corpus);
      const vectors = await bundle.embed('query', [{ id: 'query', text: query }], signal);
      return { vector: vectors[0].values, fingerprint: bundle.fingerprint };
    },
    async search(projectId: string, corpus: 'canon' | 'discussion' | 'style-reference', fingerprint: string, vector: number[], topK: number, signal: AbortSignal) {
      return knowledgeIndex.search(projectId, corpus, fingerprint, vector, topK, signal);
    }
  };
  const knowledge = new KnowledgeService(workspace, library, characters, planning, confirmations, knowledgeIndexPort,
    connectionId => ({ order: async (query: string, texts: string[], signal: AbortSignal) => {
      const snapshot = await auxiliaryModels.read();
      const result = await reranks.rank(connectionId, snapshot.hash, query, texts, signal);
      return { ranking: result.ranking };
    } }));
  knowledgeHolder = knowledge;
  const memory = new StoryMemoryStore(workspace, materialsRoot);
  const uiDrafts = new UiDraftStore(app.getPath('userData'), workspace);
  // Only one book is watched at a time; the watcher drops late events for a previous book.
  const chapterWatcher = new ChapterWatcher((projectId, paths) => {
    if (window && !window.isDestroyed()) window.webContents.send('chapters:external-change', { projectId, paths });
  });
  const ai = new AIService(app.getPath('userData'), connections, workspace, library, characters, planning, memory, knowledge, worldInfo);
  const modelCache = new ModelCache(path.join(app.getPath('userData'), 'model-cache.json'));
  const modelDiscovery = new ModelDiscoveryService(connections, 15000, modelCache);
  const detectorConnections = new AIConnections(path.join(app.getPath('userData'), 'detection'), {
    encrypt: value => { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用'); return safeStorage.encryptString(value); }, decrypt: value => safeStorage.decryptString(value)
  });
  const detector = new DetectionService(app.getPath('userData'), detectorConnections, workspace, new DetectionUsageStore(app.getPath('userData')));
  const portraitPng = (bytes: Buffer) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('无法识别角色图片');
    const { width, height } = image.getSize();
    if (width * height > 24000000) throw new Error('角色图片分辨率过大，请使用 2400 万像素以内图片');
    const scale = Math.min(1, 720 / Math.max(width, height));
    return image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toPNG();
  };
  const migrateBookRecords = async (id: string) => {
    // Include legacy name-based records in full-book exports even if their
    // individual panels have not been opened since this upgrade.
    const results = await Promise.allSettled([timeline.read(id), relations.read(id), characterStates.read(id), prompts.read(id), blueprints.read(id), styleHistory.read(id)]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  const handlers: Record<string, (...args: any[]) => unknown> = {
    'confirmation:read': projectId => confirmations.read(projectId),
    'confirmation:preview': (projectId, relative) => confirmations.preview(projectId, relative),
    'confirmation:confirm': request => confirmations.confirm(request),
    'confirmation:disable': (projectId, entryId, expectedHash) => confirmations.disable(projectId, entryId, expectedHash),
    'knowledge:search': request => knowledge.search(request),
    'knowledge:index-status': async (id: string, corpus: 'canon' | 'discussion' | 'style-reference', connectionId?: string, dimensions?: number) => {
      if (!connectionId || !dimensions) return knowledgeIndex.status(id, corpus);
      const snapshot = await auxiliaryModels.read();
      const { profile, key } = await auxiliaryModels.resolve(connectionId, snapshot.hash);
      const bundle = createEmbedder(profile, key, dimensions, id, corpus);
      return knowledgeIndex.status(id, corpus, bundle.fingerprint);
    },
    'knowledge:index-rebuild': async (id: string, corpus: 'canon' | 'discussion' | 'style-reference', connectionId: string, dimensions: number) => {
      const snapshot = await auxiliaryModels.read();
      const { profile, key } = await auxiliaryModels.resolve(connectionId, snapshot.hash);
      const bundle = createEmbedder(profile, key, dimensions, id, corpus);
      const result = await knowledgeIndex.rebuild({ projectId: id, corpus, fingerprint: bundle.fingerprint, dimensions, embed: bundle.embed });
      return { ...result, fingerprint: bundle.fingerprint };
    },
    'knowledge:cancel-index': (id: string) => knowledgeIndex.cancel(id),
    'drafts:save': (id: string, page: 'planning' | 'materials' | 'characters' | 'summary' | 'style', values: Record<string, string>) => uiDrafts.save(id, page, values),
    'drafts:read': (id: string, page: 'planning' | 'materials' | 'characters' | 'summary' | 'style') => uiDrafts.read(id, page),
    'drafts:clear': (id: string, page: 'planning' | 'materials' | 'characters' | 'summary' | 'style') => uiDrafts.clear(id, page),
    'chapters:conflicts': async (id: string) => {
      const chapters = await workspace.chapters(id);
      return findSyncConflictCopies(chapters.map(chapter => chapter.path));
    },
    'chapters:watch': async (id: string) => {
      const project = workspace.getProject(id);
      chapterWatcher.watchProject(id, project.root);
    },
    'knowledge:sources': (projectId, corpus) => knowledge.listSources(projectId, corpus),
    'knowledge:cancel': (projectId, requestId) => knowledge.cancel(projectId, requestId),
    'models:auxiliary': () => auxiliaryModels.read(),
    'models:test-embedding': (id, hash, requestId) => embeddings.test(id, hash, requestId),
    'models:cancel-embedding-test': id => embeddings.cancel(id),
    'models:test-rerank': (id, hash, requestId) => reranks.test(id, hash, requestId),
    'models:cancel-rerank-test': id => reranks.cancel(id),
    'models:save-auxiliary': (edit, hash) => auxiliaryModels.save(edit, hash),
    'app:begin-save-exit': () => {
      if (exitToken || activeRequests || materialGate.exclusivePending || ai.hasPendingWork()) throw new Error('模型任务或文件操作尚未完成，请等待或停止任务后再保存退出');
      exitToken = randomUUID(); return exitToken;
    },
    'app:cancel-save-exit': token => { if (token !== exitToken) throw new Error('无效退出会话'); exitToken = null; },
    'app:finish-save-exit': token => {
      if (!exitToken || token !== exitToken || activeRequests || materialGate.exclusivePending || ai.hasPendingWork()) throw new Error('退出会话无效或仍有处理中的任务，窗口保留');
      // Only an explicit renderer save transaction may bypass the unsaved prompt.
      finishingExit = true; setTimeout(() => window?.destroy(), 50);
    },
    'recovery:checkpoint': request => recovery.checkpoint(request),
    'recovery:complete': (id, draftId, revision) => recovery.complete(id, draftId, revision),
    'recovery:list': id => recovery.list(id),
    'recovery:read': (id, draftId) => recovery.read(id, draftId),
    'recovery:restore': async (id, draftId) => { const draft = await recovery.read(id, draftId); return workspace.createChapter(id, draft.content); },
    'memory:read': id => memory.read(id),
    'memory:generate': request => ai.startSummary(request),
    'memory:generate-batch': request => ai.startSummaryBatch(request),
    'memory:batch-state': (id: string) => ai.summaryBatch(id),
    'memory:cancel-batch': (id: string) => ai.cancelSummaryBatch(id),
    'memory:confirm': (id, taskId, content, hash) => ai.confirmSummary(id, taskId, content, hash),
    'memory:update': (id, entryId, enabled, important, hash) => memory.update(id, entryId, enabled, important, hash),
    'memory:save-fact': (id, edit, hash) => memory.saveFact(id, edit, hash),
    'memory:remove-fact': (id, factId, hash) => memory.removeFact(id, factId, hash),
    'planning:read': id => planning.read(id),
    'planning:save': async (id, value, hash) => {
      const current = await planning.read(id);
      if (value.outline !== current.value.outline) throw new Error('请通过确认采用按钮修改正式大纲');
      return planning.save(id, value, hash);
    },
    'planning:generate': request => ai.startPlanning(request),
    'planning:accept': async (id, kind, hash, targetHash) => {
      if (!['outline', 'world', 'character'].includes(kind)) throw new Error('无效筹备类型');
      const current = await planning.read(id);
      if (current.hash !== hash) throw new Error('筹备资料已更新，请重新读取后确认');
      if (current.value.originTasks[kind as keyof typeof current.value.originTasks]) await ai.assertPlanningCandidate(id, kind, current.value.originTasks[kind as keyof typeof current.value.originTasks]);
      if (kind === 'outline') { await planning.acceptOutline(id, hash); return; }
      const parsed = parseMaterial(kind, current.value.drafts[kind as 'world' | 'character']);
      if (typeof parsed === 'string') {
        const notes = await workspace.readNotes(id);
        if (notes.hash !== targetHash) throw new Error('世界观已更新，请重新读取保存基准');
        await workspace.saveNotes(id, { ...notes.value, world: [notes.value.world, parsed].filter(Boolean).join('\n\n---\n\n') }, targetHash);
      } else await characters.save(id, { fields: parsed, enabled: false }, targetHash);
    },
    'detector:connections': () => detectorConnections.read(),
    'detector:save': (edit, hash) => detectorConnections.save(edit, hash),
    'detector:detect': (id, file, hash, connectionId) => detector.detect(id, file, hash, connectionId),
    'detector:reports': id => detector.list(id),
    'detector:batch': (id: string, request) => detector.batch(id, request),
    'detector:batch-state': (id: string) => detector.batchState(id),
    'detector:cancel-batch': (id: string) => detector.cancelBatch(id),
    'detector:usage': (id: string) => detector.usage(id),
    'detector:quota': request => detector.configureUsage(request),
    'detector:test': (id: string) => detector.testConnection(id),
    'materials-sync:status': (id: string, revision?: string) => materialSync.status(id, revision),
    'materials-sync:configure': (id: string, enabled: boolean) => materialSync.configure(id, enabled),
    'materials-sync:synchronize': request => materialSync.synchronize(request),
    'materials-sync:history': (id: string) => materialSync.history(id),
    'materials-sync:history-preview': request => materialSync.previewHistory(request),
    'materials-sync:history-copy': request => materialSync.copyHistory(request),
    'materials-sync:history-archive': request => materialSync.archiveHistory(request),
    'materials-sync:history-import-open': async (id: string) => {
      workspace.getProject(id);
      const result = await dialog.showOpenDialog(window!, { title: '导入已完成的资料历史ZIP', properties: ['openFile'], filters: [{ name: '资料历史ZIP', extensions: ['zip'] }] });
      if (result.canceled) return null;
      if (result.filePaths.length !== 1) throw new Error('请选择一份本应用生成的资料历史ZIP');
      return materialSync.openHistoryArchive(id, result.filePaths[0]!);
    },
    'materials-sync:history-import-preview': request => materialSync.previewHistoryArchive(request),
    'materials-sync:history-import-copy': request => materialSync.importHistoryArchive(request),
    'docx:structure': (id: string, chapterPath: string, hash: string) => docxCopies.structure(id, chapterPath, hash),
    'docx:structure-batch': (id: string, chapterPath: string, actions, hash: string) => docxCopies.batchEdit(id, chapterPath, actions, hash),
    'materials:location': (id: string) => { workspace.getProject(id); return materialDirectory(materialsRoot, id); },
    'materials:generate': request => ai.startMaterial(request),
    'materials:import': async (id: string) => {
      workspace.getProject(id);
      const result = await dialog.showOpenDialog(window!, { title: '导入 DOCX / TXT 转换创作资料', properties: ['openFile'], filters: [{ name: '文本', extensions: ['docx', 'txt'] }] });
      if (result.canceled) return null;
      const file = result.filePaths[0]; if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('转换源文件不能超过 8 MB');
      const bytes = await fs.readFile(file), ext = path.extname(file).toLowerCase();
      if (!['.docx', '.txt'].includes(ext)) throw new Error('转换仅支持 DOCX / TXT');
      const text = ext === '.docx' ? (await mammoth.extractRawText({ buffer: bytes })).value : decodeText(bytes).text;
      if (!text.trim() || text.length > 100000) throw new Error('转换文段需要有内容，且不超过 10 万字符');
      return { projectId: id, name: path.basename(file), text };
    },
    'materials:save': async (id: string, kind: string, markdown: string, expectedHash: string) => {
      workspace.getProject(id);
      if (kind !== 'character' && kind !== 'world') throw new Error('无效资料类型');
      const parsed = parseMaterial(kind, markdown);
      if (typeof parsed === 'string') {
        const notes = await workspace.readNotes(id);
        if (notes.hash !== expectedHash) throw new Error('世界观资料已更新，请保留转换稿并重新加载');
        await workspace.saveNotes(id, { ...notes.value, world: [notes.value.world, parsed].filter(Boolean).join('\n\n---\n\n') }, expectedHash);
      } else await characters.save(id, { fields: parsed, enabled: false }, expectedHash);
    },
    'ai:models': (request: ModelDiscoveryRequest) => modelDiscovery.discover(request),
    'discussion:read': (id: string) => discussion.read(id),
    'discussion:ask': async (id: string, input: { text: string; connectionId: string }) => {
      const { profile, key } = await connections.resolve(input.connectionId);
      return discussion.ask(id, { text: input.text, contextWindow: profile.contextWindow, maxOutputTokens: profile.maxOutputTokens, stream: (messages, onText) => streamChat(profile, key, messages, AbortSignal.timeout(profile.timeoutSeconds * 1000), onText) });
    },
    'discussion:expand': (id: string, summaryId: string) => discussion.expand(id, summaryId),
    'ai:keyStatus': () => inspectKeys(path.join(app.getPath('userData'), 'ai-connections.json'), keyCodec),
    'ai:recoverKeys': async () => {
      await restoreFromBackup(path.join(app.getPath('userData'), 'ai-connections.json'));
      return connections.read();
    },
    'ai:connections': () => connections.read(),
    'ai:save-connection': (edit, hash) => connections.save(edit, hash),
    'ai:test': id => ai.testConnection(id),
    'ai:start': request => ai.start(request),
    'ai:review-batch': request => ai.startReviewBatch(request),
    'ai:tasks': id => ai.list(id),
    'ai:cancel': (id, taskId) => ai.cancel(id, taskId),
    'ai:export': (id, taskId) => ai.export(id, taskId),
    'ai:export-review-edits': (id, taskId, issueIds, guard) => ai.exportReviewEdits(id, taskId, issueIds, guard),
    'ai:review-decisions': (id, taskId) => ai.reviewDecisions(id, taskId),
    'ai:set-review-decision': request => ai.setReviewDecision(request),
    'characters:read': (id: string) => characters.read(id),
    'characters:save': (id: string, edit: CharacterEdit, hash: string) => characters.save(id, edit, hash),
    'macros:read': (id: string) => macros.read(id),
    'macros:preview': (id: string, text: string, context: { characterName?: string; userName?: string; lastMessage?: string }, requestId?: string) => macros.preview(id, text, context, requestId),
    'macros:cancel-preview': (id: string, requestId: string) => macros.cancel(id, requestId),
    'macros:import': async (id: string) => {
      workspace.getProject(id);
      const picked = await dialog.showOpenDialog({ title: '导入 SillyTavern 正则脚本', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const file = picked.filePaths[0], stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || path.extname(file).toLowerCase() !== '.json') throw new Error('正则导入只支持1 MiB以内的普通JSON文件');
      const handle = await fs.open(file, 'r'); let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (before.dev !== stat.dev || before.ino !== stat.ino || !before.isFile()) throw new Error('正则导入文件已变化');
        const chunks: Buffer[] = []; let total = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          total += chunk.length; if (total > 1024 * 1024) throw new Error('正则导入超过1 MiB'); chunks.push(Buffer.from(chunk));
        }
        const after = await handle.stat(), latest = await fs.lstat(file);
        if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || latest.isSymbolicLink() || latest.dev !== stat.dev || latest.ino !== stat.ino || latest.size !== after.size || latest.mtimeMs !== after.mtimeMs) throw new Error('正则导入文件读取期间已变化');
        bytes = Buffer.concat(chunks);
      } finally { await handle.close(); }
      return macros.importBytes(id, bytes);
    },
    'world:list': (id: string) => worldInfo.list(id),
    'world:remove': (id: string, name: string) => worldInfo.remove(id, name),
    'world:preview': (id: string, names: string[], text: string, characterNames?: string[]) => worldInfo.preview(id, names, text, characterNames),
    'world:import': async (id: string) => {
      const picked = await dialog.showOpenDialog({ title: '导入 SillyTavern 世界书', filters: [{ name: '世界书', extensions: ['json'] }], properties: ['openFile'] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const file = picked.filePaths[0];
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      const name = path.basename(file, '.json');
      return worldInfo.import(id, name, json);
    },
    'characters:export': (id: string, cardId: string) => characterLibrary.exportPng(id, cardId),
    'characters:remove': (id: string, cardId: string, hash: string) => characterLibrary.remove(id, cardId, hash),
    'characters:merge': (id: string, keepId: string, dropId: string, hash: string) => characterLibrary.merge(id, keepId, dropId, hash),
    'characters:release': (id: string, token: string) => characters.release(id, token),
    'characters:preview': async (id: string, kind: string) => {
      workspace.getProject(id);
      if (kind !== 'image' && kind !== 'text') throw new Error('无效导入类型');
      const chosen = await dialog.showOpenDialog(window!, { title: kind === 'image' ? '导入图片角色卡' : '导入文字角色卡', properties: ['openFile'], filters: [{ name: '角色卡', extensions: kind === 'image' ? ['png', 'jpg', 'jpeg', 'webp', 'charx'] : ['json', 'txt', 'docx', 'charx'] }] });
      if (chosen.canceled) return null;
      const file = chosen.filePaths[0];
      const size = (await fs.stat(file)).size;
      if (path.extname(file).toLowerCase() === '.charx') {
        if (size > 32 * 1024 * 1024) throw new Error('CHARX 包不能超过 32 MB');
        return characters.prepareCharx(id, path.basename(file), await fs.readFile(file), null);
      }
      if (size > 12 * 1024 * 1024) throw new Error('角色文件不能超过 12 MB');
      const bytes = await fs.readFile(file); const ext = path.extname(file).toLowerCase();
      let text: string | undefined;
      if (ext === '.docx') text = (await mammoth.extractRawText({ buffer: bytes })).value;
      if (ext === '.txt') {
        if (bytes[0] === 255 && bytes[1] === 254) text = new TextDecoder('utf-16le').decode(bytes);
        else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); } }
      }
      return characters.prepare(id, path.basename(file), bytes, ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? portraitPng(bytes) : null, text);
    },
    'characters:portrait': async (id: string) => {
      workspace.getProject(id);
      const chosen = await dialog.showOpenDialog(window!, { title: '选择角色头像', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (chosen.canceled) return null;
      if ((await fs.stat(chosen.filePaths[0])).size > 12 * 1024 * 1024) throw new Error('角色头像不能超过 12 MB');
      return characters.preparePortrait(id, portraitPng(await fs.readFile(chosen.filePaths[0])));
    },
    'book:read': (id: string) => library.read(id),
    'book:save': (id: string, value: BookDetails, hash: string) => library.save(id, value, hash),
    'book:cover': async (id: string) => {
      workspace.getProject(id);
      const chosen = await dialog.showOpenDialog(window!, { title: '选择封面图片', properties: ['openFile'], filters: [{ name: '封面图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
      if (chosen.canceled) return null;
      const file = chosen.filePaths[0];
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('封面图片请控制在 8 MB 内');
      const imageBytes = await fs.readFile(file);
      if (imageBytes.length > 8 * 1024 * 1024 || imageBytes.length !== stat.size) throw new Error('图片读取期间发生变化或超过8 MiB，请重新选择');
      const image = nativeImage.createFromBuffer(imageBytes);
      if (image.isEmpty()) throw new Error('无法识别这张图片');
      const size = image.getSize();
      if (size.width * size.height > 24000000) throw new Error('图片分辨率过大，请先缩小');
      const png = image.resize({ width: Math.min(size.width, 720) }).toPNG();
      return { asset: await library.addCover(id, png), dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    },
    'style:import': async (id: string, hash: string) => {
      workspace.getProject(id);
      const chosen = await dialog.showOpenDialog(window!, { title: '导入文风参考文本', properties: ['openFile', 'multiSelections'], filters: [{ name: '小说文本', extensions: ['txt', 'docx'] }] });
      if (chosen.canceled) return null;
      if (chosen.filePaths.length > 30) throw new Error('一次最多导入 30 份文本');
      const texts: { name: string; text: string; original?: Buffer }[] = [];
      for (const file of chosen.filePaths) {
        if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new Error('单份参考文件不能超过 8 MB');
        let text: string;
        if (path.extname(file).toLowerCase() === '.docx') text = (await mammoth.extractRawText({ path: file })).value;
        else if (path.extname(file).toLowerCase() === '.txt') {
          const bytes = await fs.readFile(file);
          if (bytes[0] === 255 && bytes[1] === 254) text = new TextDecoder('utf-16le').decode(bytes);
          else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); } }
        } else throw new Error('参考文本仅支持 TXT 或 DOCX');
        texts.push({ name: path.basename(file), text, original: path.extname(file).toLowerCase() === '.docx' ? await fs.readFile(file) : undefined });
      }
      return library.addSources(id, texts, hash);
    },
    'style:learn': request => ai.startStyleLearning(request),
    'style:confirm-learned': (id, taskId, name, rules, hash) => ai.confirmStyleLearning(id, taskId, name, rules, hash),
    'style:analyze': (id: string, name: string, sources: string[], hash: string) => library.analyze(id, name, sources, hash),
    'text:copy': (text: string) => {
      if (typeof text !== 'string' || text.length > 10000000) throw new Error('复制内容无效或过长');
      return clipboard.writeText(text);
    },
    'projects:list': () => workspace.listProjects(),
    'projects:open': async () => {
      const result = await dialog.showOpenDialog(window!, { title: '选择一本小说的独立文件夹', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : workspace.attach(result.filePaths[0]);
    },
    'chapters:list': async (id: string) => (await chapterOrder.read(id)).entries.filter(entry => entry.present).map(({ path, name }) => ({ path, name })),
    'chapters:order': (id: string) => chapterOrder.read(id),
    'chapters:save-order': (id: string, paths: string[], hash: string) => chapterOrder.save(id, paths, hash),
    'chapters:create': (id: string, format?: 'docx' | 'txt') => workspace.createChapter(id, undefined, format),
    'chapters:read': (id: string, relative: string) => workspace.readChapter(id, relative),
    'chapters:rename': (request: RenameChapterRequest) => workspace.renameChapter(request),
    'chapters:replace-preview': (request: { projectId: string; query: string; replacement: string; caseSensitive?: boolean; paths?: string[] }) => bookReplace.run({ ...request, dryRun: true }),
    'chapters:replace-all': (request: { projectId: string; query: string; replacement: string; caseSensitive?: boolean; paths?: string[] }) => bookReplace.run(request),
    'chapters:replace-undo': (request: { projectId: string; batchId: string }) => bookReplace.undo(request.projectId, request.batchId),
    'timeline:read': (id: string) => timeline.read(id),
    'timeline:save': (id: string, entries: { id: string; when: string; title: string; note: string; chapterPath?: string }[], hash: string) => timeline.save(id, entries, hash),
    'relations:read': (id: string) => relations.read(id),
    'relations:save': (id: string, list: { id: string; from: string; to: string; label: string; note: string; mutual: boolean; strength: number }[], hash: string) => relations.save(id, list, hash),
    'states:read': (id: string) => characterStates.read(id),
    'states:save': (id: string, list: { id: string; character: string; label: string; note: string; fromChapter?: number; toChapter?: number }[], hash: string) => characterStates.save(id, list, hash),
    'blueprints:read': (id: string) => blueprints.read(id),
    'blueprints:save': (id: string, list: { id: string; scope: 'volume' | 'chapter'; ref: string; title: string; goals: string; beats: string[]; sourceHash?: string; updatedAt: string }[], hash: string) => blueprints.save(id, list, hash),
    'docx:images': (id: string, chapterPath: string, hash?: string) => docxCopies.images(id, chapterPath, hash),
    'docx:replaceImage': async (id: string, chapterPath: string, mediaName: string, expectedHash: string) => {
      // The renderer cannot supply arbitrary local file paths. An explicit native
      // picker grants access to this one image; source version is rechecked after it.
      await workspace.readOriginalChapter(id, chapterPath, expectedHash);
      const picked = await dialog.showOpenDialog(window!, { title: '选择替换图片（另存新 Word 副本）', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const file = picked.filePaths[0], stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('图片文件无效或超过20 MiB');
      const imageBytes = await fs.readFile(file);
      if (imageBytes.length > 20 * 1024 * 1024 || imageBytes.length !== stat.size) throw new Error('图片读取期间发生变化或超过20 MiB，请重新选择');
      const expectedSize = validateReplacementImage(imageBytes);
      const image = nativeImage.createFromBuffer(imageBytes);
      if (image.isEmpty()) throw new Error('无法识别所选图片，原稿已保留');
      const decodedSize = image.getSize();
      const sameAxes = decodedSize.width === expectedSize.width && decodedSize.height === expectedSize.height;
      const rotatedAxes = decodedSize.width === expectedSize.height && decodedSize.height === expectedSize.width;
      if ((!sameAxes && !rotatedAxes) || decodedSize.width > 16384 || decodedSize.height > 16384 || decodedSize.width * decodedSize.height > 32_000_000)
        throw new Error('图片解码尺寸与预检不符或超过安全上限，原稿已保留');
      return docxCopies.replace(id, chapterPath, mediaName, /\.png$/iu.test(mediaName) ? image.toPNG() : image.toJPEG(95), expectedHash);
    },
    'docx:insight': (id: string, chapterPath: string) => docxCopies.insight(id, chapterPath),
    'docx:body': (id: string, chapterPath: string, expectedHash: string) => docxCopies.body(id, chapterPath, expectedHash),
    'docx:editStructure': (id: string, chapterPath: string, action: unknown, expectedHash: string) => docxCopies.edit(id, chapterPath, action, expectedHash),
    'chapters:saveFidelityCopy': (id: string, chapterPath: string, paragraphs: string[], expectedHash: string) => docxCopies.rewrite(id, chapterPath, paragraphs, expectedHash),
    'recovery:rawList': (id: string) => { workspace.getProject(id); return listRawDrafts(path.join(app.getPath('userData'), 'recovery'), id); },
    'recovery:rawRead': (id: string, draftId: string) => { workspace.getProject(id); return readRawDraft(path.join(app.getPath('userData'), 'recovery'), id, draftId); },
    'recovery:previousPrune': (id: string, dryRun: boolean) => { workspace.getProject(id); return prunePreviousVersions(path.join(app.getPath('userData'), 'recovery'), id, { dryRun }); },
    'recovery:previousList': (id: string) => { workspace.getProject(id); return listPreviousVersions(path.join(app.getPath('userData'), 'recovery'), id); },
    'recovery:previousRead': (id: string, versionId: string) => { workspace.getProject(id); return readPreviousVersion(path.join(app.getPath('userData'), 'recovery'), id, versionId); },
    'recovery:previousRestore': (id: string, versionId: string) => restorePreviousVersion(path.join(app.getPath('userData'), 'recovery'), id, versionId, workspace.getProject(id).root),
    'recovery:rawPrune': (id: string, dryRun: boolean) => { workspace.getProject(id); return pruneRawDrafts(path.join(app.getPath('userData'), 'recovery'), id, { dryRun }); },
    'recovery:rawRestore': async (id: string, draftId: string) => restoreRawDraft(path.join(app.getPath('userData'), 'recovery'), id, draftId, workspace.getProject(id).root),
    'book:exportZip': async (id: string) => {
      const project = workspace.getProject(id);
      const picked = await dialog.showSaveDialog(window!, {
        title: '导出整本书为 ZIP',
        defaultPath: path.join(app.getPath('documents'), `${project.name}.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }]
      });
      if (picked.canceled || !picked.filePath) return null;
      const target = picked.filePath.toLowerCase().endsWith('.zip') ? picked.filePath : `${picked.filePath}.zip`;
      await migrateBookRecords(id);
      return exportBookZip(workspace, id, target);
    },
    'book:progress': (id: string) => collectChapterStats(workspace, id),
    'chapters:exportText': async (id: string, chapterPath: string, format: 'txt' | 'md') => {
      const project = workspace.getProject(id);
      const base = path.basename(chapterPath, path.extname(chapterPath));
      const picked = await dialog.showSaveDialog(window!, {
        title: `导出本章为 ${format.toUpperCase()}`,
        defaultPath: path.join(app.getPath('documents'), `${base}.${format}`),
        filters: format === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: '纯文本', extensions: ['txt'] }]
      });
      if (picked.canceled || !picked.filePath) return null;
      const target = picked.filePath.toLowerCase().endsWith(`.${format}`) ? picked.filePath : `${picked.filePath}.${format}`;
      void project;
      return exportChapterText(workspace, id, chapterPath, target);
    },
    'book:health': (id: string) => inspectBook(workspace, id),
    'nas:drillHistory': () => readDrillHistory(app.getPath('userData')),
    'nas:drill': async () => { const report = await runOfflineDrill(); await saveDrillRecord(app.getPath('userData'), report); return report; },
    'nas:probe': (targets: { host: string; port: number; label?: string }[]) => {
      if (!Array.isArray(targets) || targets.length > MAX_STORAGE_TARGETS || targets.some(target => !target || typeof target.host !== 'string'
        || !isStorageHost(target.host) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
        || (target.label !== undefined && (typeof target.label !== 'string' || target.label.length > 1000))))
        throw new Error('目标无效：最多8项，地址和端口须有效');
      return probeTargets(targets.map(target => ({ host: target.host, port: target.port, label: target.label })), 3000);
    },
    'nas:location': (target: string) => detectPathLocation(target),
    'nas:backup': async (id: string) => {
      const picked = await dialog.showOpenDialog(window!, { title: '选择备份目标文件夹（NAS 映射盘目录即可）', properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      await migrateBookRecords(id);
      const result = await backupBook(workspace, id, picked.filePaths[0]);
      const verify = await verifyBackup(result.folder);
      return { folder: result.folder, files: result.files, bytes: result.bytes, verified: verify.ok, checked: verify.checked };
    },
    'nas:verify': (folder: string) => verifyBackup(folder),
    'nas:restore': async () => {
      const from = await dialog.showOpenDialog(window!, { title: '选择要恢复的备份文件夹（含 manifest.json）', properties: ['openDirectory'] });
      if (from.canceled || !from.filePaths[0]) return null;
      const to = await dialog.showOpenDialog(window!, { title: '选择恢复到的位置（会新建子目录，不覆盖现有小说）', properties: ['openDirectory', 'createDirectory'] });
      if (to.canceled || !to.filePaths[0]) return null;
      return restoreBackup(from.filePaths[0], to.filePaths[0]);
    },
    'usage:read': () => usage.read(),
    'style-history:read': (id: string) => styleHistory.read(id),
    'style-history:ensure': (id: string, hash: string, styleId: string, rules: string) => styleHistory.ensure(id, hash, styleId, rules),
    'style-history:sync': async (id: string) => {
      const book = await library.read(id);
      return styleHistory.sync(id, book.value.styles.map(style => ({ id: style.id, rules: style.rules })));
    },
    'style-history:revise': (id: string, hash: string, styleId: string, rules: string) => styleHistory.revise(id, hash, styleId, rules),
    'style-history:restore': (id: string, hash: string, styleId: string, version: number) => styleHistory.restore(id, hash, styleId, version),
    'style-history:record': (id: string, hash: string, styleId: string, effect: { source: 'trial' | 'chapter'; characters: number; averageSentence: number; dialogueRatio: number; note?: string }) => styleHistory.record(id, hash, styleId, effect),
    'style:compare': async (request: { projectId: string; connectionId: string; brief: string; styleIds: string[] }) => {
      const book = await library.read(request.projectId);
      const styles = new Map(book.value.styles.map(style => [style.id, style]));
      const picked = request.styleIds.map(id => {
        const style = styles.get(id);
        if (!style) throw new Error('所选文风不属于本书，请重新选择');
        return { styleId: style.id, styleName: style.name };
      });
      const trial = createStyleTrial(connections, styleId => styles.get(styleId)?.rules ?? '');
      return trial.run(request.connectionId, { brief: request.brief, styles: picked });
    },
    'prompts:read': (id: string) => prompts.read(id),
    'prompts:save': (id: string, list: { id: string; name: string; kind: 'write' | 'review' | 'planning' | 'other'; body: string; version: number; updatedAt: string; versions: { version: number; body: string; savedAt: string }[] }[], hash: string) => prompts.save(id, list, hash),
    'chapters:capabilities': async (id: string, chapterPath: string) => {
      const project = workspace.getProject(id);
      const bytes = await fs.readFile(path.join(project.root, chapterPath));
      return analyzeDocx(bytes);
    },
    'chapters:move': async (request: { projectId: string; path: string; expectedHash: string; folder: string }) => {
      const project = workspace.getProject(request.projectId);
      const target = project.root;
      const picked = await dialog.showOpenDialog(window!, { title: '选择章节要移动到的文件夹（必须在本书文件夹内）', defaultPath: path.join(target, request.folder || ''), properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled || !picked.filePaths[0]) throw new Error('未选择目标文件夹，章节未移动');
      const absolute = path.resolve(picked.filePaths[0]);
      const relative = path.relative(target, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('目标文件夹必须位于本书文件夹内，章节未移动');
      const moved = await workspace.moveChapter({ ...request, folder: relative });
      // Keep the saved chapter order pointing at the new location.
      const order = await chapterOrder.read(request.projectId).catch(() => null);
      if (order) {
        const oldRelative = request.path, next = order.value.paths.map(item => (item === oldRelative ? moved : item));
        if (JSON.stringify(next) !== JSON.stringify(order.value.paths)) await chapterOrder.save(request.projectId, next, order.hash).catch(() => {});
      }
      return moved;
    },
    'chapters:save': (request: SaveRequest) => workspace.saveChapter(request),
    'chapters:copy': (id: string, content: RichNode, format?: 'docx' | 'txt') => workspace.createChapter(id, content, format),
    'notes:read': (id: string) => workspace.readNotes(id),
    'notes:save': (id: string, notes: ProjectNotes, hash: string) => workspace.saveNotes(id, notes, hash)
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无效窗口请求');
      if (finishingExit) throw new Error('正在退出');
      if (exitToken && /^(ai:(start|test|models|review-batch)|macros:(preview|import)|materials:generate|planning:generate|memory:(generate|generate-batch|cancel-batch)|style:learn|detector:(detect|test|quota|batch|cancel-batch)|models:test-(embedding|rerank)|knowledge:(search|sources|index-rebuild|cancel-index)|drafts:(save|clear)|confirmation:(read|preview|confirm|disable)|projects:open|chapters:(create|copy|rename)|docx:(replaceImage|editStructure)|materials-sync:(history-copy|history-archive|history-import-open|history-import-copy))$/.test(channel)) throw new Error('正在保存退出，请稍后操作');
      const readOnly = /^(models:auxiliary|ai:(connections|tasks)|detector:(connections|reports|usage|batch-state)|memory:batch-state|knowledge:index-status|drafts:read|projects:list|chapters:(list|read|order|conflicts)|notes:read|book:read|characters:read|planning:read|memory:read|materials:location|recovery:(list|read))$/.test(channel);
      const tracked = !channel.startsWith('app:') && !readOnly;
      if (tracked) activeRequests++;
      try {
        if (channel.startsWith('app:')) return await handler(...args);
        // Preview reserves its cancellation session before entering the shared gate.
        // Cancellation only aborts that in-memory session and must bypass queued swaps.
        if (channel === 'macros:preview' || channel === 'macros:cancel-preview') return await handler(...args);
        if (channel.startsWith('materials-sync:')) {
          // All pre-existing IPC, including reads that create missing Markdown files,
          // must finish before exchanging the canonical directory. Status may
          // recover an interrupted swap too, so it uses the same exclusive gate.
          return await materialGate.exclusive(() => {
            if (ai.hasPendingWork()) throw new Error('模型任务仍在运行，请等待或停止后再同步固定资料');
            return handler(...args);
          });
        }
        return await materialGate.shared(() => handler(...args));
      } finally { if (tracked) activeRequests--; }
    });
  }
  window = new BrowserWindow({
    title: '小说编写器', width: 1440, height: 960, minWidth: 1000, minHeight: 720,
    show: !process.env.NOVEL_WRITER_TEST_DATA,
    backgroundColor: '#f5f3ee', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: Boolean(process.env.NOVEL_WRITER_TEST_DATA) }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    const answer = dialog.showMessageBoxSync(window!, {
      type: 'warning', buttons: ['返回保存', '放弃未保存修改并退出'], defaultId: 0, cancelId: 0,
      message: '当前有未保存的修改', detail: '保存后再退出，可以保留本次正文和资料。'
    });
    if (answer === 1) event.preventDefault();
  });
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.restore(); window?.focus(); });
  app.whenReady().then(bootstrap).catch(error => {
    recordStartupError('bootstrap', error);
    dialog.showErrorBox('启动失败', String(error));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
