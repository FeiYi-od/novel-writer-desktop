import { useEffect, useRef, useState } from 'react';
import type { AIConnection, AITask, BookSnapshot, UiDraft } from '../../shared/contracts';
import { parseLearnedStyle } from '../../core/style-learning';
export function AIStyleLearning({ snapshot, sourceIds, name, connections, blocked, onUpdate, onDirty }: { snapshot: BookSnapshot; sourceIds: string[]; name: string; connections: AIConnection[]; blocked: boolean; onUpdate: (next: BookSnapshot) => void; onDirty: (dirty: boolean) => void }) {
  const projectId = snapshot.value.projectId;
  const [model, setModel] = useState(''); const [tasks, setTasks] = useState<AITask[]>([]); const [selected, setSelected] = useState('');
  const [rules, setRules] = useState(''); const [draftName, setDraftName] = useState(''); const [origin, setOrigin] = useState('');
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { setModel(localStorage.getItem(`style-model:${projectId}`) ?? ''); }, [projectId]);
  // The learned-style confirmation draft survives an exit; restoring is an explicit action.
  const [restorable, setRestorable] = useState<UiDraft | null>(null);
  const draftLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(projectId, 'style').then(value => { if (live) { draftLoaded.current = true; setRestorable(value); } }).catch(() => { draftLoaded.current = true; });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (!draftLoaded.current || !dirty) return;
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'style', { doc: JSON.stringify({ rules, draftName, origin }) }).catch(() => {}); }, 800);
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
  const task = tasks.find(t => t.id === selected) ?? tasks[0]; const running = tasks.some(t => t.status === 'running');
  let limitations: string[] = []; let output = task?.text ?? '';
  if (task?.status === 'complete') { try { const parsed = parseLearnedStyle(task.text); limitations = parsed.limitations; output = parsed.rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n\n'); } catch {} }
  return <section className="ai-panel ai-form style-learning-panel"><h2>模型文风分析</h2><p>使用左侧勾选的参考文本和文风名称。只提炼表达方法，模型分析不等于微调训练。</p>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <label>文风分析模型<select aria-label="文风分析模型" value={model} disabled={busy || running} onChange={e => { setModel(e.target.value); localStorage.setItem(`style-model:${projectId}`, e.target.value); }}><option value="">选择分析连接</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label>
    <button className="primary" disabled={busy || running || blocked || !sourceIds.length || !name.trim() || !model} onClick={() => void run(async () => { const next = await window.writer.startStyleLearning({ projectId, sourceIds, name, connectionId: model, expectedHash: snapshot.hash }); setTasks(current => [next, ...current]); setSelected(next.id); })}>用模型分析选中语料</button>
    <p>仅发送本书选中的参考样本，不发送正文、人物或世界观。长文本分散采样，可能遗漏局部风格；调用可能计费。</p>
    {task && <><select aria-label="文风分析历史" value={task.id} onChange={e => setSelected(e.target.value)}>{tasks.map(t => <option key={t.id} value={t.id}>{t.styleSource?.name} · {t.status === 'complete' ? '已完成' : t.status === 'running' ? '分析中' : '未完成'} · {t.connection.name}</option>)}</select>
      <p>{task.styleSource?.sampled ? '已采样' : '完整样本'} · 本次 {task.styleSource?.sampleCharacters} / 总计 {task.styleSource?.totalCharacters} 字符</p>
      <pre className="material-output" aria-label="文风模型输出">{output || '等待分析结果…'}</pre>{task.error && <p>{task.error}</p>}
      {limitations.length > 0 && <p>分析局限：{limitations.join('；')}</p>}
      <div className="actions"><button disabled={busy || task.status !== 'complete'} onClick={() => void run(async () => { const parsed = parseLearnedStyle(task.text); setRules(parsed.rules.join('\n')); setDraftName(task.styleSource?.name ?? '模型文风'); setOrigin(task.id); setDirty(true); })}>放入文风确认稿</button>{task.status === 'running' && <button disabled={busy} onClick={() => void run(() => window.writer.cancelAI(projectId, task.id))}>停止文风分析</button>}</div></>}
    {restorable?.values.doc && <div className="notice" role="status">上次退出前有未保存的文风确认稿（{new Date(restorable.updatedAt).toLocaleString()}）。<button disabled={busy} onClick={restoreDraft}>恢复上次草稿</button><button disabled={busy} onClick={discardDraft}>丢弃草稿</button></div>}
    <label>模型文风名称<input aria-label="模型文风名称" value={draftName} maxLength={100} disabled={busy} onChange={e => { setDraftName(e.target.value); setDirty(true); }} /></label>    <label>文风规则确认稿<textarea aria-label="文风规则确认稿" value={rules} maxLength={20000} disabled={busy} onChange={e => { setRules(e.target.value); setDirty(true); }} /></label>
    <button disabled={busy || running || blocked || !origin || !rules.trim() || !draftName.trim()} onClick={() => void run(async () => { const next = await window.writer.confirmStyleLearning(projectId, origin, draftName, rules, snapshot.hash); onUpdate(next); setRules(''); setOrigin(''); setDirty(false); await window.writer.clearUiDraft(projectId, 'style').catch(() => {}); setRestorable(null); setMessage('已确认保存模型文风，点击用于本书后生效'); })}>确认保存模型文风</button>
    <button disabled={busy} onClick={() => void run(async () => { onUpdate(await window.writer.readBook(projectId)); setMessage('已刷新资料，文风确认稿保留'); })}>刷新文风保存基准</button>
  </section>;
}
