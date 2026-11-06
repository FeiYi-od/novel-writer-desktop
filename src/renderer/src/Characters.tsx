import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CharacterCard, CharacterEdit, CharacterFields, CharacterSnapshot } from '../../shared/contracts';
import { characterContext, emptyCharacter } from '../../core/characters';
import './character-dialog.css';
import './characters-polish.css';

const labels: [Exclude<keyof CharacterFields, 'alternateGreetings'>, string][] = [
  ['name', '角色名称'], ['description', '角色描述'], ['personality', '性格与行为边界'], ['scenario', '角色背景'],
  ['firstMessage', '开场白'], ['examples', '示例对话'], ['creatorNotes', '作者说明'], ['systemPrompt', '卡内系统提示'], ['postHistoryInstructions', '后置提示']
];
type Draft = { edit: CharacterEdit; hash: string; image: string; warnings: string[]; format: string };

export function Characters({ projectId, title, legacyNotes, manuscriptDirty, onDirty, onOpenWorld }: { projectId: string; title: string; legacyNotes: string; manuscriptDirty: boolean; onDirty: (dirty: boolean) => void; onOpenWorld: (projectId: string, name: string) => void }) {
  const [snapshot, setSnapshot] = useState<CharacterSnapshot | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [search, setSearch] = useState('');
  const [restored, setRestored] = useState(false);
  const [needsImportReselect, setNeedsImportReselect] = useState(false);
  const [needsPortraitReselect, setNeedsPortraitReselect] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [notice, setNotice] = useState('');
  const [merging, setMerging] = useState<string | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef<{ target: HTMLElement; anchor: Element | null } | null>(null);
  const modalKind = draft ? 'edit' : merging && snapshot ? 'merge' : '';
  useLayoutEffect(() => {
    if (!modalKind || !modal.current) return;
    const dialog = modal.current;
    const container = dialog.closest<HTMLElement>('.full-view');
    let previous: HTMLElement | null = null;
    const syncVisibility = () => {
      if (container?.hidden) { if (dialog.open) dialog.close(); return; }
      if (!dialog.open) {
        previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.showModal();
      }
    };
    const observer = container ? new MutationObserver(syncVisibility) : null;
    if (container) observer?.observe(container, { attributes: true, attributeFilter: ['hidden'] });
    syncVisibility();
    return () => {
      observer?.disconnect();
      if (dialog.open) dialog.close();
      if (previous?.isConnected && !previous.closest('[inert]')) {
        if (previous.matches(':disabled')) restoreFocus.current = { target: previous, anchor: document.activeElement };
        else { previous.focus(); restoreFocus.current = null; }
      }
    };
  }, [modalKind]);
  useEffect(() => {
    if (modalKind || busy) return;
    const pendingRestore = restoreFocus.current; restoreFocus.current = null;
    const target = pendingRestore?.target;
    if (target?.isConnected && document.activeElement === pendingRestore?.anchor && !target.matches(':disabled') && !target.closest('[inert]')) target.focus();
  }, [modalKind, busy]);
  const pending = useRef(false); const tokens = useRef(new Set<string>());
  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab' || event.nativeEvent.isComposing) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1), current = document.activeElement;
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && (current === first || !event.currentTarget.contains(current))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (current === last || !event.currentTarget.contains(current))) { event.preventDefault(); first.focus(); }
  }
  useEffect(() => { let live = true; void window.writer.readCharacters(projectId).then(value => { if (live) setSnapshot(value); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; for (const token of tokens.current) void window.writer.releaseCharacterImport(projectId, token); }; }, [projectId]);
  useEffect(() => { onDirty(Boolean(draft) || busy || extracting); return () => onDirty(false); }, [draft, busy, extracting, onDirty]);
  // Editing state survives an exit; it never edits the project until the author saves.
  const draftLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(projectId, 'characters').then(value => {
      if (!live) return;
      draftLoaded.current = true;
      const text = value?.values.draft; if (!text) return;
      try { const parsed = JSON.parse(text) as Draft; if (parsed?.edit?.fields) { setDraft(parsed); setRestored(true); setNeedsImportReselect(Boolean(parsed.edit.importToken)); setNeedsPortraitReselect(Boolean(parsed.edit.portraitToken)); } }
      catch { /* keep the file; never adopt unreadable input automatically */ }
    }).catch(() => { draftLoaded.current = true; });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (!draftLoaded.current) return;
    if (!draft) { void window.writer.clearUiDraft(projectId, 'characters').catch(() => {}); return; }
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'characters', { draft: JSON.stringify(draft) }).then(() => setDraftError('')).catch(e => setDraftError('未保存草稿自动备份失败，请保留当前页面并先保存或复制内容：' + String(e))); }, 800);
    return () => clearTimeout(timer);
  }, [draft, projectId]);
  async function action(fn: () => Promise<void>) {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) {
      if (String(e).includes('导入预览已过期')) { setNeedsImportReselect(Boolean(draft?.edit.importToken)); setNeedsPortraitReselect(Boolean(draft?.edit.portraitToken)); }
      setError(String(e));
    } finally { pending.current = false; setBusy(false); }
  }
  async function importCard(kind: 'image' | 'text') {
    if (!snapshot) return;
    const next = await window.writer.previewCharacter(projectId, kind);
    if (next) { tokens.current.add(next.token); setDraft({ edit: { fields: next.fields, enabled: false, importToken: next.token }, hash: snapshot.hash, image: next.image, warnings: next.warnings, format: next.format }); }
  }
  async function reselectImport(kind: 'image' | 'text') {
    if (!draft?.edit.importToken) return;
    const next = await window.writer.previewCharacter(projectId, kind);
    if (!next) return;
    await window.writer.releaseCharacterImport(projectId, draft.edit.importToken);
    tokens.current.delete(draft.edit.importToken); tokens.current.add(next.token);
    setDraft({ ...draft, edit: { ...draft.edit, importToken: next.token }, image: draft.edit.portraitToken || draft.edit.removePortrait ? draft.image : next.image, format: next.format, warnings: next.warnings });
    setNeedsImportReselect(false);
  }
  function editCard(card: CharacterCard) {
    const fields = emptyCharacter();
    for (const key of Object.keys(fields) as (keyof CharacterFields)[]) Object.assign(fields, { [key]: structuredClone(card[key]) });
    setDraft({ edit: { id: card.id, fields, enabled: card.enabled }, hash: snapshot!.hash, image: snapshot!.portraits[card.portrait] ?? '', warnings: card.warnings, format: card.source.format });
  }
  async function releaseDraft() {
    for (const token of tokens.current) await window.writer.releaseCharacterImport(projectId, token);
    tokens.current.clear(); setDraft(null); setNeedsImportReselect(false); setNeedsPortraitReselect(false);
  }
  const cards = snapshot?.value.cards ?? [];
  const context = characterContext(projectId, cards);
  return <section className="characters-page">
    <div className="page-title"><div><span className="eyebrow">CHARACTER LIBRARY</span><h1>角色库<span>{title}</span></h1><p>图片卡与文字卡统一管理，多位角色可同时用于本书。</p></div><span className="studio-badge">{cards.length} 位角色 · {context.length} 位启用</span></div>
    {error && <div role="alert" className="error">{error}</div>}{draftError && <div role="alert" className="error">{draftError}</div>}
    <div className="character-toolbar"><input aria-label="搜索角色" placeholder="搜索角色名称…" value={search} onChange={e => setSearch(e.target.value)} /><div className="actions">
      <button data-testid="setting-extract-open" disabled={busy} onClick={() => setExtracting(true)}>从全文或文字整理创作资料…</button>
      <button disabled={busy} onClick={() => void action(async () => setSnapshot(await window.writer.readCharacters(projectId)))}>重新载入角色库</button>
      <button disabled={busy || !snapshot} onClick={() => void action(() => importCard('image'))}>导入图片角色卡</button>
      <button disabled={busy || !snapshot} onClick={() => void action(() => importCard('text'))}>导入文字角色卡</button>
      <button className="primary" disabled={busy || !snapshot} onClick={() => setDraft({ edit: { fields: emptyCharacter(), enabled: false }, hash: snapshot!.hash, image: '', warnings: [], format: '文字' })}>＋ 新建文字角色卡</button>
    </div></div>
    <p className="character-help">PNG 可读取酒馆内嵌卡片；JSON、TXT、DOCX 可导入文字。普通图片仅作头像，也能为文字卡添加头像。</p>
    {legacyNotes && <details className="legacy-style-note"><summary>原人物笔记（已保留）</summary><p>{legacyNotes}</p></details>}
    <div className="character-grid">{cards.filter(card => card.name.includes(search.trim())).map(card => <article className={`character-card ${card.enabled ? 'enabled' : ''}`} key={card.id}>
      <div className="character-portrait">{snapshot?.portraits[card.portrait] ? <img src={snapshot.portraits[card.portrait]} alt={`${card.name}头像`} /> : <span>{card.name.slice(0, 1)}</span>}</div>
      <div className="character-info"><small>{card.source.format} · {card.portrait ? '带头像' : '文字卡'}</small><h2 title={card.name}>{card.name}</h2><p>{card.description || card.personality || '尚未填写角色描述'}</p><footer><label><input type="checkbox" aria-label={`启用角色 ${card.name}`} checked={card.enabled} disabled={busy} onChange={e => { const enabled = e.target.checked; void action(async () => { setSnapshot(await window.writer.saveCharacter(projectId, { id: card.id, fields: card, enabled }, snapshot!.hash)); }); }} />用于本书</label><button disabled={busy} onClick={() => editCard(card)}>查看与编辑</button><button data-testid="card-export" disabled={busy} title="导出为 SillyTavern 可直接打开的 PNG 名片" onClick={() => void action(async () => { const result = await window.writer.exportCharacterCard(projectId, card.id); setNotice(`已导出 ${result.relative}（V${result.specVersion}，${result.bytes} 字节）`); })}>导出名片</button><button data-testid="card-merge" disabled={busy || cards.length < 2} title="把这张卡合并进另一张：空字段补齐、问候语合并，操作前先备份" onClick={() => setMerging(card.id)}>合并到…</button><button data-testid="card-remove" disabled={busy} title="删除前会把当前角色库备份到本书资料" onClick={() => void action(async () => { const result = await window.writer.removeCharacterCard(projectId, card.id, snapshot!.hash); setSnapshot(result.snapshot); setNotice(`已删除「${result.removed}」，备份：${result.backup}`); })}>删除（先备份）</button></footer></div>
    </article>)}</div>
    {snapshot && !cards.length && <div className="empty-library"><b>让故事中的人物在这里相遇</b><p>导入一张图片卡，或从文字设定开始。</p></div>}
    {notice && <p className="notice" role="status">{notice}</p>}
{extracting && <SettingExtractModal projectId={projectId} manuscriptDirty={manuscriptDirty} onClose={() => setExtracting(false)} onOpenWorld={name => { setExtracting(false); onOpenWorld(projectId, name); }} onDone={async () => { setSnapshot(await window.writer.readCharacters(projectId)); }} />}    {merging && snapshot && !draft && <dialog ref={modal} className="modal-overlay character-native-dialog" aria-label="合并角色卡" onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); if (!busy && !pending.current) setMerging(null); }}><section className="book-modal merge-modal">
      <h2>合并角色卡</h2>
      <p>当前卡片：<b>{snapshot.value.cards.find(card => card.id === merging)?.name}</b>。合并后本卡会被并入选中的卡片并删除，**合并前会先备份整份角色库**。</p>
      <ul className="merge-targets">{snapshot.value.cards.filter(card => card.id !== merging).map(card => <li key={card.id}>
        <button data-testid="merge-into" disabled={busy} onClick={() => void action(async () => { const result = await window.writer.mergeCharacterCards(projectId, card.id, merging, snapshot.hash); setSnapshot(result.snapshot); setNotice(`已合并「${result.dropped}」→「${result.mergedInto}」，备份：${result.backup}`); setMerging(null); })}>合并进「{card.name}」</button>
      </li>)}</ul>
      {error && <div role="alert" className="error">{error}</div>}
      <footer><button disabled={busy} onClick={() => setMerging(null)}>取消</button></footer>
    </section></dialog>}
    <details className="character-context"><summary>本书角色上下文预览（{context.length} 位）</summary><pre>{context.map(item => item.text).join('\n\n') || '在角色卡上勾选“用于本书”，即可同时选择图片卡和文字卡。'}</pre><p>AI 请求仅包含启用角色的名称、描述、性格与背景；开场白、作者说明和扩展不会自动变成正文。</p></details>
    {draft && <dialog ref={modal} className="modal-overlay character-native-dialog" aria-label="角色卡编辑" onKeyDown={trapFocus} onCancel={event => { event.preventDefault(); if (!busy && !pending.current && window.confirm('关闭并放弃当前角色编辑？')) void action(releaseDraft); }}><section className="character-modal">
      <header><div><span className="eyebrow">{draft.edit.importToken ? 'IMPORT PREVIEW' : 'CHARACTER DETAILS'}</span><h2>{draft.edit.importToken ? '确认导入角色卡' : draft.edit.id ? '编辑角色卡' : '新建文字角色卡'}</h2></div><span>归属：{title}</span></header>
      <div className="character-form"><aside><div className="character-portrait large">{draft.image ? <img src={draft.image} alt="角色卡预览" /> : <span>人</span>}</div><button disabled={busy} onClick={() => void action(async () => {
        const portrait = await window.writer.chooseCharacterPortrait(projectId);
        if (portrait) { if (draft.edit.portraitToken) { await window.writer.releaseCharacterImport(projectId, draft.edit.portraitToken); tokens.current.delete(draft.edit.portraitToken); } tokens.current.add(portrait.token); setDraft({ ...draft, image: portrait.image, edit: { ...draft.edit, portraitToken: portrait.token, removePortrait: false } }); setNeedsPortraitReselect(false); }
      })}>选择角色头像</button><button disabled={busy || !draft.image} onClick={() => void action(async () => { if (draft.edit.portraitToken) { await window.writer.releaseCharacterImport(projectId, draft.edit.portraitToken); tokens.current.delete(draft.edit.portraitToken); } setDraft({ ...draft, image: '', edit: { ...draft.edit, portraitToken: undefined, removePortrait: true } }); setNeedsPortraitReselect(false); })}>移除头像</button><p>{draft.format} · 角色资料</p><label><input type="checkbox" checked={draft.edit.enabled} disabled={busy} onChange={e => setDraft({ ...draft, edit: { ...draft.edit, enabled: e.target.checked } })} />确认用于本书</label><small>导入默认不启用。可与本书其他图片卡、文字卡一起勾选使用。</small></aside>
      <div className="character-fields"><p className="notice">{draft.edit.importToken ? '确认后会新增独立角色，不覆盖同名角色；原卡片与未知扩展一并保存。' : '编辑基础字段不会改写原卡片文件。'}</p>
        {restored && <p className="notice" role="status">已恢复上次未保存的角色编辑，保存后才会写入角色库。<button disabled={busy} onClick={() => void action(releaseDraft)}>放弃这次编辑</button></p>}
        {needsImportReselect && <div className="notice" role="alert">导入原卡的临时数据已失效。请重新选择原来的角色卡，核对文件后再确认；已编辑的字段会保留，原卡和扩展将以本次所选文件为准。<div className="actions"><button disabled={busy} onClick={() => void action(() => reselectImport('image'))}>重新选择图片角色卡</button><button disabled={busy} onClick={() => void action(() => reselectImport('text'))}>重新选择文字角色卡</button></div></div>}
        {needsPortraitReselect && <p className="notice" role="alert">头像的临时数据已失效，请重新选择角色头像，或移除头像后再保存。</p>}
        {draft.warnings.map((warning, i) => <p className="notice" key={i}>{warning}</p>)}
        {labels.map(([key, label]) => <label key={key}>{label}{key === 'name' ? <input aria-label={label} maxLength={200} disabled={busy} value={draft.edit.fields[key]} onChange={e => setDraft({ ...draft, edit: { ...draft.edit, fields: { ...draft.edit.fields, [key]: e.target.value } } })} /> : <textarea aria-label={label} maxLength={100000} disabled={busy} value={draft.edit.fields[key]} onChange={e => setDraft({ ...draft, edit: { ...draft.edit, fields: { ...draft.edit.fields, [key]: e.target.value } } })} />}</label>)}
        {!!draft.edit.fields.alternateGreetings.length && <details><summary>候选开场白（{draft.edit.fields.alternateGreetings.length} 条，原样保留）</summary>{draft.edit.fields.alternateGreetings.map((text, i) => <pre key={i}>{text}</pre>)}</details>}
      </div></div>
      {error && <div role="alert" className="error">{error}</div>}{draftError && <div role="alert" className="error">{draftError}</div>}
      <footer><button disabled={busy} onClick={() => { if (window.confirm('关闭并放弃当前角色编辑？')) void action(releaseDraft); }}>取消</button><button className="primary" disabled={busy || needsImportReselect || needsPortraitReselect || !draft.edit.fields.name.trim()} onClick={() => void action(async () => { const next = await window.writer.saveCharacter(projectId, draft.edit, draft.hash); setSnapshot(next); await releaseDraft(); })}>{busy ? '保存中…' : draft.edit.importToken ? '确认导入' : '保存角色卡'}</button></footer>
    </section></dialog>}
  </section>;
}

/** 从文字设定提取候选：预览 → 勾选/合并 → 确认写入人物卡与世界书。 */
function SettingExtractModal({ projectId, manuscriptDirty, onClose, onOpenWorld, onDone }: { projectId: string; manuscriptDirty: boolean; onClose: () => void; onOpenWorld: (name: string) => void; onDone: () => Promise<void> }) {
  const [text, setText] = useState('角色：姓名\n别名：\n外貌：\n性格：\n经历：\n目标：\n说话方式：\n\n地点：名称\n正文：\n关键词：');
  const [plan, setPlan] = useState<{ token: string; candidates: { id: string; kind: string; name: string; fields: Record<string, string>; missing?: string[]; conflicts?: { field: string; values: string[] }[] }[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]); const [modes, setModes] = useState<Record<string, 'new' | 'merge'>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>({});
  const [book, setBook] = useState<{ token: string; chapters: number; availableChapters: number; chapterPaths: string[]; characters: number; chunks: number; chunkCharacters: number; completed: number } | null>(null);
  const [bookPlan, setBookPlan] = useState(false);
  const [planChapterPaths, setPlanChapterPaths] = useState<string[]>([]);
  const [savedWorld, setSavedWorld] = useState('');
  const [chunkSize, setChunkSize] = useState(6000);
  const [retryFailed, setRetryFailed] = useState(false);
  const [keepCheckpoint, setKeepCheckpoint] = useState(false);
  const [checkpointBound, setCheckpointBound] = useState(false);
  const [checkpoint, setCheckpoint] = useState<Awaited<ReturnType<typeof window.writer.readBookSettingsCheckpoint>>>(null);
  const [checkpointError, setCheckpointError] = useState('');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [scopeChapters, setScopeChapters] = useState<{ path: string; name: string }[]>([]);
  const [scopePaths, setScopePaths] = useState<string[]>([]);
  const [scopeLoading, setScopeLoading] = useState(true);
  const [scopeError, setScopeError] = useState('');
  const [rangeStart, setRangeStart] = useState('1'); const [rangeEnd, setRangeEnd] = useState('1');
  const scopePathSet = useMemo(() => new Set(scopePaths), [scopePaths]);
  const operationPending = useRef(false);
  const activeBookRequest = useRef<string | null>(null);
  const [bookProgress, setBookProgress] = useState<{ completed: number; total: number; phase: 'preparing' | 'processing' | 'retrying'; received: boolean } | null>(null);
  const [cancelingBook, setCancelingBook] = useState(false);
  const [modelConnections, setModelConnections] = useState<{ id: string; name: string; model: string }[]>([]); const [modelId, setModelId] = useState(''); const [template, setTemplate] = useState<'both' | 'character' | 'world'>('both');
  useEffect(() => { let live = true; void window.writer.aiConnections().then(value => { if (live) { setModelConnections(value.connections.map(item => ({ id: item.id, name: item.name, model: item.model }))); if (value.connections[0]) setModelId(value.connections[0].id); } }).catch(() => {}); return () => { live = false; }; }, []);
  useEffect(() => { let live = true; void window.writer.chapters(projectId).then(chapters => { if (live) { setScopeChapters(chapters); setScopePaths(chapters.map(chapter => chapter.path)); setRangeEnd(String(Math.max(1, chapters.length))); } }).catch(failure => { if (live) setScopeError(String(failure instanceof Error ? failure.message : failure)); }).finally(() => { if (live) setScopeLoading(false); }); return () => { live = false; }; }, [projectId]);
  useEffect(() => { let live = true; void window.writer.readBookSettingsCheckpoint(projectId).then(value => { if (live) setCheckpoint(value); }).catch(failure => { if (live) setCheckpointError(String(failure instanceof Error ? failure.message : failure)); }); return () => { live = false; }; }, [projectId]);
  useEffect(() => {
    const off = window.writer.onBookSettingsProgress(progress => {
      if (progress.projectId === projectId && progress.requestId === activeBookRequest.current) {
        setBookProgress({ completed: progress.completed, total: progress.total, phase: progress.phase, received: true });
        if (progress.phase === 'processing') setBook(current => current ? { ...current, completed: Math.max(current.completed, progress.completed) } : current);
      }
    });
    return () => { off(); if (activeBookRequest.current) void window.writer.cancelBookSettings(projectId, activeBookRequest.current).catch(() => {}); };
  }, [projectId]);
  const run = async (action: () => Promise<void>) => { if (operationPending.current) return; operationPending.current = true; setBusy(true); setError(''); try { await action(); } catch (failure) { setError(String(failure instanceof Error ? failure.message : failure)); } finally { operationPending.current = false; setBusy(false); } };
  const backupAndResetCheckpoint = () => void run(async () => {
    const preview = await window.writer.inspectBookSettingsCheckpointFile(projectId);
    if (!window.confirm(`将当前断点原样备份并从使用位置移开？\n\n文件大小：${preview.bytes.toLocaleString()} 字节；校验码：${preview.hash.slice(0, 16)}…\n\n这不会删除小说正文或已确认资料；原断点可在本机备份目录中查找。`)) return;
    const saved = await window.writer.quarantineBookSettingsCheckpoint(projectId, preview.hash);
    setCheckpoint(null); setCheckpointError(''); if (checkpointBound) setBook(null); setCheckpointBound(false);
    setNotice(`断点已原样备份并移出当前使用位置：${saved.backup}`);
  });
  return <div className="modal-overlay"><section className="book-modal" role="dialog" aria-modal="true" aria-label="从文字设定提取" data-testid="setting-extract" style={{ width: 720, height: 'auto', maxHeight: '86vh', overflowY: 'auto', padding: '20px 24px' }}>
    <header><div><h2>整理创作资料</h2><p>可读取本书已保存的全部或所选章节，或导入文字；确认前不会写入人物卡或世界书。</p></div><button disabled={busy} onClick={onClose}>关闭</button></header>
    {error && <div role="alert" className="error">{error}</div>}{notice && <p role="status">{notice}</p>}
    {savedWorld && <div className="actions"><button data-testid="setting-open-world" disabled={busy} onClick={() => onOpenWorld(savedWorld)}>查看刚生成的设定卡片</button></div>}
    <div className="setting-scope"><label>读取范围 <select aria-label="整理章节范围" value={scope} disabled={busy} onChange={event => { setScope(event.target.value as 'all' | 'selected'); setBook(null); }}><option value="all">本书全部章节</option><option value="selected">选择章节</option></select></label>
      {scope === 'selected' && <div className="setting-scope-selection"><p>已选择 {scopePaths.length} / {scopeChapters.length} 章；按本书章节顺序发送。</p>{scopeLoading && <p>正在读取章节列表…</p>}{scopeError && <p role="alert">章节列表读取失败：{scopeError}</p>}
        <div className="actions"><button disabled={busy || scopeLoading} onClick={() => { setScopePaths(scopeChapters.map(chapter => chapter.path)); setBook(null); }}>全选章节</button><button disabled={busy || scopeLoading} onClick={() => { setScopePaths([]); setBook(null); }}>清空选择</button><button disabled={busy || scopeLoading} onClick={() => void run(async () => { const chapters = await window.writer.chapters(projectId); setScopeChapters(chapters); const valid = new Set(chapters.map(chapter => chapter.path)); setScopePaths(current => current.filter(item => valid.has(item))); setRangeEnd(String(Math.max(1, chapters.length))); setScopeError(''); setBook(null); setNotice('章节列表已刷新；新增章节未自动勾选，请核对。'); })}>刷新章节列表</button></div>
        <div className="setting-scope-range"><label>从第 <input aria-label="起始章节序号" type="number" min={1} max={scopeChapters.length || 1} value={rangeStart} disabled={busy || scopeLoading} onChange={event => setRangeStart(event.target.value)} /> 章</label><label>到第 <input aria-label="结束章节序号" type="number" min={1} max={scopeChapters.length || 1} value={rangeEnd} disabled={busy || scopeLoading} onChange={event => setRangeEnd(event.target.value)} /> 章</label><button disabled={busy || scopeLoading || !scopeChapters.length} onClick={() => { const start = Number(rangeStart), end = Number(rangeEnd); if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > scopeChapters.length) { setScopeError('请输入有效的起止章节序号。'); return; } setScopeError(''); setScopePaths(scopeChapters.slice(start - 1, end).map(chapter => chapter.path)); setBook(null); }}>选择这一段</button></div>
        <div className="setting-scope-list" aria-label="章节选择列表">{scopeChapters.map((chapter, index) => <label key={chapter.path}><input type="checkbox" aria-label={`选择章节 ${chapter.path}`} disabled={busy || scopeLoading} checked={scopePathSet.has(chapter.path)} onChange={event => { setScopePaths(current => event.target.checked ? [...current, chapter.path] : current.filter(path => path !== chapter.path)); setBook(null); }} /><span>{index + 1}. {chapter.path}</span></label>)}</div>
      </div>}
    </div>
    {checkpointError && <div role="alert"><p>本机断点读取失败：{checkpointError}</p><button type="button" disabled={busy} onClick={backupAndResetCheckpoint}>备份并重置本机断点…</button></div>}
    {checkpoint && <div className="notice" data-testid="setting-checkpoint">本机存在未确认的整理断点：已完成 {checkpoint.completed} / {checkpoint.total} 段，涉及 {checkpoint.chapters.length} 章。恢复只读取本机进度，继续调用模型前仍需确认；断点可能包含小说设定，仅保存在本机。<details><summary>查看断点来源章节</summary><pre>{checkpoint.chapters.join('\n')}</pre></details><div className="actions"><button disabled={busy || manuscriptDirty} onClick={() => { if ((book || plan) && !window.confirm('恢复断点将替换当前读取结果和未确认候选，继续吗？')) return; void run(async () => { const restored = await window.writer.restoreBookSettingsCheckpoint(projectId, checkpoint.hash); setBook(restored); setBookPlan(false); setPlan(null); setPlanChapterPaths([]); setScope('selected'); setScopePaths(restored.chapterPaths); setChunkSize(restored.chunkCharacters); setModelId(restored.connectionId); setTemplate(restored.template); setKeepCheckpoint(true); setCheckpointBound(true); setNotice('已恢复本机断点；请核对章节、模型和剩余请求数后再继续。'); }); }}>恢复本机断点</button><button disabled={busy} onClick={backupAndResetCheckpoint}>备份并重置本机断点…</button><button disabled={busy} onClick={() => { if (!window.confirm('删除本机保存的这份整理断点？不会删除小说正文或已确认的资料。')) return; void run(async () => { await window.writer.discardBookSettingsCheckpoint(projectId, checkpoint.hash); setCheckpoint(null); if (checkpointBound) setBook(null); setCheckpointBound(false); setNotice('本机整理断点已删除。'); }); }}>删除本机断点</button></div></div>}
    <label className="setting-retry-choice"><input type="checkbox" aria-label="保存全文整理本机断点" checked={keepCheckpoint} disabled={busy || checkpointBound} onChange={event => setKeepCheckpoint(event.target.checked)} />保存本机断点（可在重启后恢复；包含未确认的模型整理结果）</label>
    <label className="setting-retry-choice"><input type="checkbox" aria-label="失败分段自动重试一次" checked={retryFailed} disabled={busy} onChange={event => setRetryFailed(event.target.checked)} />临时错误或格式异常时重试一次（可能增加请求和费用）</label>
    <div className="actions"><label>每段字符数 <select aria-label="全文整理每段字符数" value={chunkSize} disabled={busy} onChange={event => { setChunkSize(Number(event.target.value)); setBook(null); }}><option value={2000}>2000</option><option value={6000}>6000</option><option value={12000}>12000</option><option value={20000}>20000</option></select></label><button data-testid="setting-book-prepare" disabled={busy || manuscriptDirty || (scope === 'selected' && (scopeLoading || !scopePaths.length))} onClick={() => { if (plan && !window.confirm('重新读取将清除当前未确认的候选，继续吗？')) return; void run(async () => { setPlan(null); setBook(null); setBookPlan(false); setCheckpointBound(false); setBook({ ...(await window.writer.prepareBookSettings(projectId, chunkSize, scope === 'selected' ? scopePaths : undefined)), completed: 0 }); setNotice('已读取所选已保存正文；请核对范围与调用次数。'); }); }}>{scope === 'all' ? '读取本书全文' : '读取所选章节'}</button></div>
    {manuscriptDirty && <p role="status">请先保存当前正文或保真副本，再读取、整理或确认全文资料。</p>}
    {book && <div className="notice" data-testid="setting-book-preview">已读取 {book.chapters} 章（本书共 {book.availableChapters} 章）、{book.characters.toLocaleString()} 字符；共 {book.chunks} 段（每段最多 {book.chunkCharacters} 字符），当前窗口已完成 {book.completed} 段；继续预计请求 {book.chunks - book.completed} 次。{retryFailed && `启用重试后最多额外请求 ${book.chunks - book.completed} 次。`}{keepCheckpoint ? '已启用本机断点，关闭窗口或程序后可手动恢复。' : '已完成段仅保留在当前窗口内存中，关闭窗口或程序后无法恢复。'}上述所选正文将发送到所选模型，可能计费；模型上下文不足时请调小分段。所选已保存章节可能含尚未确认的草稿；它们不会自动成为正史。<details><summary>查看读取的章节</summary><pre>{book.chapterPaths.join('\n')}</pre></details><div><button data-testid="setting-book-model" disabled={busy || manuscriptDirty || !modelId} onClick={() => { if (!window.confirm(`将所选 ${book.chapters} 章、${book.characters.toLocaleString()} 字符发送给所选模型，已完成 ${book.completed} 段，预计请求剩余 ${book.chunks - book.completed} 次。${retryFailed ? '已启用失败分段重试，最多额外请求 ' + (book.chunks - book.completed) + ' 次，可能额外计费。' : '未启用自动重试。'}继续吗？`)) return; void run(async () => { const requestId = crypto.randomUUID(); activeBookRequest.current = requestId; setBookProgress({ completed: 0, total: book.chunks, phase: 'preparing', received: false }); setCancelingBook(false); try { if (keepCheckpoint) setCheckpointBound(true); const result = await window.writer.modelBookSettings(projectId, book.token, modelId, template, requestId, retryFailed, keepCheckpoint); setPlan(result); setBookPlan(true); setPlanChapterPaths([...book.chapterPaths]); setBook(null); setSelected(result.candidates.map(candidate => candidate.id)); setModes({}); setOverrides({}); setNotice(`所选正文整理出 ${result.candidates.length} 条候选，请逐项核对并确认。`); } catch (failure) { const message = String(failure instanceof Error ? failure.message : failure); if (message.includes('已取消全文整理')) setNotice('已取消本次整理；已完成段可在当前窗口继续，若启用了本机断点也可稍后恢复。已发送的请求可能计费，本次未生成候选。'); else throw failure; } finally { if (activeBookRequest.current === requestId) activeBookRequest.current = null; setBookProgress(null); setCancelingBook(false); if (keepCheckpoint) { try { setCheckpoint(await window.writer.readBookSettingsCheckpoint(projectId)); setCheckpointError(''); } catch (failure) { setCheckpointError(String(failure instanceof Error ? failure.message : failure)); } } } }); }}>{busy ? '正在整理，请勿关闭…' : '用模型整理所读正文…'}</button></div>
      {bookProgress && <div className="setting-book-progress" role="status" data-testid="setting-book-progress"><p>{bookProgress.phase === 'preparing' ? '正在准备并核对正文…' : bookProgress.phase === 'retrying' ? `第 ${bookProgress.completed + 1} 段失败，正在重试（已完成 ${bookProgress.completed} / ${bookProgress.total} 段）` : `已完成 ${bookProgress.completed} / ${bookProgress.total} 段`}</p><progress value={bookProgress.completed} max={Math.max(bookProgress.total, 1)} aria-label="全文整理进度" /><button disabled={!bookProgress.received || cancelingBook} onClick={() => { const requestId = activeBookRequest.current; if (!requestId) return; setCancelingBook(true); void window.writer.cancelBookSettings(projectId, requestId).then(canceled => { if (!canceled) setNotice('任务已结束或无法取消，请等待结果。'); }).catch(failure => { setCancelingBook(false); setError('取消请求失败：' + String(failure instanceof Error ? failure.message : failure)); }); }}>{cancelingBook ? '取消中…' : '取消整理'}</button><small>{keepCheckpoint ? '取消后可从本机断点继续，已发送的请求可能计费。' : '取消后已完成段暂留当前窗口，可继续；关闭窗口或程序会丢失，已发送的请求可能计费。'}</small></div>}
    </div>}
    <div className="actions" style={{ marginBottom: 6 }}><button data-testid="setting-import-file" disabled={busy} onClick={() => void run(async () => { const picked = await window.writer.readSettingFile(); if (picked) { setText(picked.text); setNotice(`已读入 ${picked.name}（${picked.text.length} 字符）`); } })}>从文件导入设定…</button></div><label>设定文字<textarea aria-label="设定文字" data-testid="setting-text" rows={8} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label>
    <div className="actions" style={{ marginBottom: 6 }}>
      <select aria-label="设定整理模型" value={modelId} disabled={busy || !modelConnections.length} onChange={event => setModelId(event.target.value)}><option value="">选择模型连接</option>{modelConnections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select>
      <select aria-label="整理目标" value={template} disabled={busy} onChange={event => setTemplate(event.target.value as 'both' | 'character' | 'world')}><option value="both">人物 + 地点/势力</option><option value="character">只整理人物</option><option value="world">只整理地点/势力</option></select>
      <button data-testid="setting-model" disabled={busy || !modelId || text.trim().length < 20} onClick={() => void run(async () => { const result = await window.writer.modelSettingCandidates(projectId, modelId, text, template); setPlan(result); setBookPlan(false); setModes({}); setOverrides({}); setSelected(result.candidates.map(candidate => candidate.id)); setNotice(`模型整理出 ${result.candidates.length} 条候选（确认前不写入）`); })}>用模型整理…</button>
    </div>
    <div className="actions"><button disabled={busy || !text.trim()} onClick={() => void run(async () => { const result = await window.writer.previewSettingCandidates(projectId, text); setPlan(result); setBookPlan(false); setModes({}); setOverrides({}); setSelected(result.candidates.map(candidate => candidate.id)); setNotice(`识别到 ${result.candidates.length} 条候选`); })}>提取候选</button><small>「提取候选」只在本机解析；「用模型整理…」会调用所选模型（长设定按块多次），可能计费，结果仍需你确认后才会写入。</small></div>
    {plan && <>
      <p>以下候选来自上一次整理；更改章节范围不会自动重新生成。</p>
      {bookPlan && <details><summary>候选来源章节（{planChapterPaths.length} 章）</summary><pre>{planChapterPaths.join('\n')}</pre><small>确认写入前会再次核对所选正文及章节列表。</small></details>}
      <div className="setting-candidates" style={{ marginTop: 8 }}>
        {plan.candidates.map(candidate => <div key={candidate.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--line, #2a2f3a)' }}>
          <input type="checkbox" aria-label={`选择 ${candidate.name}`} disabled={busy} checked={selected.includes(candidate.id)} onChange={event => setSelected(current => event.target.checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))} />
          <span style={{ flex: 1 }}><b>{candidate.name}</b> <small>{candidate.kind === 'character' ? '人物卡' : '世界书条目'} · {Object.keys(candidate.fields).length} 个字段</small></span>
          {candidate.kind === 'character' && <select aria-label={`写入方式 ${candidate.name}`} disabled={busy} value={modes[candidate.id] ?? 'new'} onChange={event => setModes(current => ({ ...current, [candidate.id]: event.target.value as 'new' | 'merge' }))}><option value="new">新建（重名加序号）</option><option value="merge">合并到同名卡</option></select>}
          {candidate.conflicts?.map(conflict => <select key={conflict.field} aria-label={`冲突 ${candidate.name} ${conflict.field}`} title={`多块整理时「${conflict.field}」出现不同值`} disabled={busy} value={overrides[candidate.id]?.[conflict.field] ?? conflict.values[0]!} onChange={event => setOverrides(current => ({ ...current, [candidate.id]: { ...(current[candidate.id] ?? {}), [conflict.field]: event.target.value } }))}>{conflict.values.map(value => <option key={value} value={value}>{conflict.field}：{value.slice(0, 18)}</option>)}</select>)}
          <details style={{ flexBasis: '100%' }}><summary>查看并修改候选内容</summary>{Object.entries(candidate.fields).map(([field, value]) => <label key={field}>{field}<textarea aria-label={`${candidate.name} ${field}`} rows={2} maxLength={4000} disabled={busy} value={overrides[candidate.id]?.[field] ?? value} onChange={event => setOverrides(current => ({ ...current, [candidate.id]: { ...(current[candidate.id] ?? {}), [field]: event.target.value } }))} /></label>)}</details>
        </div>)}
      </div>
      <div className="actions" style={{ marginTop: 10 }}><button className="primary" data-testid="setting-confirm" disabled={busy || !selected.length || (bookPlan && manuscriptDirty)} onClick={() => void run(async () => { const result = await window.writer.confirmSettingCandidates(projectId, plan.token, selected.map(id => ({ id, mode: modes[id] ?? 'new', fields: overrides[id] }))); setSavedWorld(result.world?.name ?? ''); await onDone(); setNotice(`已写入人物卡 ${result.characters.length} 张${result.world ? `，世界书「${result.world.name}」${result.world.entries} 条` : ''}`); setPlan(null); setSelected([]); })}>确认写入</button></div>
    </>}
  </section></div>;
}
