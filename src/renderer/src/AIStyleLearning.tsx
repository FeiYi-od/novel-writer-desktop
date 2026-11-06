import { useEffect, useRef, useState } from 'react';
import type { AIConnection, AITask, BookSnapshot, UiDraft } from '../../shared/contracts';
import { parseLearnedStyle } from '../../core/style-learning';
export function AIStyleLearning({ snapshot, sourceIds, name, connections, blocked, onUpdate, onDirty }: { snapshot: BookSnapshot; sourceIds: string[]; name: string; connections: AIConnection[]; blocked: boolean; onUpdate: (next: BookSnapshot) => void; onDirty: (dirty: boolean) => void }) {
  const projectId = snapshot.value.projectId;
  const [model, setModel] = useState('');
  const [plan, setPlan] = useState<{ key: string; value: Awaited<ReturnType<typeof window.writer.previewStyleChunks>> } | null>(null);
  const [mode, setMode] = useState<'sample' | 'full'>('sample'); const [tasks, setTasks] = useState<AITask[]>([]); const [selected, setSelected] = useState('');
  const [rules, setRules] = useState(''); const [draftName, setDraftName] = useState(''); const [origin, setOrigin] = useState('');
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { setModel(localStorage.getItem(`style-model:${projectId}`) ?? ''); }, [projectId]);
  // The learned-style confirmation draft survives an exit; restoring is an explicit action.
  const [restorable, setRestorable] = useState<UiDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const draftLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(projectId, 'style').then(value => { if (live) { draftLoaded.current = true; setRestorable(value); } }).catch(() => { draftLoaded.current = true; });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (!draftLoaded.current || !dirty) return;
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'style', { doc: JSON.stringify({ rules, draftName, origin }) }).then(() => setDraftError('')).catch(e => setDraftError('未保存草稿自动备份失败，请保留当前页面并先保存或复制内容：' + String(e))); }, 800);
    return () => clearTimeout(timer);
  }, [dirty, projectId, rules, draftName, origin]);
  const restoreDraft = () => {
    if (!restorable?.values.doc) return;
    try {
      const value = JSON.parse(restorable.values.doc) as { rules?: string; draftName?: string; origin?: string };
      if (typeof value.rules === 'string') setRules(value.rules);
      if (typeof value.draftName === 'string') setDraftName(value.draftName);
      if (typeof value.origin === 'string') setOrigin(value.origin);
      setDirty(true); setRestorable(null); setMessage('已恢复上次未保存的文风确认稿，尚未确认保存');
    } catch { setError('上次的文风草稿无法解析，已保留原文件'); }
  };
  const discardDraft = () => { void window.writer.clearUiDraft(projectId, 'style').catch(() => {}); setRestorable(null); };
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useEffect(() => { let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const list = (await window.writer.aiTasks(projectId)).filter(t => t.mode === 'style-analysis'); if (!disposed) { setTasks(list); timer = setTimeout(poll, list.some(t => t.status === 'running') ? 700 : 3000); } } catch (e) { if (!disposed) { setError(String(e)); timer = setTimeout(poll, 4000); } } };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const planKey = JSON.stringify([projectId, snapshot.hash, model, mode, sourceIds]);
  const activePlan = plan?.key === planKey ? plan.value : null;
  const task = tasks.find(t => t.id === selected) ?? tasks[0]; const running = tasks.some(t => t.status === 'running');
  const source = task?.styleSource;
  const indexes = new Set((source?.chunkNotes ?? []).filter(item => item.index >= 1 && item.index <= (source?.chunks ?? 0) && item.note.trim()).map(item => item.index));
  const fullComplete = source?.mode !== 'full' || (source.planVersion === 2 && !!source.chunks && indexes.size === source.chunks && source.chunkNotes?.length === source.chunks);
  const shownStatus = (item: AITask) => item.status === 'complete' && item.styleSource?.mode === 'full' && (item.styleSource.planVersion !== 2 || !(item.styleSource.chunks) || new Set((item.styleSource.chunkNotes ?? []).filter(note => note.index >= 1 && note.index <= (item.styleSource?.chunks ?? 0) && note.note.trim()).map(note => note.index)).size !== item.styleSource.chunks || item.styleSource.chunkNotes?.length !== item.styleSource.chunks) ? '分段未完成' : item.status === 'complete' ? '已完成' : item.status === 'running' ? '分析中' : '未完成';
  let limitations: string[] = []; let output = task?.text ?? '';
  if (task?.status === 'complete') { try { const parsed = parseLearnedStyle(task.text); limitations = parsed.limitations; output = parsed.rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n\n'); } catch {} }
  return <section className="ai-panel ai-form style-learning-panel"><h2>模型文风分析</h2><p>使用上方勾选的参考文本和同一个文风名称；可直接选择模型分析，无需先运行本地统计。只提炼表达方法，模型分析不等于微调训练。</p>
    {error && <div role="alert" className="error">{error}</div>}{draftError && <div role="alert" className="error">{draftError}</div>}{message && <p role="status">{message}</p>}
    <label>文风分析模型<select aria-label="文风分析模型" value={model} disabled={busy || running} onChange={e => { setModel(e.target.value); localStorage.setItem(`style-model:${projectId}`, e.target.value); }}><option value="">选择分析连接</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label>
    <label className="style-scope-label">分析范围<select aria-label="模型分析范围" value={mode} disabled={busy || running} onChange={e => setMode(e.target.value as 'sample' | 'full')}><option value="sample">快速采样</option><option value="full">全文分段</option></select></label>{mode === 'full' && <button disabled={busy || running || !sourceIds.length || !model} data-testid="style-plan" onClick={() => void run(async () => { const value = await window.writer.previewStyleChunks(projectId, sourceIds, snapshot.hash, model); setPlan({ key: planKey, value }); })}>预估请求</button>}<button className="primary" disabled={busy || running || blocked || !sourceIds.length || !name.trim() || !model} onClick={() => void run(async () => { const next = await window.writer.startStyleLearning({ projectId, sourceIds, name, connectionId: model, expectedHash: snapshot.hash, mode, expectedPlanFingerprint: activePlan?.planFingerprint }); setPlan(null); setTasks(current => [next, ...current]); setSelected(next.id); })}>用模型分析选中语料</button>
    {mode === 'full' && activePlan && <p role="status" data-testid="style-plan-result">{activePlan.modelName} · {activePlan.model}：{activePlan.chunks} 段、{activePlan.totalCharacters.toLocaleString()} 字符，单段 {activePlan.smallestChunkCharacters}–{activePlan.largestChunkCharacters} 字符；基础 {activePlan.estimatedRequests} 次调用（逐段与最终汇总）。失败重试及分层压缩会增加调用，费用以服务商为准。</p>}
    <p>仅发送本书选中的参考样本，不发送正文、人物或世界观。{mode === 'full' ? '全文分段：按模型预算切块逐段分析，段数与覆盖范围会写进任务；分段笔记超出预算时会先分层压缩，每组会额外调用一次模型；失败分段最多自动重试一次，继续任务也会产生调用。' : '快速采样：长文本分散采样，可能遗漏局部风格。'}调用可能计费。</p>
    {task && <><select aria-label="文风分析历史" value={task.id} onChange={e => setSelected(e.target.value)}>{tasks.map(t => <option key={t.id} value={t.id}>{t.styleSource?.name} · {shownStatus(t)} · {t.connection.name}</option>)}</select>
      <p>{task.styleSource?.sampled ? '已采样' : task.styleSource?.mode === 'full' && !fullComplete ? '全文分析未完成' : '完整样本'} · 本次 {task.styleSource?.sampleCharacters} / 总计 {task.styleSource?.totalCharacters} 字符{task.styleSource?.layers ? ` · 计划 ${task.styleSource.layers} 组压缩` : ''}{task.styleSource?.mode === 'full' ? ` · 已完成 ${indexes.size}/${task.styleSource?.chunks ?? 0} 段` : ''}</p>
      {!fullComplete && <p role="status">部分分段未完成，不能保存为完整文风；已完成的笔记会保留。</p>}
      <pre className="material-output" aria-label="文风模型输出">{output || '等待分析结果…'}</pre>{task.error && <p>{task.error}</p>}
      {limitations.length > 0 && <p>分析局限：{limitations.join('；')}</p>}
      <div className="actions"><button disabled={busy || task.status !== 'complete' || !fullComplete} onClick={() => void run(async () => { const parsed = parseLearnedStyle(task.text); setRules(parsed.rules.join('\n')); setDraftName(task.styleSource?.name ?? '模型文风'); setOrigin(task.id); setDirty(true); })}>放入文风确认稿</button>{task.status === 'running' && <button disabled={busy} onClick={() => void run(() => window.writer.cancelAI(projectId, task.id))}>停止文风分析</button>}{task.status !== 'running' && (task.status !== 'complete' || !fullComplete) && task.styleSource?.mode === 'full' && <button data-testid="style-resume" disabled={busy} onClick={() => void run(async () => { await window.writer.resumeStyleLearning(projectId, task.id); setTasks(await window.writer.aiTasks(projectId)); })}>继续未完成的分段分析</button>}</div></>}
    {restorable?.values.doc && <div className="notice" role="status">上次退出前有未保存的文风确认稿（{new Date(restorable.updatedAt).toLocaleString()}）。<button disabled={busy} onClick={restoreDraft}>恢复上次草稿</button><button disabled={busy} onClick={discardDraft}>丢弃草稿</button></div>}
    {origin && <p>将使用分析时的名称「{draftName}」保存。</p>}
    <details><summary>需要时修改保存名称</summary><label>保存名称<input aria-label="模型文风名称" value={draftName} maxLength={100} disabled={busy} onChange={e => { setDraftName(e.target.value); setDirty(true); }} /></label></details>
    <label>文风规则确认稿<textarea aria-label="文风规则确认稿" value={rules} maxLength={20000} disabled={busy} onChange={e => { setRules(e.target.value); setDirty(true); }} /></label>
    <button disabled={busy || running || blocked || !origin || !rules.trim() || !draftName.trim()} onClick={() => void run(async () => { const next = await window.writer.confirmStyleLearning(projectId, origin, draftName, rules, snapshot.hash); onUpdate(next); setRules(''); setOrigin(''); setDirty(false); await window.writer.clearUiDraft(projectId, 'style').catch(() => {}); setRestorable(null); setMessage('已确认保存模型文风，点击用于本书后生效'); })}>确认保存模型文风</button>
    <button disabled={busy} onClick={() => void run(async () => { onUpdate(await window.writer.readBook(projectId)); setMessage('已刷新资料，文风确认稿保留'); })}>刷新文风保存基准</button>
  </section>;
}
