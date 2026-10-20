import { useEffect, useRef, useState } from 'react';
import { memoryUsage } from '../../core/memory-budget';
import type { AIConnection, AITask, Chapter, Manuscript, StoryFact, StoryMemorySnapshot, SummaryBatchState, UiDraft } from '../../shared/contracts';
export function Memories({ projectId, manuscript, connections, blocked, onDirty }: { projectId: string; manuscript: Manuscript | null; connections: AIConnection[]; blocked: boolean; onDirty: (dirty: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<StoryMemorySnapshot | null>(null); const [model, setModel] = useState(''); const [tasks, setTasks] = useState<AITask[]>([]); const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState(''); const [draftTask, setDraftTask] = useState(''); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [chapters, setChapters] = useState<Chapter[]>([]); const [picked, setPicked] = useState<string[]>([]); const [batch, setBatch] = useState<SummaryBatchState | null>(null);
  const [autoSummary, setAutoSummary] = useState(false);
  // The summary confirmation draft survives an exit; restoring stays an explicit action.
  const [restorable, setRestorable] = useState<UiDraft | null>(null);
  const draftLoaded = useRef(false);
  const [factKind, setFactKind] = useState<'fact' | 'foreshadow'>('fact'); const [factText, setFactText] = useState(''); const [factUseSource, setFactUseSource] = useState(true);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null); const alive = useRef(true);
  const stopPolling = () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
  const watchBatch = () => {
    stopPolling();
    poll.current = setInterval(() => { void (async () => {
      try {
        const next = await window.writer.summaryBatch(projectId);
        if (!alive.current) { stopPolling(); return; }
        if (!next) return;
        setBatch(next);
        if (!next.running) { stopPolling(); setMessage(`批量摘要结束：成功 ${next.created}/${next.total}${next.failures.length ? `，${next.failures.length} 章失败；结果仍是待确认草稿` : '；结果仍是待确认草稿，请在右侧逐条确认'}`); }
      } catch { stopPolling(); }
    })(); }, 900);
  };
  useEffect(() => { alive.current = true; void window.writer.chapters(projectId).then(files => { if (alive.current) setChapters(files); }).catch(() => {}); setAutoSummary(localStorage.getItem(`auto-summary:${projectId}`) === 'true'); return () => { alive.current = false; stopPolling(); }; }, [projectId]);
  const addFact = () => void run(async () => {
    if (!snapshot) throw new Error('故事记忆未加载');
    const next = await window.writer.saveStoryFact(projectId, { kind: factKind, text: factText,
      ...(factUseSource && manuscript?.managed ? { sourcePath: manuscript.path, sourceHash: manuscript.hash } : {}) }, snapshot.hash);
    setSnapshot(next); setFactText(''); setMessage(factKind === 'fact' ? '已添加作者事实（启用后按预算进入本书上下文）' : '已添加伏笔（未解决时会在上下文里标注）');
  });
  const toggleFact = (fact: StoryFact, patch: { enabled?: boolean; state?: 'open' | 'resolved' }) => void run(async () => {
    if (!snapshot) return;
    setSnapshot(await window.writer.saveStoryFact(projectId, { id: fact.id, kind: fact.kind, text: fact.text, enabled: patch.enabled ?? fact.enabled, state: patch.state ?? fact.state }, snapshot.hash));
  });
  const removeFact = (fact: StoryFact) => void run(async () => {
    if (!snapshot) return;
    setSnapshot(await window.writer.removeStoryFact(projectId, fact.id, snapshot.hash));
    setMessage('已删除这条事实');
  });
  const startBatch = () => void run(async () => {    if (!model) throw new Error('请先选择摘要模型');
    const items = chapters.filter(chapter => picked.includes(chapter.path)).map(chapter => ({ path: chapter.path }));
    if (!items.length) throw new Error('请至少勾选一个章节');
    const running = window.writer.startSummaryBatch({ projectId, connectionId: model, items });
    watchBatch();
    const first = await running; if (alive.current) { setSelected(first.id); setTasks(current => [first, ...current.filter(task => task.id !== first.id)]); }
  });
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(projectId, 'summary').then(value => { if (live) { draftLoaded.current = true; setRestorable(value); } }).catch(() => { draftLoaded.current = true; });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (!draftLoaded.current || !dirty) return;
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'summary', { doc: JSON.stringify({ preview, draftTask }) }).catch(() => {}); }, 800);
    return () => clearTimeout(timer);
  }, [dirty, projectId, preview, draftTask]);
  const restoreDraft = () => {
    if (!restorable?.values.doc) return;
    try {
      const value = JSON.parse(restorable.values.doc) as { preview?: string; draftTask?: string };
      if (typeof value.preview === 'string') setPreview(value.preview);
      if (typeof value.draftTask === 'string') setDraftTask(value.draftTask);
      setDirty(true); setRestorable(null); setMessage('已恢复上次未保存的摘要确认稿，尚未确认保存');
    } catch { setError('上次的摘要草稿无法解析，已保留原文件'); }
  };
  const discardDraft = () => { void window.writer.clearUiDraft(projectId, 'summary').catch(() => {}); setRestorable(null); };
  useEffect(() => { let disposed = false; void window.writer.readMemories(projectId).then(data => { if (!disposed) setSnapshot(data); }).catch(e => setError(String(e))); setModel(localStorage.getItem(`summary-model:${projectId}`) ?? ''); return () => { disposed = true; }; }, [projectId, manuscript?.path]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = (await window.writer.aiTasks(projectId)).filter(t => t.mode === 'summary'); if (!disposed) { setTasks(next); timer = setTimeout(poll, next.some(t => t.status === 'running') ? 700 : 3000); } } catch (e) { if (!disposed) { setError(String(e)); timer = setTimeout(poll, 4000); } } };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const task = tasks.find(t => t.id === selected) ?? tasks[0]; const running = tasks.some(t => t.status === 'running');
  return <section className="ai-page"><header className="ai-heading"><div><small>STORY MEMORY</small><h1>章节摘要与故事记忆</h1><p>已保存正文 → 独立模型摘要 → 作者核对 → 确认后用于本书 AI。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="ai-columns"><aside className="ai-panel ai-form"><h2>生成章节摘要</h2><p>当前章节：{manuscript?.path ?? '请先在写作空间打开章节'}</p>
      <label>摘要模型<select aria-label="摘要模型" value={model} disabled={busy || running} onChange={e => { setModel(e.target.value); localStorage.setItem(`summary-model:${projectId}`, e.target.value); }}><option value="">选择独立摘要连接</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label>
      <label className="ai-check"><input type="checkbox" aria-label="保存章节后自动生成摘要草稿" checked={autoSummary} disabled={busy} onChange={e => { setAutoSummary(e.target.checked); localStorage.setItem(`auto-summary:${projectId}`, String(e.target.checked)); }} />保存章节后自动生成摘要草稿（只生成草稿，不自动确认，也不会自动启用进故事记忆）</label>
      {autoSummary && !model && <p className="notice">请先选择摘要模型，否则保存章节时不会生成草稿。</p>}
      <button className="primary" disabled={busy || running || blocked || !model || !manuscript?.managed} onClick={() => void run(async () => { if (!manuscript) return; const next = await window.writer.startSummary({ projectId, chapterPath: manuscript.path, sourceHash: manuscript.hash, connectionId: model }); setTasks(current => [next, ...current]); setSelected(next.id); })}>生成本章摘要</button>
      <p>只发送当前已保存章节，不发送参考小说或未确认的筹备稿。摘要模型调用可能计费。</p>{blocked && <p className="notice">请先保存当前修改。</p>}
      <details className="memory-batch" onToggle={event => { if ((event.target as HTMLDetailsElement).open) void window.writer.chapters(projectId).then(files => { if (alive.current) setChapters(files); }).catch(() => {}); }}><summary>批量生成摘要（按顺序逐章，逐章计费）</summary>
        <div className="memory-batch-actions"><button type="button" disabled={busy} onClick={() => setPicked(chapters.slice(0, 20).map(chapter => chapter.path))}>全选</button><button type="button" disabled={busy} onClick={() => setPicked([])}>清空</button><span>已选 {picked.length} / {chapters.length} 章</span></div>
        <div className="memory-batch-list">{chapters.map(chapter => <label key={chapter.path}><input type="checkbox" disabled={busy} checked={picked.includes(chapter.path)} onChange={e => setPicked(current => e.target.checked ? [...current, chapter.path] : current.filter(path => path !== chapter.path))} />{chapter.name}</label>)}{chapters.length === 0 && <p className="usage-scope">本书还没有已保存章节。</p>}</div>
        <div className="detection-connection-actions"><button className="primary" type="button" disabled={busy || !model || picked.length === 0 || !!batch?.running} onClick={startBatch}>批量生成所选章节摘要</button><button type="button" disabled={!batch?.running} onClick={() => void run(() => window.writer.cancelSummaryBatch(projectId))}>停止批量摘要</button></div>
        {batch && <div className="memory-batch-progress"><p>进度 {batch.completed}/{batch.total} · 成功 {batch.created} · 失败 {batch.failures.length}{batch.running ? ' · 进行中' : ' · 已结束'}</p>{batch.running && batch.current && <p className="usage-scope">正在摘要：{batch.current}</p>}{batch.failures.slice(0, 5).map(failure => <p key={failure.path} className="usage-warning">{failure.path}：{failure.message}</p>)}</div>}
        <p className="usage-scope">逐章顺序生成，每章一次模型调用；启动前核对全部章节版本，单章失败不影响其余章节，可停止。生成结果只是草稿，必须逐条确认才会进入故事记忆。</p>
      </details>
      {task && <><h2>摘要历史</h2><select aria-label="摘要任务历史" value={task.id} onChange={e => setSelected(e.target.value)}>{tasks.map(t => <option key={t.id} value={t.id}>{t.chapterPath} · {t.status === 'complete' ? '已完成' : t.status === 'running' ? '生成中' : '未完成'} · {t.connection.name}</option>)}</select><pre className="material-output" aria-label="摘要 AI 输出">{task.text || '等待摘要…'}</pre>{task.error && <p>{task.error}</p>}
      <div className="actions"><button disabled={busy || task.status !== 'complete'} onClick={() => { setPreview(task.text); setDraftTask(task.id); setDirty(true); }}>放入摘要确认稿</button>{task.status === 'running' && <button disabled={busy} onClick={() => void run(() => window.writer.cancelAI(projectId, task.id))}>停止摘要</button>}</div></>}
      <button disabled={busy} onClick={() => void run(async () => { setSnapshot(await window.writer.readMemories(projectId)); setMessage('已重新检查摘要来源，确认稿保留'); })}>刷新摘要来源与保存基准</button>
    </aside><article className="ai-panel ai-form"><h2>确认稿</h2>
      {restorable?.values.doc && <div className="notice" role="status">上次退出前有未保存的摘要确认稿（{new Date(restorable.updatedAt).toLocaleString()}）。<button disabled={busy} onClick={restoreDraft}>恢复上次草稿</button><button disabled={busy} onClick={discardDraft}>丢弃草稿</button></div>}
      <textarea className="material-preview" aria-label="摘要确认稿" disabled={busy} maxLength={10000} value={preview} onChange={e => { setPreview(e.target.value); setDirty(true); }} />
      <button disabled={busy || running || blocked || !snapshot || !draftTask || !preview.trim()} onClick={() => void run(async () => { const next = await window.writer.confirmSummary(projectId, draftTask, preview, snapshot!.hash); setSnapshot(next); setDirty(false); setPreview(''); setDraftTask(''); await window.writer.clearUiDraft(projectId, 'summary').catch(() => {}); setRestorable(null); setMessage('已确认保存并启用章节摘要'); })}>确认保存并启用摘要</button>
      <h2>事实与伏笔</h2>{snapshot && (() => { const usage = memoryUsage(snapshot.value, snapshot.staleIds); return <p className="usage-scope" aria-label="记忆预算占用">记忆预算 {usage.budget} 字节 · 事实占用 {usage.factsBytes}（纳入 {usage.includedFacts} 条，超预算跳过 {usage.skippedFacts} 条）· 摘要占用 {usage.summariesBytes}（纳入 {usage.includedSummaries} 条，跳过 {usage.skippedSummaries} 条）</p>; })()}<p>作者手写，不由模型生成；启用的条目按预算优先进入写作/审稿上下文，未解决伏笔会标注“未解决”。</p>
      <div className="actions"><select aria-label="事实类型" value={factKind} disabled={busy} onChange={e => setFactKind(e.target.value as 'fact' | 'foreshadow')}><option value="fact">事实</option><option value="foreshadow">伏笔</option></select><input aria-label="事实内容" disabled={busy} maxLength={2000} value={factText} placeholder="例如：月钥只能开启北门" onChange={e => setFactText(e.target.value)} /><button disabled={busy || !factText.trim() || !snapshot} onClick={addFact}>添加</button></div>
      <label className="ai-check"><input type="checkbox" aria-label="事实带当前章节来源" checked={factUseSource} disabled={busy || !manuscript?.managed} onChange={e => setFactUseSource(e.target.checked)} />记录当前章节作为来源（{manuscript?.path ?? '未打开章节'}）</label>
      {snapshot?.value.facts.map(fact => <div className="review-issue" key={fact.id}><strong>{fact.kind === 'fact' ? '事实' : '伏笔'} · {fact.state === 'open' ? '未解决' : '已解决'}</strong><p>{fact.text}</p><small>{fact.enabled ? '已启用' : '未启用'}{fact.sourcePath ? ` · 来源：${fact.sourcePath}` : ' · 无来源'}</small>
        <div className="actions"><button disabled={busy} onClick={() => toggleFact(fact, { enabled: !fact.enabled })}>{fact.enabled ? '停用' : '启用'}</button>{fact.kind === 'foreshadow' && <button disabled={busy} onClick={() => toggleFact(fact, { state: fact.state === 'open' ? 'resolved' : 'open' })}>{fact.state === 'open' ? '标记已解决' : '重新打开'}</button>}<button disabled={busy} onClick={() => removeFact(fact)}>删除</button></div></div>)}
      {!snapshot?.value.facts.length && <p>尚无事实或伏笔。手工录入的内容视为作者确认，不需要再走摘要确认。</p>}
      <h2>本书已确认摘要</h2><p>当前摘要预算 {snapshot?.value.budgetBytes ?? 6000} 字节，优先重要摘要，其后取最近确认的摘要；超限整条省略。只启用希望用于后续请求的章节。原文变化后自动排除旧摘要。</p>
      {snapshot?.value.entries.map(entry => { const stale = snapshot.staleIds.includes(entry.id); return <div className="review-issue" key={entry.id}><strong>{entry.sourcePath}</strong><p>{stale ? '原文已变化或不可读：该摘要不会发送' : '来源版本有效'} · {entry.model}</p><pre className="material-output">{entry.content}</pre>
        <div className="actions"><button disabled={busy || (stale && !entry.enabled)} onClick={() => void run(async () => { setSnapshot(await window.writer.updateMemory(projectId, entry.id, !entry.enabled, entry.important, snapshot.hash)); })}>{entry.enabled ? '停用摘要' : '启用摘要'}</button><button disabled={busy || stale} onClick={() => void run(async () => { setSnapshot(await window.writer.updateMemory(projectId, entry.id, entry.enabled, !entry.important, snapshot.hash)); })}>{entry.important ? '取消重要标记' : '标记为重要摘要'}</button></div></div>; })}
      {!snapshot?.value.entries.length && <p>尚无确认摘要。生成结果不会自动成为记忆。</p>}
    </article></div>
  </section>;
}
