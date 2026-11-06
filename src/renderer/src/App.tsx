import { useCallback, useEffect, useRef, useState } from 'react';
import appIconUrl from '../../../assets/app-icon.svg?url';
import type { AIConnection, BookDetails, BookSnapshot, Chapter, ChapterImportPlan, TrashedChapter, KnowledgeSearchHit, Manuscript, NoteKind, NotesSnapshot, Project, RichNode, WorldCardEditRequest } from '../../shared/contracts';
import { ManuscriptEditor } from './Editor';
import { copyableText } from '../../core/typography';
import { BookCover, Shelf } from './Shelf';
import { ImportPreview } from './ImportPreview';
import { StylePicker, StyleStudio } from './StyleStudio';
import { Characters } from './Characters';
import { AISettings } from './AISettings';
import { AIWriter } from './AIWriter';
import { Materials } from './Materials';
import { Detection } from './Detection';
import { Planning } from './Planning';
import { Memories } from './Memories';
import { Recovery } from './Recovery';
import { ChapterRename } from './ChapterRename';
import { ChapterOrder } from './ChapterOrder';
import { BookReplacePanel } from './BookReplacePanel';
import { TimelinePanel } from './TimelinePanel';
import { StatesPanel } from './StatesPanel';
import { PromptLibraryPanel } from './PromptLibraryPanel';
import { BlueprintPanel } from './BlueprintPanel';
import { StyleTrialPanel } from './StyleTrialPanel';
import { SceneAnalysisPanel } from './SceneAnalysisPanel';
import { StyleHistoryPanel } from './StyleHistoryPanel';
import { UsagePanel } from './UsagePanel';
import { WorldInfoPanel } from './WorldInfoPanel';
import { describeSaveBadge, toFailure, type SaveState } from '../../core/save-status';
import { MacroPanel } from './MacroPanel';
import { NasPanel } from './NasPanel';
import { KeyStatusPanel } from './KeyStatusPanel';
import { QuickConnectPanel } from './QuickConnectPanel';
import { DiscussionPanel } from './DiscussionPanel';
import { ConflictCompare } from './ConflictCompare';
import { FidelityCopyEditor, type FidelityTarget } from './FidelityCopyEditor';
import { RelationsPanel } from './RelationsPanel';
import { KnowledgeSearch } from './KnowledgeSearch';
import { ChapterConfirmations } from './ChapterConfirmations';
import { exitSaves } from './save-before-exit';
import { MaterialSyncPanel } from './MaterialSyncPanel';
import type { MaterialSyncSnapshot } from '../../shared/material-sync';
import { UpdatePanel } from './UpdatePanel';
import './version-indicator.css';
import './topbar-polish.css';
import { MoreMenu } from './MoreMenu';
import { InspectorCards } from './InspectorCards';
import { WorldCardEditor } from './WorldCardEditor';

function NavIcon({ type }: { type: 'shelf' | 'writer' | 'people' | 'style' | 'model' }) {
  const shapes = {
    shelf: <><path d="M4 4.5h6.5v14H4zM13 4.5h7v14h-7z" /><path d="M6.5 8h1.5M15.5 8h2" /></>,
    writer: <><path d="m5 16 9.6-9.6 3 3L8 19H5z" /><path d="m13.4 7.6 3 3M4.5 20h6" /></>,
    people: <><circle cx="12" cy="8" r="3" /><path d="M5.5 19c.4-3.2 2.6-5 6.5-5s6.1 1.8 6.5 5" /></>,
    style: <><path d="M12 3.5 13.8 9l5.7 2-5.7 2L12 18.5 10.2 13l-5.7-2 5.7-2z" /><path d="m18.5 16 .6 1.8L21 18.5l-1.9.7-.6 1.8-.6-1.8-1.9-.7 1.9-.7z" /></>,
    model: <><rect x="5" y="6" width="14" height="12" rx="3" /><path d="M9 11h.01M15 11h.01M9 14.5c1.7 1 4.3 1 6 0M12 6V4M9 19v1M15 19v1" /></>
  };
  return <svg className="topbar-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{shapes[type]}</svg>;
}

const tabs: { id: NoteKind | 'ai' | 'memory'; label: string }[] = [
  { id: 'characters', label: '人物' }, { id: 'world', label: '世界观' }, { id: 'preset', label: '预设' },
  { id: 'ai', label: 'AI' }, { id: 'memory', label: '记忆' }
];
const placeholders: Record<NoteKind, string> = {
  characters: '记录人物姓名、性格、说话方式和行为边界。\n\n例如：林夏，不善表达，但在关键时刻会主动承担责任。',
  world: '记录时代背景、地点、组织和不可违反的规则。\n\n这些资料只属于当前小说。',
  preset: '记录本书的写作要求、叙事视角与禁用表达。\n\n模型接入后会由上下文模块统一组装。',
  style: '记录希望学习的风格特点。\n\n例如：中文日式轻小说，第一人称，短段落，以对白推进，适度心理独白。\n\n参考文本自动分析将在后续阶段接入。'
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [importPlan, setImportPlan] = useState<ChapterImportPlan | null>(null);
  const [trash, setTrash] = useState<TrashedChapter[] | null>(null);
  const [books, setBooks] = useState<Record<string, BookSnapshot>>({});
  const removedProjects = useRef(new Set<string>());
  const [shelfMessage, setShelfMessage] = useState('');
  const [shelfLoading, setShelfLoading] = useState(true);
  const [folderRenameIssue, setFolderRenameIssue] = useState('');
  useEffect(() => { let live = true; void window.writer.folderRenameStatus().then(value => { if (live) setFolderRenameIssue(value); }).catch(() => {}); return () => { live = false; }; }, []);
  const [view, setView] = useState<'shelf' | 'writer' | 'styles' | 'characters' | 'ai-settings' | 'ai-writer' | 'materials' | 'detection' | 'planning' | 'memories' | 'recovery' | 'knowledge' | 'confirmations'>('shelf');
  const [connections, setConnections] = useState<AIConnection[]>([]);
  const [aiSettingsDirty, setAISettingsDirty] = useState(false);
  const [materialsDirty, setMaterialsDirty] = useState(false);
  const [detectionDirty, setDetectionDirty] = useState(false);
  const [planningDirty, setPlanningDirty] = useState(false);
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [citationSelection, setCitationSelection] = useState<{ projectId: string; hits: KnowledgeSearchHit[] } | null>(null);
  const [characterRevision, setCharacterRevision] = useState(0);
  const [materialRevision, setMaterialRevision] = useState(0);
  const [materialSyncProject, setMaterialSyncProject] = useState<string | null>(null);
  const [materialSyncBusy, setMaterialSyncBusy] = useState(false);
  const [auxDirty, setAuxDirty] = useState(false);
  const [charactersDirty, setCharactersDirty] = useState(false);
  const [volume, setVolume] = useState('');
  const [newFormat, setNewFormat] = useState<'docx' | 'txt'>('docx');
  const [active, setActive] = useState<Project | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterNamesError, setChapterNamesError] = useState('');
  useEffect(() => { let live = true; setChapterNamesError(''); if (active) void window.writer.chapterDisplayNames(active.id).catch(failure => { if (live) setChapterNamesError(String(failure instanceof Error ? failure.message : failure)); }); return () => { live = false; }; }, [active?.id]);
  const [renameTarget, setRenameTarget] = useState<Manuscript | null>(null);
  const [orderProject, setOrderProject] = useState<string | null>(null); const [orderDirty, setOrderDirty] = useState(false);
  const [fidelityTarget, setFidelityTarget] = useState<FidelityTarget | null>(null), [fidelityDirty, setFidelityDirty] = useState(false);
  const [replaceProject, setReplaceProject] = useState<string | null>(null);
  const [jump, setJump] = useState<{ text: string; token: number } | null>(null);
  const [timelineOpen, setTimelineOpen] = useState<string | null>(null);
  const [relationsOpen, setRelationsOpen] = useState<string | null>(null);
  const [promptsOpen, setPromptsOpen] = useState<string | null>(null);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [styleHistoryOpen, setStyleHistoryOpen] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateVersion, setUpdateVersion] = useState('');
  const [versionUnavailable, setVersionUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    void window.writer.updateVersion().then(version => {
      if (!active) return;
      if (typeof version !== 'string' || !version.trim() || version.length > 128) { setVersionUnavailable(true); return; }
      setUpdateVersion(version); setVersionUnavailable(false);
    }).catch(() => { if (active) setVersionUnavailable(true); });
    return () => { active = false; };
  }, []);
  const [worldOpen, setWorldOpen] = useState<string | null>(null);
  const [worldCardTarget, setWorldCardTarget] = useState<WorldCardEditRequest | null>(null);
  const [worldCardActionBusy, setWorldCardActionBusy] = useState(false);
  const [worldInitialBook, setWorldInitialBook] = useState('');
  const [inspectorRevision, setInspectorRevision] = useState(0);
  const [mappingDirty, setMappingDirty] = useState(false);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [macroOpen, setMacroOpen] = useState<string | null>(null);
  const [nasOpen, setNasOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [discussionOpen, setDiscussionOpen] = useState<string | null>(null);
  const [blueprintOpen, setBlueprintOpen] = useState<string | null>(null);
  const [fillInstruction, setFillInstruction] = useState<{ text: string; token: number } | null>(null);
  const [statesOpen, setStatesOpen] = useState<string | null>(null);
  const [capability, setCapability] = useState<{ path: string; risks: string[]; preserved: string } | null>(null);
  const [document, setDocument] = useState<Manuscript | null>(null);
  const [notes, setNotes] = useState<NotesSnapshot | null>(null);
  const [tab, setTab] = useState<NoteKind | 'ai' | 'memory'>('characters');
  const [dirty, setDirty] = useState(false);
  const editorDirtyRef = useRef(false);
  editorDirtyRef.current = dirty;
  const [revision, setRevision] = useState(0); const [editorSession, setEditorSession] = useState(0);
  const [autoSave, setAutoSave] = useState(() => localStorage.getItem('autosave-manuscript') === 'true');
  const [autoSaving, setAutoSaving] = useState(false); const [autoStopped, setAutoStopped] = useState(false); const [checkpointStatus, setCheckpointStatus] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exiting, setExiting] = useState(false);
  const externalBusyRef = useRef(false);
  externalBusyRef.current = Boolean(fidelityTarget || fidelityDirty || renameTarget || autoSaving || exiting);
  const [message, setMessage] = useState('选择小说文件夹，开始写作');
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>({});
  const [syncConflicts, setSyncConflicts] = useState<{ path: string; baseName: string; kind: string }[]>([]);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [externalPaths, setExternalPaths] = useState<string[]>([]);
  const externalHandler = useRef<(projectId: string, paths: string[]) => void>(() => {});
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void window.writer.watchChapterFiles(active.id).catch(() => {});
    const off = window.writer.onExternalChapterChange(payload => {
      if (disposed || payload.projectId !== active.id || !payload.paths.length) return;
      externalHandler.current(payload.projectId, payload.paths);
    });
    return () => { disposed = true; off(); };
  }, [active?.id]);
  // Read-only capability report for external DOCX chapters: say what will not survive editing.
  useEffect(() => {
    setCapability(null);
    if (!active || !document || !document.path.toLowerCase().endsWith('.docx')) return;
    let cancelled = false;
    void window.writer.docxCapabilities(active.id, document.path).then(report => {
      if (!cancelled && report.risks.length) setCapability({ path: document.path, risks: report.risks, preserved: report.features[0]?.note ?? '' });
    }).catch(() => { /* a report is a courtesy; failing to read it must not block editing */ });
    return () => { cancelled = true; };
  }, [active?.id, document?.path, document?.hash]);
  const [count, setCount] = useState(0);
  const draft = useRef<RichNode | null>(null);
  const draftVersion = useRef(0); const draftId = useRef(crypto.randomUUID());
  const documentRef = useRef(document); documentRef.current = document;
  const pending = useRef(false);
  const activeIdRef = useRef(active?.id); activeIdRef.current = active?.id;

  const run = useCallback(async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  }, []);
  const updateBook = useCallback((next: BookSnapshot) => {
    if (!removedProjects.current.has(next.value.projectId)) setBooks(current => ({ ...current, [next.value.projectId]: next }));
  }, []);
  const setCitations = useCallback((projectId: string, hits: KnowledgeSearchHit[]) => {
    if (activeIdRef.current !== projectId) return;
    if (hits.length > 10 || hits.some(hit => hit.projectId !== projectId || hit.corpus !== 'canon' || !hit.confirmed)
      || new Set(hits.map(hit => hit.id)).size !== hits.length) {
      setCitationSelection(null); setError('检索依据与本书正式内容不匹配，请重新选择'); return;
    }
    setCitationSelection({ projectId, hits: structuredClone(hits) });
  }, []);
  async function persistBook(id: string, value: BookDetails, hash: string) { const next = await window.writer.saveBook(id, value, hash); updateBook(next); return next; }
  useEffect(() => { void window.writer.listProjects().then(async items => {
    setProjects(items);
    // Reconcile before readBook creates a missing local styles file on a new device.
    const results = await Promise.allSettled(items.map(async p => {
      try {
        const sync = await window.writer.synchronizeMaterials({ projectId: p.id });
        if (sync.status !== 'clean' && sync.status !== 'disabled') setError(`「${p.name}」固定资料需要核对：${sync.message}`);
      } catch (e) { setError(`「${p.name}」固定资料未同步：${e instanceof Error ? e.message : String(e)}`); }
      return window.writer.readBook(p.id);
    }));
    for (const result of results) { if (result.status === 'fulfilled') updateBook(result.value); else setError(String(result.reason)); }
  }).catch(e => setError(String(e))).finally(() => setShelfLoading(false)); }, [updateBook]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty || notesDirty || auxDirty || charactersDirty || aiSettingsDirty || materialsDirty || detectionDirty || planningDirty || memoryDirty || knowledgeBusy || confirmationBusy || orderDirty || fidelityDirty || worldCardTarget || worldCardActionBusy || busy || autoSaving || materialSyncBusy || mappingDirty || mappingBusy || pluginBusy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, notesDirty, auxDirty, charactersDirty, aiSettingsDirty, materialsDirty, detectionDirty, planningDirty, memoryDirty, knowledgeBusy, confirmationBusy, orderDirty, fidelityDirty, worldCardTarget, worldCardActionBusy, busy, autoSaving, materialSyncBusy, mappingDirty, mappingBusy, pluginBusy]);

  function discard() {
    if (worldCardTarget || worldCardActionBusy) { setError('请先完成世界设定卡编辑或回收站操作。'); return false; }
    if (mappingDirty || mappingBusy || pluginBusy) { setError('酒馆关联或插件检查仍在处理，请先完成。'); return false; }
    const accepted = (!dirty && !notesDirty && !auxDirty && !charactersDirty && !materialsDirty && !detectionDirty && !planningDirty && !memoryDirty && !orderDirty && !fidelityDirty) || window.confirm('当前有未保存的正文或资料，确定放弃修改并切换吗？');
    if (accepted) { setFidelityTarget(null); setFidelityDirty(false); }
    return accepted;
  }
  function loadDocument(next: Manuscript | null) {
    setRenameTarget(null);
    setFidelityTarget(null); setFidelityDirty(false);
    documentRef.current = next; draftId.current = crypto.randomUUID(); draftVersion.current = 0; setRevision(0); setEditorSession(value => value + 1); setAutoStopped(false); setCheckpointStatus('');
    setDocument(next); draft.current = next && typeof next.content !== 'string' ? next.content : null;
    editorDirtyRef.current = false; setDirty(false); setCount(0); setSaveState({});
  }
  externalHandler.current = (projectId, paths) => {
    const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLocaleLowerCase() === b.replace(/\\/g, '/').toLocaleLowerCase();
    const report = (path: string) => { if (activeIdRef.current === projectId) setExternalPaths(current => [...new Set([...current, path])]); };
    const target = documentRef.current;
    const relevant = target?.projectId === projectId && paths.some(path => samePath(path, target.path));
    void (async () => {
      // A watcher can report our own in-flight save. Wait for its frozen session
      // to settle before comparing hashes; never hold the editor or discard input.
      for (let attempt = 0; pending.current && attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (activeIdRef.current !== projectId) return;
      }
      if (activeIdRef.current !== projectId) return;
      try {
        const files = await window.writer.chapters(projectId);
        if (activeIdRef.current !== projectId) return;
        setChapters(files);
      } catch { for (const path of paths) report(path); return; }
      if (!relevant || !target || activeIdRef.current !== projectId) return;
      const current = documentRef.current;
      if (!current || current.projectId !== projectId || !samePath(current.path, target.path)) return;
      const session = draftId.current, version = draftVersion.current, expectedHash = current.hash;
      try {
        const latest = await window.writer.readChapter(projectId, target.path);
        if (activeIdRef.current !== projectId || documentRef.current?.projectId !== projectId || !samePath(documentRef.current.path, target.path)) return;
        if (latest.hash === documentRef.current.hash && samePath(latest.path, target.path)) return;
        if (draftId.current !== session || documentRef.current.hash !== expectedHash) {
          if (editorDirtyRef.current) report(target.path);
          return;
        }
        if (pending.current || externalBusyRef.current || editorDirtyRef.current || draftVersion.current !== version || !samePath(latest.path, target.path)) { report(target.path); return; }
        loadDocument(latest);
        setExternalPaths(current => current.filter(path => !samePath(path, target.path)));
        setMessage('已自动读取磁盘上的最新正文');
      } catch { report(target.path); }
    })();
  };
  async function selectProject(project: Project) {
    let syncProblem = '';
    try {
      const sync = await window.writer.synchronizeMaterials({ projectId: project.id });
      if (sync.status !== 'clean' && sync.status !== 'disabled') syncProblem = sync.message;
    } catch (e) { syncProblem = e instanceof Error ? e.message : String(e); }
    const [files, projectNotes, book] = await Promise.all([window.writer.chapters(project.id), window.writer.readNotes(project.id), window.writer.readBook(project.id)]);
    activeIdRef.current = project.id;
    setExternalPaths([]);
    setOrderProject(null); setCitationSelection(null); setActive(project); setChapters(files); setNotes(projectNotes); setNotesDirty(false); loadDocument(null);
    updateBook(book); setVolume(''); setNewFormat('docx'); setView('writer'); setAuxDirty(false);
    setMessage(`已打开「${project.name}」· ${files.length} 个正文文件（DOCX / TXT）`);
    if (syncProblem) { setError(`固定资料尚未同步：${syncProblem}`); setMaterialSyncProject(project.id); }
    void window.writer.listSyncConflicts(project.id).then(items => { if (activeIdRef.current === project.id) setSyncConflicts(items); })
      .catch(() => { if (activeIdRef.current === project.id) setSyncConflicts([]); });
  }
  async function removeBook(project: Project) {
    if (pending.current || busy || autoSaving || exiting || shelfLoading) return;
    setError(''); setShelfMessage('');
    try {
      if (dirty || notesDirty || auxDirty || charactersDirty || aiSettingsDirty || materialsDirty || detectionDirty || planningDirty || memoryDirty
        || knowledgeBusy || confirmationBusy || orderDirty || fidelityDirty || materialSyncBusy || mappingDirty || mappingBusy || pluginBusy || renameTarget)
        throw new Error('请先保存正文和各页资料、完成当前操作，再从书架移除作品；未保存内容已保留。');
      exitSaves.assertClean(undefined, '移除书架作品');
      const id = project.id, title = books[id]?.value.title ?? project.name;
      if (!window.confirm(`将「${title}」从书架移除？\n\n只取消本机书架关联，小说正文、封面、人物卡、世界观和恢复草稿全部保留。之后可通过“打开小说文件夹”重新加入。`)) return;
      await run(async () => {
        await window.writer.removeProject(id);
        removedProjects.current.add(id);
        setProjects(current => current.filter(item => item.id !== id));
        setBooks(current => { const next = { ...current }; delete next[id]; return next; });
        if (activeIdRef.current === id) {
          activeIdRef.current = undefined; setActive(null); loadDocument(null);
          setNotes(null); setNotesDirty(false); setChapters([]); setVolume(''); setNewFormat('docx');
          setCitationSelection(null); setSyncConflicts([]); setExternalPaths([]); setCapability(null); setJump(null); setFillInstruction(null);
          setOrderProject(null); setReplaceProject(null); setTimelineOpen(null); setRelationsOpen(null); setPromptsOpen(null);
          setTrialOpen(null); setSceneOpen(false); setStyleHistoryOpen(null); setWorldOpen(null); setMacroOpen(null);
          setDiscussionOpen(null); setBlueprintOpen(null); setStatesOpen(null); setMaterialSyncProject(null); setConflictOpen(false);
          setAuxDirty(false); setCharactersDirty(false); setMaterialsDirty(false); setPlanningDirty(false); setMemoryDirty(false); setDetectionDirty(false);
          setOrderDirty(false); setMappingDirty(false); setView('shelf');
          setMessage('选择小说文件夹，开始写作');
        }
        setShelfMessage(`已将「${title}」从书架移除，原文件与创作资料已保留。`);
      });
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function renameBookFolder(project: Project, name: string) {
    if (pending.current || busy || autoSaving || exiting || shelfLoading) throw new Error('其他操作尚未完成，请稍后重试');
    if (dirty || notesDirty || auxDirty || charactersDirty || aiSettingsDirty || materialsDirty || detectionDirty || planningDirty || memoryDirty || knowledgeBusy || confirmationBusy || orderDirty || fidelityDirty || materialSyncBusy || mappingDirty || mappingBusy || pluginBusy || renameTarget || worldCardTarget || worldCardActionBusy) throw new Error('请先保存正文和各页资料，并完成当前操作');
    exitSaves.assertClean(undefined, '修改小说文件夹名称');
    pending.current = true; setBusy(true);
    try {
      const updated = await window.writer.renameProjectFolder({ projectId: project.id, expectedRoot: project.root, name });
      setProjects(current => current.map(item => item.id === updated.id ? updated : item));
      if (activeIdRef.current === project.id) {
        activeIdRef.current = undefined; setActive(null); loadDocument(null); setNotes(null); setChapters([]); setVolume('');
        setCitationSelection(null); setSyncConflicts([]); setExternalPaths([]); setCapability(null); setJump(null); setFillInstruction(null);
        setOrderProject(null); setReplaceProject(null); setTimelineOpen(null); setRelationsOpen(null); setPromptsOpen(null); setTrialOpen(null); setSceneOpen(false); setStyleHistoryOpen(null); setWorldOpen(null); setMacroOpen(null); setDiscussionOpen(null); setBlueprintOpen(null); setStatesOpen(null); setMaterialSyncProject(null); setConflictOpen(false);
      }
      setFolderRenameIssue(''); setShelfMessage(`文件夹已改名为「${name}」，请从书架重新打开作品。`);
    } catch (failure) { try { setFolderRenameIssue(await window.writer.folderRenameStatus()); } catch { /* retain operation error */ } throw failure; }
    finally { pending.current = false; setBusy(false); }
  }
  async function refreshMaterials(snapshot: MaterialSyncSnapshot) {
    const id = snapshot.projectId;
    const [freshNotes, book] = await Promise.all([window.writer.readNotes(id), window.writer.readBook(id)]);
    if (freshNotes.value.projectId !== id || book.value.projectId !== id || activeIdRef.current !== id)
      throw new Error('资料刷新期间小说或结果归属已变化，请重新打开本书');
    updateBook(book);
    setNotes(freshNotes); setNotesDirty(false); setCitationSelection(null);
    setCharacterRevision(value => value + 1); setMaterialRevision(value => value + 1);
    setMessage('本书固定资料已重新读取；同步和外部客户端传输状态请分别核对');
  }
  async function beforeMaterialSync() {
    if (pending.current || busy || autoSaving || dirty || notesDirty || auxDirty || charactersDirty || materialsDirty || planningDirty || memoryDirty || detectionDirty || orderDirty || fidelityDirty || knowledgeBusy || confirmationBusy || renameTarget || mappingDirty || mappingBusy || pluginBusy)
      throw new Error('请先保存正文和各页资料、完成当前操作，再同步固定资料');
    exitSaves.assertClean('固定资料同步');
  }
  async function save() {
    if (!document || !draft.current || !dirty) return;
    const request = { projectId: document.projectId, path: document.path, expectedHash: document.hash, content: structuredClone(draft.current) }; const id = draftId.current, version = draftVersion.current;
    const sameSession = () => draftId.current === id && documentRef.current?.projectId === request.projectId && documentRef.current.path === request.path;
    let checkpointKept = false;
    let next: Manuscript;
    try {
      await window.writer.checkpointDraft({ ...request, id, revision: version }); checkpointKept = true;
      if (!sameSession()) return;
      next = await window.writer.saveChapter(request);
    } catch (failure) {
      if (!sameSession()) return;
      setSaveState(current => ({ ...current, lastFailure: toFailure(failure instanceof Error ? failure.message : String(failure), new Date(), checkpointKept) }));
      throw failure;
    }
    if (sameSession()) {
      const unsaved = draftVersion.current !== version;
      if (!unsaved) loadDocument(next);
      else setDocument(current => current && current.projectId === request.projectId && current.path === request.path ? { ...current, hash: next.hash } : current);
      setSaveState({ lastSuccessAt: new Date().toISOString(), unsaved });
      setMessage(unsaved ? '此前正文已保存，当前仍有未保存修改' : `${next.path.toLowerCase().endsWith('.txt') ? 'TXT' : 'DOCX'} 已保存到所选文件夹`);
    }
    await window.writer.completeDraft(request.projectId, id, version).catch(() => { if (documentRef.current?.projectId === request.projectId && documentRef.current.path === request.path) setError('正文已保存，但本机草稿状态更新失败，恢复区仍保留内容'); });
    void autoSummarize(next);
  }
  /** Optional per-book draft summary after a save. It never confirms or enables memory. */
  async function autoSummarize(next: Manuscript) {
    const target = next.projectId;
    if (localStorage.getItem(`auto-summary:${target}`) !== 'true') return;
    const connectionId = localStorage.getItem(`summary-model:${target}`) ?? '';
    if (!connectionId) return;
    try {
      const task = await window.writer.startSummary({ projectId: target, chapterPath: next.path, sourceHash: next.hash, connectionId });
      if (activeIdRef.current === target && task.projectId === target) setMessage('已生成章节摘要草稿；到“记忆”页核对确认后才会进入故事记忆');
    } catch (error) {
      const text = String(error);
      // A running model task is not an error the author must act on; the next save can retry.
      if (/已有 AI 任务运行|正在准备/.test(text)) return;
      if (activeIdRef.current === target) setError(`章节已保存，但自动摘要草稿未生成：${text}`);
    }
  }
  async function saveAndExit() {
    if (worldCardActionBusy) { setError('设定卡回收站操作仍在进行，请稍后再保存退出。'); return; }
    if (pending.current || autoSaving || exiting || materialSyncBusy || mappingBusy || pluginBusy) return;
    let token: string | null = null;
    let synchronized: MaterialSyncSnapshot | null = null;
    try {
      if (auxDirty || charactersDirty || materialsDirty || detectionDirty || planningDirty || memoryDirty || orderDirty || renameTarget || mappingDirty || worldCardTarget) throw new Error('其他页面或弹窗有未保存内容，请先保存或确认；未确认的AI资料不会自动采用');
      const plan = exitSaves.preflight();
      const target = document; const content = dirty && draft.current ? structuredClone(draft.current) : null;
      const targetNotes = notesDirty && notes ? structuredClone(notes) : null;
      const sessionId = draftId.current, version = draftVersion.current;
      if (dirty && (!target?.managed || !content)) throw new Error('当前正文不能原位保存，请先另存副本');
      pending.current = true; setBusy(true); setExiting(true); setError('');
      token = await window.writer.beginSaveExit();
      await exitSaves.saveAll(plan);
      if (target && content) {
        const request = { projectId: target.projectId, path: target.path, expectedHash: target.hash, content };
        const sameSession = () => draftId.current === sessionId && documentRef.current?.projectId === target.projectId && documentRef.current.path === target.path;
        let checkpointKept = false;
        let next: Manuscript;
        try {
          await window.writer.checkpointDraft({ ...request, id: sessionId, revision: version }); checkpointKept = true;
          next = await window.writer.saveChapter(request);
        } catch (failure) {
          if (sameSession()) setSaveState(current => ({ ...current, lastFailure: toFailure(failure instanceof Error ? failure.message : String(failure), new Date(), checkpointKept) }));
          throw failure;
        }
        // Update only this frozen session; a later failure must not leave a stale hash.
        if (sameSession()) { setDocument(next); setDirty(false); setSaveState({ lastSuccessAt: new Date().toISOString() }); }
        await window.writer.completeDraft(target.projectId, sessionId, version);
      }
      if (targetNotes) { const next = await window.writer.saveNotes(targetNotes.value.projectId, targetNotes.value, targetNotes.hash); if (activeIdRef.current === next.value.projectId) { setNotes(next); setNotesDirty(false); } }
      if (active) {
        const sync = await window.writer.synchronizeMaterials({ projectId: active.id });
        if (sync.status !== 'clean' && sync.status !== 'disabled') {
          setMaterialSyncProject(active.id);
          throw new Error(`固定资料同步需要处理：${sync.message}`);
        }
        if (sync.status === 'clean') synchronized = sync;
      }
      await window.writer.finishSaveExit(token);
    } catch (e) {
      if (token) await window.writer.cancelSaveExit(token).catch(() => {});
      if (synchronized) await refreshMaterials(synchronized).catch(() => {});
      setError(`保存并退出未完成，窗口与未保存修改保留：${e instanceof Error ? e.message : String(e)}`);
      setMessage('请核对提示后重新保存退出'); setExiting(false);
    } finally { pending.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!dirty || !document?.managed || !draft.current) return;
    const request = { projectId: document.projectId, path: document.path, expectedHash: document.hash, content: structuredClone(draft.current) };
    const id = draftId.current, version = draftVersion.current;
    const sameSession = () => draftId.current === id && documentRef.current?.projectId === request.projectId && documentRef.current.path === request.path;
    const checkpointTimer = setTimeout(() => {
      if (!sameSession()) return;
      void window.writer.checkpointDraft({ ...request, id, revision: version }).then(() => { if (sameSession() && draftVersion.current === version) setCheckpointStatus('本机草稿已暂存'); }).catch(() => { if (sameSession() && draftVersion.current === version) setCheckpointStatus('本机暂存失败，请立即手动保存或另存'); });
    }, 2000);
    const autoTimer = autoSave && !autoStopped ? setTimeout(async () => {
      if (!sameSession() || draftVersion.current !== version || pending.current) return;
      pending.current = true; setAutoSaving(true);
      let checkpointKept = false;
      try {
        await window.writer.checkpointDraft({ ...request, id, revision: version }); checkpointKept = true;
        if (!sameSession()) return;
        const next = await window.writer.saveChapter(request);
        if (sameSession()) {
          setDocument(current => current && current.projectId === request.projectId && current.path === request.path ? { ...current, hash: next.hash } : current);
          setSaveState({ lastSuccessAt: new Date().toISOString(), unsaved: draftVersion.current !== version });
          if (draftVersion.current === version) { setDirty(false); setMessage('正文已自动保存'); }
        }
        await window.writer.completeDraft(request.projectId, id, version).catch(() => { if (sameSession()) setCheckpointStatus('正文已保存，本机草稿状态未更新'); });
      } catch (e) { if (sameSession()) { setAutoStopped(true); setSaveState(current => ({ ...current, lastFailure: toFailure(e instanceof Error ? e.message : String(e), new Date(), checkpointKept) })); setError(`自动保存已停止${checkpointKept ? '，正文草稿已暂存' : '，本机暂存未确认'}：${String(e)}`); } }
      finally { pending.current = false; setAutoSaving(false); }
    }, 5000) : undefined;
    return () => { clearTimeout(checkpointTimer); clearTimeout(autoTimer); };
  }, [dirty, revision, document?.projectId, document?.path, document?.hash, autoSave, autoStopped, busy]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); if (view === 'writer' && !orderProject && !fidelityTarget && !worldCardTarget && !busy && document?.managed) void run(save);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  });

  const activeBook = active ? books[active.id] : undefined;
  const activeVolume = activeBook?.value.volumes.find(v => v.id === volume);
  const openBook = (project: Project) => { if (project.id === active?.id) setView('writer'); else if (discard()) void run(() => selectProject(project)); };
  return <div className="app-shell" inert={exiting} aria-busy={exiting}>
    {materialSyncProject && <MaterialSyncPanel key={materialSyncProject} projectId={materialSyncProject}
      title={projects.find(project => project.id === materialSyncProject)?.name ?? '当前小说'} blocked={busy || autoSaving}
      onBeforeSync={beforeMaterialSync} onBusy={setMaterialSyncBusy} onSynchronized={refreshMaterials}
      onClose={() => setMaterialSyncProject(null)} />}
    {fidelityTarget && <FidelityCopyEditor key={`${fidelityTarget.projectId}:${fidelityTarget.path}:${fidelityTarget.hash}`} target={fidelityTarget} blocked={busy || autoSaving} onDirty={setFidelityDirty} onSaveExit={saveAndExit}
      onClose={() => { setFidelityTarget(null); setFidelityDirty(false); }} onSaved={async (target, result) => {
        try { const files = await window.writer.chapters(target.projectId); if (activeIdRef.current === target.projectId) setChapters(files); }
        catch (failure) { if (activeIdRef.current === target.projectId) setError(`副本已保存，但章节目录刷新失败：${String(failure)}`); }
        if (activeIdRef.current === target.projectId && documentRef.current?.projectId === target.projectId && documentRef.current.path === target.path && documentRef.current.hash === target.hash) setMessage(`已另存保真副本：${result.path}`);
        setFidelityTarget(current => current?.projectId === target.projectId && current.path === target.path && current.hash === target.hash ? null : current);
      }} />}
    {conflictOpen && <ConflictCompare projectId={active?.id ?? ''} document={document} conflicts={syncConflicts} blocked={busy || autoSaving} onClose={() => setConflictOpen(false)} />}
    {discussionOpen && <DiscussionPanel projectId={discussionOpen} connections={connections} blocked={busy || autoSaving} onClose={() => setDiscussionOpen(null)} />}
    {connectOpen && <QuickConnectPanel blocked={busy} onDone={() => void window.writer.aiConnections().then(snapshot => setConnections(snapshot.connections))} onClose={() => setConnectOpen(false)} />}
    {keysOpen && <KeyStatusPanel onClose={() => setKeysOpen(false)} onRecovered={() => void window.writer.aiConnections().then(snapshot => setConnections(snapshot.connections))} />}
    {nasOpen && <NasPanel projectId={active?.id} onClose={() => setNasOpen(false)} />}
    {styleHistoryOpen && <StyleHistoryPanel key={styleHistoryOpen} projectId={styleHistoryOpen} styles={activeBook?.value.styles.map(style => ({ id: style.id, name: style.name, rules: style.rules })) ?? []} blocked={busy || autoSaving} onClose={() => setStyleHistoryOpen(null)} />}
    {macroOpen && <MacroPanel key={macroOpen} projectId={macroOpen} sampleText={document && typeof document.content !== 'string' ? copyableText(document.content).split('\n')[0] ?? '' : ''} blocked={busy || autoSaving} onClose={() => setMacroOpen(null)} />}
    {worldOpen && <WorldInfoPanel key={worldOpen} projectId={worldOpen} initialBook={worldInitialBook} sampleText={document?.projectId === worldOpen && typeof document.content !== 'string' ? copyableText(document.content) : ''} blocked={busy || autoSaving} onMappingDirty={setMappingDirty} onMappingBusy={setMappingBusy} onPluginBusy={setPluginBusy} onClose={() => { if (!mappingDirty && !mappingBusy && !pluginBusy) { setWorldOpen(null); setInspectorRevision(value => value + 1); } }} />}
    {worldCardTarget && <WorldCardEditor key={`${worldCardTarget.projectId}:${worldCardTarget.book}:${worldCardTarget.entryId}:${worldCardTarget.expectedHash}`} target={worldCardTarget} onClose={() => { setWorldCardTarget(null); setInspectorRevision(value => value + 1); }} onSaved={(projectId, book, cleanupError) => { setWorldCardTarget(null); if (activeIdRef.current === projectId) { setInspectorRevision(value => value + 1); setMessage(`已保存「${book}」设定卡，原世界书已备份`); if (cleanupError) setError(`设定卡已保存，但本机草稿未清除，请核对：${cleanupError}`); } }} />}
    {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}
    {updateOpen && <UpdatePanel currentVersion={updateVersion} onCheck={token => window.writer.checkUpdate(token || undefined)} onOpenPage={() => window.writer.openUpdatePage()} onClose={() => setUpdateOpen(false)} />}
    {sceneOpen && <SceneAnalysisPanel document={document} title={chapters.find(chapter => chapter.path === document?.path)?.name ?? '当前章节'} onClose={() => setSceneOpen(false)} />}
    {trialOpen && <StyleTrialPanel key={trialOpen} projectId={trialOpen} connections={connections} styles={activeBook?.value.styles.map(style => ({ id: style.id, name: style.name })) ?? []} blocked={busy || autoSaving} onClose={() => setTrialOpen(null)} />}
    {blueprintOpen && <BlueprintPanel key={blueprintOpen} projectId={blueprintOpen} volumes={activeBook?.value.volumes.map(volume => ({ id: volume.id, title: volume.title })) ?? []} chapters={chapters} blocked={busy || autoSaving} onDirty={setOrderDirty} onClose={() => setBlueprintOpen(null)} />}
    {promptsOpen && <PromptLibraryPanel key={promptsOpen} projectId={promptsOpen} blocked={busy || autoSaving} onDirty={setOrderDirty} onClose={() => setPromptsOpen(null)}
      onFill={text => { setFillInstruction({ text, token: Date.now() }); setView('ai-writer'); setPromptsOpen(null); }} />}
    {statesOpen && <StatesPanel key={statesOpen} projectId={statesOpen} chapters={chapters} currentPosition={Math.max(0, chapters.findIndex(chapter => chapter.path === document?.path) + 1)} blocked={busy || autoSaving} onDirty={setOrderDirty} onClose={() => setStatesOpen(null)} />}
    {relationsOpen && <RelationsPanel key={relationsOpen} projectId={relationsOpen} blocked={busy || autoSaving} onDirty={setOrderDirty} onClose={() => setRelationsOpen(null)} />}
    {timelineOpen && <TimelinePanel key={timelineOpen} projectId={timelineOpen} chapters={chapters} blocked={busy || autoSaving}
      onDirty={setOrderDirty} onClose={() => setTimelineOpen(null)}
      onOpenChapter={async chapterPath => {
        if (!active) return;
        const files = await window.writer.chapters(active.id);
        const target = files.find(chapter => chapter.path === chapterPath);
        if (!target) { setError('关联章节已不存在，可能被移动或删除'); return; }
        loadDocument(await window.writer.readChapter(active.id, target.path));
        setChapters(files); setView('writer'); setTimelineOpen(null);
      }} />}
    {replaceProject && <BookReplacePanel key={replaceProject} projectId={replaceProject} blocked={busy || autoSaving}
      onDirty={setOrderDirty} onClose={() => setReplaceProject(null)}
      onDone={async () => { if (active) { setChapters(await window.writer.chapters(active.id)); const fresh = document ? await window.writer.readChapter(active.id, document.path).catch(() => null) : null; if (fresh) { setDocument(current => current && current.path === fresh.path ? fresh : current); setDirty(false); } } }} />}
    {orderProject && <ChapterOrder key={orderProject} projectId={orderProject} blocked={busy || autoSaving} onDirty={setOrderDirty} onClose={() => setOrderProject(null)} onSave={async (paths, hash) => {
      if (pending.current || autoSaving) throw new Error('正在保存其他内容，请稍后再试');
      const targetId = orderProject; pending.current = true; setBusy(true);
      try {
        const next = await window.writer.saveChapterOrder(targetId, paths, hash);
        if (activeIdRef.current === targetId) { setChapters(next.entries.filter(entry => entry.present).map(({ path, name }) => ({ path, name }))); setMessage('章节顺序已保存，正文内容保留'); }
        setOrderProject(current => current === targetId ? null : current); return next;
      } finally { pending.current = false; setBusy(false); }
    }} />}
    {renameTarget && <ChapterRename key={renameTarget.projectId + ':' + renameTarget.path} target={renameTarget} displayName={chapters.find(chapter => chapter.path === renameTarget.path)?.name ?? renameTarget.path.split(/[\\/]/).at(-1) ?? ''} onClose={() => setRenameTarget(null)} onRename={async (name, mode, namesHash) => {
      if (pending.current || dirty || notesDirty || auxDirty || charactersDirty || materialsDirty || detectionDirty || planningDirty || memoryDirty || autoSaving) throw new Error('请先保存当前修改，再重命名');
      const target = renameTarget; pending.current = true; setBusy(true);
      try {
        if (mode === 'display') {
          await window.writer.setChapterDisplayName({ projectId: target.projectId, path: target.path, expectedChapterHash: target.hash, expectedNamesHash: namesHash, name });
          const files = await window.writer.chapters(target.projectId);
          if (activeIdRef.current === target.projectId) { setChapters(files); setChapterNamesError(''); setMessage(name ? '本机章节显示名已更新，正文文件名未改变' : '已恢复显示章节文件名'); }
          setRenameTarget(null); return;
        }
        const next = await window.writer.renameChapter({ projectId: target.projectId, path: target.path, expectedHash: target.hash, name });
        const [files, book] = await Promise.all([window.writer.chapters(target.projectId), window.writer.readBook(target.projectId)]);
        updateBook(book);
        if (activeIdRef.current === target.projectId) { loadDocument(next); setChapters(files); setMessage('章节已重命名，原稿归档保留'); }
      } finally { pending.current = false; setBusy(false); }
    }} />}
    <header className="topbar">
      <div className="brand"><span className="brand-icon" aria-hidden="true"><img src={appIconUrl} alt="" /></span><div>星序<small>starwriting</small><span className="app-version" data-testid="app-version">版本 {updateVersion || (versionUnavailable ? '不可用' : '读取中…')}</span></div></div>
      <nav className="main-nav" aria-label="主要页面"><button className={view === 'shelf' ? 'active' : ''} disabled={busy} onClick={() => setView('shelf')}><NavIcon type="shelf" />我的书架</button><button className={view === 'writer' ? 'active' : ''} disabled={busy || !active} onClick={() => setView('writer')}><NavIcon type="writer" />写作空间</button><button className={view === 'characters' ? 'active' : ''} disabled={busy || !active} onClick={() => { if (!charactersDirty) setCharacterRevision(value => value + 1); setView('characters'); }}><NavIcon type="people" />角色库</button><button className={view === 'styles' ? 'active' : ''} disabled={busy} onClick={() => setView('styles')}><NavIcon type="style" />文风研习室</button></nav>
      <div className="project-heading">{activeBook?.value.title ?? active?.name ?? ''}</div>
      <button className={`topbar-model ${view === 'ai-settings' ? 'active' : ''}`} onClick={() => setView('ai-settings')}><NavIcon type="model" />模型设置</button>
      <MoreMenu>
      <div className="more-group" role="group" aria-label="创作工具"><span className="more-group-title">创作工具</span>
      <button className={view === 'planning' ? 'active' : ''} disabled={!active || busy} onClick={() => setView('planning')}>创作筹备</button>
      <button disabled={!active || busy} onClick={() => setView('materials')}>资料转换</button>
      <button className={view === 'knowledge' ? 'active' : ''} disabled={!active || busy} onClick={() => setView('knowledge')}>知识检索</button>
      </div>
      <div className="more-group" role="group" aria-label="检查与统计"><span className="more-group-title">检查与统计</span>
      <button disabled={!active || busy} onClick={() => setView('detection')}>朱雀检测</button>
      <button data-testid="usage-open" onClick={() => setUsageOpen(true)}>用量统计</button>
      </div>
      <div className="more-group" role="group" aria-label="应用"><span className="more-group-title">应用</span>
      <button data-testid="update-open" disabled={exiting} onClick={() => { setUpdateOpen(true); void window.writer.updateVersion().then(version => { if (typeof version === 'string' && version.trim() && version.length <= 128) { setUpdateVersion(version); setVersionUnavailable(false); } else { setVersionUnavailable(true); } }).catch(() => { setVersionUnavailable(true); setError('无法读取当前版本，请重启应用后重试'); }); }}>检查更新</button>
      </div>
      </MoreMenu>
      <button className="save-exit" disabled={busy || autoSaving || exiting || materialSyncBusy || mappingBusy || pluginBusy} onClick={() => void saveAndExit()}>保存并退出</button>
      <button className="primary" disabled={busy || autoSaving} onClick={() => {
        if (!discard()) return;
        void run(async () => { const p = await window.writer.openProject(); if (p) { removedProjects.current.delete(p.id); setShelfMessage(''); setProjects(await window.writer.listProjects()); await selectProject(p); } });
      }}>＋ 打开小说文件夹</button>
    </header>
    {view !== 'writer' && error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    {capability && <div className="notice" role="status">这份 DOCX 有 {capability.risks.length} 类内容不会随编辑保留：{capability.risks.slice(0, 2).map(text => text.split('：')[0]).join('、')}{capability.risks.length > 2 ? ' 等' : ''}。<details><summary>查看详情</summary><p>{capability.preserved}</p><ul>{capability.risks.map(text => <li key={text}>{text}</li>)}</ul><p>原文件不会被修改；需要完整排版时请用 Word/WPS 打开原稿。</p></details><button onClick={() => setCapability(null)}>知道了</button></div>}
    {externalPaths.length > 0 && <div className="notice" role="status">检测到章节文件变化（可能来自本应用或其他程序）：{externalPaths.slice(0, 4).join('、')}{externalPaths.length > 4 ? ' 等' : ''}。当前打开的章节如被其他程序改动，保存前会提示版本冲突，不会直接覆盖。<button onClick={() => void run(async () => { if (!active) return; setChapters(await window.writer.chapters(active.id)); setExternalPaths([]); setMessage('已刷新章节列表；打开的正文未重新读取'); })}>刷新章节列表</button><button onClick={() => setExternalPaths([])}>忽略</button></div>}
    {syncConflicts.length > 0 && <div className="notice" role="status">检测到同步冲突副本 {syncConflicts.length} 个（{syncConflicts.slice(0, 3).map(item => item.baseName).join('、')}{syncConflicts.length > 3 ? ' 等' : ''}）。应用不会自动合并或删除，请人工核对后再处理。<button data-testid="conflict-open" onClick={() => setConflictOpen(true)}>并排对照…</button><button onClick={() => setSyncConflicts([])}>知道了</button></div>}
    <div className="full-view" hidden={view !== 'ai-settings'}><AISettings onDirty={setAISettingsDirty} onSaved={setConnections} /></div>
    <div className="full-view" hidden={view !== 'knowledge'}>{active && <KnowledgeSearch key={`${active.id}:${materialRevision}`} projectId={active.id} title={activeBook?.value.title ?? active.name} hasUnsaved={dirty || notesDirty || auxDirty || charactersDirty || planningDirty || memoryDirty || materialsDirty} onBusy={setKnowledgeBusy} citationHits={citationSelection?.projectId === active.id ? citationSelection.hits : []} onCitationHits={setCitations} onOpenWriter={() => setView('ai-writer')}
      onOpenHit={async hit => { if (!active) return; if (dirty) { setError('当前章节有未保存内容，请先保存再跳转'); return; } await run(async () => {
        const files = await window.writer.chapters(active.id);
        const wanted = hit.sourcePath.replace(/^[a-z-]+:/iu, '');
        const target = files.find(chapter => chapter.path === wanted || chapter.path.endsWith(wanted));
        if (!target) throw new Error('未找到该章节，可能已被移动或重命名');
        loadDocument(await window.writer.readChapter(active.id, target.path)); setChapters(files); setView('writer');
        setJump({ text: hit.text, token: Date.now() }); setMessage(`已打开 ${hit.sourceLabel}，光标定位到命中的段落`);
      }); }} />}</div>
    <div className="full-view" hidden={view !== 'confirmations'}>{active && <ChapterConfirmations key={`${active.id}:${materialRevision}`} projectId={active.id} title={activeBook?.value.title ?? active.name} visible={view === 'confirmations'} hasUnsaved={dirty} onBusy={setConfirmationBusy} />}</div>
    <div className="full-view" hidden={view !== 'recovery'}>{active && view === 'recovery' && <Recovery key={`${active.id}:${materialRevision}`} projectId={active.id} blocked={dirty || busy || autoSaving} onRestored={async next => { const files = await window.writer.chapters(next.projectId); if (activeIdRef.current === next.projectId) { loadDocument(next); setChapters(files); setView('writer'); setMessage('已恢复为新 DOCX，原文件保留'); } }} />}</div>
    <div className="full-view" hidden={view !== 'memories'}>{active && <Memories key={`${active.id}:${materialRevision}`} projectId={active.id} manuscript={document} connections={connections} blocked={dirty || busy} onDirty={setMemoryDirty} />}</div>
    <div className="full-view" hidden={view !== 'planning'}>{active && <Planning key={`${active.id}:${materialRevision}`} projectId={active.id} connections={connections} blocked={dirty || notesDirty || auxDirty || charactersDirty || materialsDirty || busy} onDirty={setPlanningDirty} onSaved={async id => { const next = await window.writer.readNotes(id); if (activeIdRef.current === id) { setNotes(next); setNotesDirty(false); setCharacterRevision(value => value + 1); } }} />}</div>
    <div className="full-view" hidden={view !== 'materials'}>{active && <Materials key={`${active.id}:${materialRevision}`} projectId={active.id} connections={connections} blocked={dirty || notesDirty || auxDirty || charactersDirty || busy} onDirty={setMaterialsDirty} onSaved={async id => { const next = await window.writer.readNotes(id); if (activeIdRef.current === id) { setNotes(next); setNotesDirty(false); setCharacterRevision(value => value + 1); } }} />}</div>
    <div className="full-view" hidden={view !== 'detection'}>{active && <Detection key={`${active.id}:${materialRevision}`} projectId={active.id} manuscript={document} blocked={dirty || notesDirty || busy} visible={view === 'detection'} onDirty={setDetectionDirty} onOpenSettings={() => setView('ai-settings')} />}</div>
    <div className="full-view" hidden={view !== 'ai-writer'}>{active && <AIWriter key={`${active.id}:${materialRevision}`} projectId={active.id} title={activeBook?.value.title ?? active.name} manuscript={document} blocked={dirty || notesDirty || auxDirty || charactersDirty || busy} connections={connections} onSettings={() => setView('ai-settings')} citationHits={citationSelection?.projectId === active.id ? citationSelection.hits : []} onClearCitations={() => setCitations(active.id, [])} onKnowledge={() => setView('knowledge')} fill={fillInstruction} onExport={async id => { const files = await window.writer.chapters(id); if (activeIdRef.current === id) setChapters(files); }} />}</div>
    <div className="full-view" hidden={view !== 'shelf'}>{folderRenameIssue && <div className="error" role="alert">文件夹改名需要核对：{folderRenameIssue}。操作记录及原文件已保留。</div>}{shelfMessage && <div className="notice" role="status" data-testid="shelf-removal-notice">{shelfMessage}<button onClick={() => setShelfMessage('')}>知道了</button></div>}<Shelf projects={projects} books={books} busy={busy || autoSaving || exiting || shelfLoading} onOpen={openBook} onSave={persistBook} onRemove={removeBook} onRenameFolder={renameBookFolder} onCreate={async (parent, title, firstChapter, extra) => {
      const created = await window.writer.createProject(parent, title, firstChapter);
      if (extra.introduction.trim() || extra.coverBase64) await window.writer.initializeBook(created.project.id, { introduction: extra.introduction, coverBase64: extra.coverBase64 });
      setProjects(await window.writer.listProjects());
      await selectProject(created.project);
      return { root: created.root };
    }} /></div>
    {importPlan && active && <ImportPreview plan={importPlan} volumes={(activeBook?.value.volumes ?? []).map(item => ({ id: item.id, title: item.title }))} busy={busy || autoSaving} onCancel={() => setImportPlan(null)} onConfirm={async (decisions, volumeId) => {
      const result = await window.writer.commitChaptersImport(active.id, importPlan.token, decisions);
      setImportPlan(null);
      setChapters(await window.writer.chapters(active.id));
      if (volumeId && result.imported.length && activeBook) await persistBook(active.id, { ...activeBook.value, volumes: activeBook.value.volumes.map(item => item.id === volumeId ? { ...item, chapters: [...new Set([...item.chapters, ...result.imported.map(entry => entry.path)])] } : item) }, activeBook.hash);
      const skipped = result.skipped.length ? `；跳过 ${result.skipped.length} 个：${result.skipped.slice(0, 3).map(item => `${item.name}（${item.reason}）`).join('、')}` : '';
      setMessage(`已导入 ${result.imported.length} 个章节副本${skipped}`);
    }} />}
    {trash && active && <div className="modal-overlay"><section className="book-modal" role="dialog" aria-modal="true" aria-label="章节回收站" data-testid="trash-panel" style={{ width: 620, height: 'auto', maxHeight: '80vh', overflowY: 'auto', padding: '20px 24px' }}>
      <header><div><h2>章节回收站</h2><p>删除的章节只移到本书《小说资料/trash》，恢复时不覆盖现有文件。</p></div><button onClick={() => setTrash(null)}>关闭</button></header>
      {!trash.length && <p role="status">回收站是空的。</p>}
      {trash.map(item => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--line, #2a2f3a)' }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.originalPath}>{item.originalPath}</span>
        <span style={{ opacity: 0.7 }}>{new Date(item.deletedAt).toLocaleString('zh-CN')}</span>
        <button data-testid={`trash-restore-${item.id}`} disabled={busy || autoSaving} onClick={() => void run(async () => {
          const restored = await window.writer.restoreTrashedChapter(active.id, item.id);
          setChapters(await window.writer.chapters(active.id));
          setTrash(await window.writer.trashedChapters(active.id));
          setMessage(`已恢复：${restored.path}`);
        })}>恢复</button>
      </div>)}
    </section></div>}
    <div className="full-view" hidden={view !== 'characters'}>{active && <Characters key={`${active.id}:${characterRevision}`} projectId={active.id} title={activeBook?.value.title ?? active.name} legacyNotes={notes?.value.characters ?? ''} manuscriptDirty={dirty || autoSaving || fidelityDirty} onDirty={setCharactersDirty} onOpenWorld={(projectId, name) => { if (activeIdRef.current === projectId) { setWorldInitialBook(name); setWorldOpen(projectId); } }} />}</div>
    <div className="full-view" hidden={view !== 'styles'}>{activeBook ? <StyleStudio key={`${activeBook.value.projectId}:${materialRevision}`} snapshot={activeBook} connections={connections} legacyNotes={notes?.value.style ?? ''} onUpdate={updateBook} onSave={persistBook} onDirty={setAuxDirty} /> : <div className="empty-library"><h1>文风研习室</h1><p>先在书架打开一本小说，再为它导入参考文本、建立不同的文风档案。</p><button onClick={() => setView('shelf')}>前往书架</button></div>}</div>
    <div className="workspace" style={{ display: view === 'writer' ? undefined : 'none' }}>
      <aside className="sidebar">
        <div className="section-label">书库 <span>{projects.length}</span></div>
        <div className="book-list">{projects.map(project => <button key={project.id} className={`book ${active?.id === project.id ? 'selected' : ''}`} disabled={busy || autoSaving} onClick={() => {
          if (project.id !== active?.id && discard()) void run(() => selectProject(project));
        }}><span className="book-icon">▤</span><span>{books[project.id]?.value.title ?? project.name}<small>独立小说空间</small></span></button>)}</div>
        {!projects.length && <p className="muted sidebar-tip">每本小说选择一个独立文件夹。设定另存于应用的创作资料目录。</p>}
        <div className="section-label chapter-label">章节 <button title="重新扫描文件夹" disabled={!active || busy} onClick={() => void run(async () => { if (active) { setChapters(await window.writer.chapters(active.id)); void window.writer.listSyncConflicts(active.id).then(setSyncConflicts).catch(() => setSyncConflicts([])); } })}>↻</button></div>
        {chapterNamesError && <p role="alert" className="sidebar-tip">章节显示名无法读取，已显示文件名；原资料已保留。{chapterNamesError}</p>}
        {activeBook && <select className="volume-select" aria-label="查看分集" value={volume} disabled={busy} onChange={e => setVolume(e.target.value)}><option value="">全部章节</option>{activeBook.value.volumes.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select>}
        {activeVolume && <div className="volume-preview"><BookCover small title={activeVolume.title} src={activeBook?.covers[activeVolume.cover]} /><p>{activeVolume.introduction || '本集尚未填写引言'}</p></div>}
        <select className="volume-select" aria-label="新章节格式" value={newFormat} onChange={e => setNewFormat(e.target.value as 'docx' | 'txt')}><option value="docx">DOCX（默认）</option><option value="txt">TXT（纯文本）</option></select>
        <button className="new-chapter" disabled={!active || busy || autoSaving} onClick={() => {
          if (!discard()) return;
          void run(async () => { if (active) { const next = await window.writer.createChapter(active.id, newFormat); loadDocument(next); setChapters(await window.writer.chapters(active.id)); if (activeBook && volume) await persistBook(active.id, { ...activeBook.value, volumes: activeBook.value.volumes.map(v => v.id === volume ? { ...v, chapters: [...v.chapters, next.path] } : v) }, activeBook.hash); setMessage(`已新建 ${newFormat.toUpperCase()} · 宋体五号`); } });
        }}>＋ 新建 {newFormat.toUpperCase()} 章节</button>
        <button className="import-chapters" data-testid="import-chapters" disabled={!active || busy || autoSaving} onClick={() => {
          if (!discard()) return;
          void run(async () => {
            if (!active) return;
            const plan = await window.writer.planChaptersImport(active.id);
            if (!plan.items.length) {
              setMessage(plan.skipped.length ? `没有可导入的文件：${plan.skipped.slice(0, 3).map(item => `${item.name}（${item.reason}）`).join('、')}` : '未选择章节文件');
              return;
            }
            setImportPlan(plan);
          });
        }}>导入章节…</button>
        <button className="import-chapters" data-testid="import-split" disabled={!active || busy || autoSaving} onClick={() => {
          if (!discard()) return;
          void run(async () => {
            if (!active) return;
            const plan = await window.writer.planTextSplit(active.id);
            if (!plan.items.length) { setMessage('未选择整本 TXT'); return; }
            setImportPlan(plan);
            setMessage(`${plan.rule}：共 ${plan.items.length} 章，可在预览里改名或排除`);
          });
        }}>整本 TXT 拆章…</button>
        <button className="import-chapters" data-testid="delete-chapter" disabled={!active || !document || busy || autoSaving} onClick={() => {
          if (!active || !document) return;
          if (!window.confirm(`把「${document.path}」移到本书回收站？原文件会保留，可随时恢复。`)) return;
          void run(async () => {
            const record = await window.writer.deleteChapter(active.id, document.path, document.hash);
            const files = await window.writer.chapters(active.id);
            setChapters(files);
            if (activeBook) {
              const volumes = activeBook.value.volumes.map(volume => ({ ...volume, chapters: volume.chapters.filter(item => item !== document.path) }));
              await persistBook(active.id, { ...activeBook.value, volumes }, activeBook.hash);
            }
            loadDocument(null);
            setMessage(`已移到回收站：${record.name}（可在「章节回收站」恢复）`);
          });
        }}>删除当前章节…</button>
        <button className="import-chapters" data-testid="open-trash" disabled={!active || busy || autoSaving} onClick={() => {
          if (!active) return;
          void run(async () => { setTrash(await window.writer.trashedChapters(active.id)); });
        }}>章节回收站…</button>
        <div className="chapter-list">{chapters.filter(chapter => !activeVolume || activeVolume.chapters.includes(chapter.path)).map(chapter => <button title={chapter.path} key={chapter.path} disabled={busy || autoSaving} className={document?.path === chapter.path ? 'current' : ''} onClick={() => {
          if (!discard()) return;
          void run(async () => { if (active) { loadDocument(await window.writer.readChapter(active.id, chapter.path)); setMessage('已读取 DOCX 文件'); } });
        }}><span className="chapter-icon" aria-hidden="true">▧</span><span className="chapter-name">{chapter.name}</span></button>)}</div>
        <details className="sidebar-tools" open><summary>创作与文件工具</summary><div className="sidebar-tools-content">
        <label className="autosave-toggle"><input type="checkbox" aria-label="自动保存正文" checked={autoSave} disabled={autoSaving} onChange={e => { setAutoSave(e.target.checked); setAutoStopped(false); localStorage.setItem('autosave-manuscript', String(e.target.checked)); }} />自动保存正文（空闲 5 秒）</label>
        <button disabled={!active || busy || autoSaving} onClick={() => setView('recovery')}>恢复本书草稿</button>
        <button disabled={!active || busy || autoSaving} onClick={() => setView('confirmations')}>正文版本确认</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setOrderProject(active.id); }}>章节排序</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setTimelineOpen(active.id); }}>故事时间线…</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setRelationsOpen(active.id); }}>人物关系…</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setStatesOpen(active.id); }}>人物状态…</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setPromptsOpen(active.id); }}>提示词库…</button>
        <button disabled={!active || busy || autoSaving || !activeBook?.value.styles.length} title={activeBook?.value.styles.length ? '同一剧情用不同文风各写一版并比较' : '先在文风研习室学到至少两个文风'} onClick={() => { if (active) setTrialOpen(active.id); }}>文风试写比较…</button>
        <button data-testid="scene-open" disabled={!active || busy || autoSaving || !document} title={document ? '对当前章节做场景专项分析' : '先打开一个章节'} onClick={() => setSceneOpen(true)}>场景分析…</button>
        <button data-testid="world-open" disabled={!active || busy || autoSaving || worldCardActionBusy} title="查看设定卡片、导入世界书并检查当前章节触发" onClick={() => { if (active) { setWorldInitialBook(''); setWorldOpen(active.id); } }}>世界书…</button>
        <button data-testid="export-chapter" disabled={!active || busy || autoSaving || !document} title="把当前章节导出为 Markdown（不覆盖已有文件）" onClick={() => {
          if (!active || !document) return;
          void window.writer.exportChapterText(active.id, document.path, 'md').then(result => { if (result) setMessage(`已导出 ${result.paragraphs} 段、${result.characters} 字到 ${result.file}`); }).catch((error: unknown) => setError(String(error instanceof Error ? error.message : error)));
        }}>导出本章 MD…</button>
        <button data-testid="save-badge" className={`badge ${describeSaveBadge(saveState).tone}`} title={describeSaveBadge(saveState).detail}
          disabled={describeSaveBadge(saveState).tone !== 'danger'}
          onClick={() => { if (active) setView('recovery'); }}>{describeSaveBadge(saveState).label}</button>
        <button data-testid="fidelity-open" disabled={!active || busy || autoSaving || !document || document.managed || !/\.docx$/iu.test(document.path)} title="编辑外部 Word 原稿的正文段落，另存保留结构的新副本" onClick={() => {
          if (!document || document.managed || !/\.docx$/iu.test(document.path)) return;
          setFidelityTarget({ projectId: document.projectId, path: document.path, hash: document.hash });
        }}>另存保真副本…</button>
        <button data-testid="discussion-open" disabled={!active || busy || autoSaving} onClick={() => { if (active) { void window.writer.aiConnections().then(snapshot => setConnections(snapshot.connections)); setDiscussionOpen(active.id); } }}>与模型讨论…</button>
        <button data-testid="connect-open" className="primary" onClick={() => setConnectOpen(true)}>接入 API…</button>
        <button data-testid="keys-open" onClick={() => setKeysOpen(true)}>密钥状态…</button>
        <button data-testid="nas-open" onClick={() => setNasOpen(true)}>文件夹与备份…</button>
        <button data-testid="material-sync-open" disabled={!active || busy || autoSaving || materialSyncBusy} onClick={() => { if (active) setMaterialSyncProject(active.id); }}>固定资料同步…</button>
        <button data-testid="macro-open" disabled={!active || busy || autoSaving} title="展开酒馆宏并预览正则脚本效果" onClick={() => { if (active) setMacroOpen(active.id); }}>宏与正则…</button>
        <button data-testid="style-history-open" disabled={!active || busy || autoSaving || !activeBook?.value.styles.length} title={activeBook?.value.styles.length ? '查看文风规则版本与效果记录' : '先在文风研习室建立文风档案'} onClick={() => { if (active) setStyleHistoryOpen(active.id); }}>文风版本与效果…</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setBlueprintOpen(active.id); }}>分卷与章节蓝图…</button>
        <button disabled={!active || busy || autoSaving} onClick={() => { if (active) setReplaceProject(active.id); }}>整书替换…</button>
        <button disabled={!active || !document || busy || autoSaving || dirty} title={dirty ? '请先保存当前章节' : '把当前章节移动到本书内的另一个文件夹'} onClick={() => void run(async () => {
          if (!active || !document) return;
          const moved = await window.writer.moveChapter({ projectId: active.id, path: document.path, expectedHash: document.hash, folder: '' });
          setChapters(await window.writer.chapters(active.id));
          loadDocument(await window.writer.readChapter(active.id, moved));
          setMessage(`已移动到 ${moved}；旧路径仍可追溯，摘要与确认不会丢来源`);
        })}>移动当前章节…</button>
        </div></details>
        <div className="local-note"><span className="dot" />文件直接保存在所选目录<small>NAS / 网盘账号直连：未开放</small></div>
      </aside>
      <main className="editor-area">
        <div className="document-header"><div><small>{active ? '当前小说 / 正文' : '欢迎回来'}</small><h1>{(document && (chapters.find(chapter => chapter.path === document.path)?.name ?? document.path.split(/[\\/]/).at(-1))) ?? '给故事一个开始'}</h1></div>
          <div className="actions"><button disabled={!document || dirty || notesDirty || auxDirty || charactersDirty || materialsDirty || detectionDirty || planningDirty || memoryDirty || busy || autoSaving} onClick={() => { if (document) setRenameTarget(document); }}>重命名</button><button disabled={!document || busy || !draft.current} onClick={() => void run(async () => {
            if (draft.current) { await window.writer.copyText(copyableText(draft.current)); setMessage('正文已复制，包含两个全角段首空格'); }
          })}>复制正文</button><button disabled={!document || busy || !draft.current} onClick={() => void run(async () => {
            if (document && draft.current && active) { loadDocument(await window.writer.copyChapter(document.projectId, draft.current)); setChapters(await window.writer.chapters(active.id)); setMessage('已另存 DOCX 副本'); }
          })}>另存副本</button><button disabled={!document || busy || !draft.current} onClick={() => void run(async () => { if (document && draft.current && active) { loadDocument(await window.writer.copyChapter(document.projectId, draft.current, 'txt')); setChapters(await window.writer.chapters(active.id)); setMessage('已另存 UTF-8 TXT 副本'); } })}>另存 TXT</button><button className="primary" disabled={!dirty || busy || !document?.managed} onClick={() => void run(save)}>保存 {document?.path.toLowerCase().endsWith('.txt') ? 'TXT' : 'DOCX'}</button></div>
        </div>
        {error && <div role="alert" className="error">{error}<button onClick={() => setError('')}>关闭</button></div>}
        {document?.warnings.map((warning, index) => <div className="notice" key={index}>{warning}</div>)}
        {document ? <ManuscriptEditor key={`${document.projectId}:${document.path}:${editorSession}`} content={document.content} active={view === 'writer'} plainText={document.path.toLowerCase().endsWith('.txt')} disabled={busy || !document.managed} onMakeEditable={!document.managed && !busy ? () => {
          const source = documentRef.current, content = draft.current && structuredClone(draft.current);
          if (!source || !content || source.managed) return;
          if (!window.confirm('将当前基础文字另存为可编辑的 DOCX 副本，原文件保留。复杂表格、图片和部分排版可能无法保留；需要保留结构时可使用“另存保真副本”。继续吗？')) return;
          void run(async () => {
            const latest = await window.writer.readChapter(source.projectId, source.path);
            if (latest.hash !== source.hash || latest.path !== source.path) throw new Error('原文件已变化，请重新打开后再创建编辑副本');
            const copy = await window.writer.copyChapter(source.projectId, content);
            const files = await window.writer.chapters(source.projectId);
            if (activeIdRef.current === source.projectId && documentRef.current?.projectId === source.projectId && documentRef.current.path === source.path && documentRef.current.hash === source.hash) {
              loadDocument(copy); setChapters(files); setMessage('已创建可编辑 DOCX 副本，原文件保留');
            }
          });
        } : undefined} jump={jump} onReady={(json, text) => {
          draft.current = json; setCount(text.replace(/\s/g, '').length);
        }} onChange={(json, text) => {
          draft.current = json; draftVersion.current++; editorDirtyRef.current = true; setRevision(draftVersion.current); setCheckpointStatus(''); setDirty(true); setSaveState(current => ({ ...current, unsaved: true })); setCount(text.replace(/\s/g, '').length);
        }} /> : <div className="welcome"><div className="welcome-mark" aria-hidden="true"><img src={appIconUrl} alt="" /></div><span className="eyebrow">YOUR WRITING ROOM</span><h2>每一个世界，都有自己的书页。</h2><p>打开小说文件夹，或从左侧选择一本书。<br />人物、设定与文风，跟随当前小说独立保存。</p><div className="feature-grid"><div><b>DOCX 正文</b><span>宋体五号，真实段首空格</span></div><div><b>多书独立</b><span>不同故事，独立资料</span></div><div><b>文件在你手中</b><span>直接读写自己的文件夹</span></div></div></div>}
        <footer className="editor-footer"><span>{busy ? '处理中…' : autoSaving ? '自动保存中…' : dirty ? `正文有未保存修改${checkpointStatus ? ' · ' + checkpointStatus : ''}` : message}</span><span>{count ? `${count} 字 · ` : ''}{document?.path.toLowerCase().endsWith('.txt') ? 'TXT' : 'DOCX'} · 宋体五号</span></footer>
      </main>
      <aside className={`inspector ${tab === 'characters' || tab === 'world' ? 'has-cards' : ''}`}>
        <div className="inspector-heading"><h2>创作资料</h2><span>{active ? '仅用于本书' : '按小说隔离'}</span></div>
        <div className="tabs">{tabs.map(item => <button className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
        {tab === 'ai' || tab === 'memory' ? <div className="planned"><h3>{tab === 'ai' ? '模型与写作助手' : '长篇故事记忆'}</h3>{tab === 'ai' && activeBook && <StylePicker snapshot={activeBook} disabled={busy} onOpenStudio={() => setView('styles')} onSelect={id => void run(async () => { await persistBook(activeBook.value.projectId, { ...activeBook.value, activeStyleId: id }, activeBook.hash); })} />}{tab === 'ai' && <button disabled={!active} onClick={() => setView('ai-writer')}>打开 AI 写作与审稿</button>}{tab === 'memory' && <button disabled={!active} onClick={() => setView('memories')}>打开章节摘要与故事记忆</button>}<p>{tab === 'ai' ? '支持 OpenAI、Gemini、Claude、DeepSeek、千问及 Ollama 本地模型。请先在模型设置保存连接。' : '独立模型生成摘要，作者确认后用于本书 AI；原文变化后旧摘要失效。'}</p></div> : <>
          {active && view === 'writer' && (tab === 'characters' || tab === 'world') && <InspectorCards key={`${active.id}:${tab}`} projectId={active.id} kind={tab} revision={inspectorRevision} onBusy={setWorldCardActionBusy} onEditWorld={request => { if (activeIdRef.current === request.projectId) setWorldCardTarget(request); }} onOpenWorld={name => { if (activeIdRef.current === active.id) { setWorldInitialBook(name); setWorldOpen(active.id); } }} />}
          <label className="note-label" htmlFor="project-note">{tabs.find(item => item.id === tab)?.label}笔记{notesDirty && <span>未保存</span>}</label>
          <textarea id="project-note" disabled={!notes || busy} placeholder={placeholders[tab]} value={notes?.value[tab] ?? ''} onChange={event => {
            if (notes) { setNotes({ ...notes, value: { ...notes.value, [tab]: event.target.value } }); setNotesDirty(true); }
          }} />
          <button className="save-notes" disabled={!notesDirty || busy || !active} onClick={() => void run(async () => {
            if (active && notes) { setNotes(await window.writer.saveNotes(active.id, notes.value, notes.hash)); setNotesDirty(false); setMessage('本书资料已保存'); }
          })}>保存本书资料</button>
          {tab === 'characters' && <button onClick={() => setView('characters')}>打开角色库 · 图片卡与文字卡</button>}
          {tab === 'world' && <button data-testid="inspector-world-cards" disabled={!active || busy || autoSaving || worldCardActionBusy} onClick={() => { if (active) { setWorldInitialBook(''); setWorldOpen(active.id); } }}>查看地点与世界设定卡片…</button>}
          {(tab === 'characters' || tab === 'world') && <button disabled={!active || busy} onClick={() => setView('characters')}>从本书全文整理人物与世界设定…</button>}
          <p className="inspector-tip">这里展示本书已保存的卡片；可展开阅读，完整管理请打开角色库或世界书。笔记单独保存，AI 使用已保存资料与启用角色。</p>
        </>}
      </aside>
    </div>
  </div>;
}
