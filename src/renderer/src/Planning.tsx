import { useEffect, useRef, useState } from 'react';
import type { AIConnection, AITask, PlanningKind, PlanningSnapshot, UiDraft } from '../../shared/contracts';
import { planningHeadings, planningKinds, planningLabels } from '../../core/planning';
const statusLabels: Record<AITask['status'], string> = { running: '生成中', complete: '已完成', incomplete: '未完整结束', cancelled: '已停止', failed: '失败', interrupted: '上次中断' };
export function Planning({ projectId, connections, blocked, onDirty, onSaved }: { projectId: string; connections: AIConnection[]; blocked: boolean; onDirty: (dirty: boolean) => void; onSaved: (id: string) => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<PlanningSnapshot | null>(null); const [kind, setKind] = useState<PlanningKind>('outline');
  const [model, setModel] = useState(''); const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<AITask[]>([]); const [selected, setSelected] = useState('');
  const [hashes, setHashes] = useState({ world: '', character: '' }); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [restorable, setRestorable] = useState<UiDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const lock = useRef(false);
  const refresh = async () => { const [data, notes, cards] = await Promise.all([window.writer.readPlanning(projectId), window.writer.readNotes(projectId), window.writer.readCharacters(projectId)]); setSnapshot(data); setHashes({ world: notes.hash, character: cards.hash }); setDirty(false); };
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  // Unsaved input survives an exit: read the draft once, keep editing silently, and only offer it.
  useEffect(() => {
    let cancelled = false;
    void window.writer.readUiDraft(projectId, 'planning').then(draft => { if (!cancelled) setRestorable(draft); }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);
  useEffect(() => {
    if (!dirty || !snapshot) return;
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'planning', { doc: JSON.stringify(snapshot.value) }).then(() => setDraftError('')).catch(e => setDraftError('未保存草稿自动备份失败，请保留当前页面并先保存或复制内容：' + String(e))); }, 800);
    return () => clearTimeout(timer);
  }, [dirty, projectId, snapshot]);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const list = (await window.writer.aiTasks(projectId)).filter(t => t.mode.startsWith('plan-')); if (!disposed) { setTasks(list); timer = setTimeout(poll, list.some(t => t.status === 'running') ? 700 : 2500); } } catch (e) { if (!disposed) { setError(String(e)); timer = setTimeout(poll, 4000); } } };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);
  const run = async (action: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e)); } finally { lock.current = false; setBusy(false); } };
  const edit = (group: 'prompts' | 'briefs' | 'drafts', text: string) => { setSnapshot(current => current && ({ ...current, value: { ...current.value, [group]: { ...current.value[group], [kind]: text } } })); setDirty(true); };
  const persist = async () => { if (!snapshot) throw new Error('筹备资料未加载'); const next = await window.writer.savePlanning(projectId, snapshot.value, snapshot.hash); setSnapshot(next); setDirty(false); await window.writer.clearUiDraft(projectId, 'planning').catch(() => {}); setRestorable(null); return next; };
  const restoreDraft = () => {
    if (!snapshot || !restorable?.values.doc) return;
    try {
      const value = JSON.parse(restorable.values.doc) as PlanningSnapshot['value'];
      setSnapshot(current => current && ({ ...current, value })); setDirty(true); setRestorable(null); setMessage('已恢复上次未保存的筹备草稿，尚未保存到资料');
    } catch { setError('上次的筹备草稿无法解析，已保留原文件'); }
  };
  const discardDraft = () => { void window.writer.clearUiDraft(projectId, 'planning').catch(() => {}); setRestorable(null); };
  const task = tasks.find(t => t.id === selected) ?? tasks.find(t => t.mode === `plan-${kind}`);
  const running = tasks.some(t => t.status === 'running');
  return <section className="ai-page planning-page"><header className="ai-heading"><div><small>STORY WORKSHOP</small><h1>创作筹备</h1><p>从构想到设定：保存提示词与草稿，确认后用于本书写作和审稿。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{draftError && <div role="alert" className="error">{draftError}</div>}{message && <p role="status">{message}</p>}
    {restorable?.values.doc && <div className="notice" role="status">上次退出前有未保存的筹备草稿（{new Date(restorable.updatedAt).toLocaleString()}）。<button disabled={busy} onClick={restoreDraft}>恢复上次草稿</button><button disabled={busy} onClick={discardDraft}>丢弃草稿</button></div>}
    {snapshot && <><div className="planning-tabs">{planningKinds.map(item => <button key={item} className={kind === item ? 'active' : ''} disabled={busy} onClick={() => { setKind(item); setSelected(''); }}>{planningLabels[item]}</button>)}</div>
    <div className="ai-columns"><aside className="ai-panel ai-form"><h2>创作要求</h2>
      <label>本书提示词<textarea aria-label="筹备提示词" disabled={busy} maxLength={20000} value={snapshot.value.prompts[kind]} onChange={e => edit('prompts', e.target.value)} /></label>
      <label>创作构想<textarea aria-label="筹备构想" disabled={busy} maxLength={50000} value={snapshot.value.briefs[kind]} placeholder="题材、主题、人物目标、期望走向或需要解决的问题……" onChange={e => edit('briefs', e.target.value)} /></label>
      <button disabled={busy || !dirty} onClick={() => void run(async () => { await persist(); setMessage('筹备提示词与草稿已保存'); })}>保存筹备资料</button>
      <label>筹备模型<select aria-label="筹备模型" value={model} disabled={busy || running} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label>
      <button className="primary" disabled={busy || running || blocked || !model || !snapshot.value.briefs[kind].trim() || !snapshot.value.prompts[kind].trim()} onClick={() => void run(async () => { const saved = await persist(); const next = await window.writer.startPlanningAI({ projectId, connectionId: model, kind, expectedHash: saved.hash }); setTasks(current => [next, ...current]); setSelected(next.id); setMessage('正在生成筹备草稿，完成后请核对并确认'); })}>生成筹备草稿</button>
      <p>发送本页提示词、构想与本书已确认的设定。草稿不自动成为正式设定；新角色确认后仍需到角色库启用。</p>
      {blocked && <p className="notice">请先保存其他页面的正文或设定。</p>}
      <button disabled={busy || running} onClick={() => { if (!dirty || window.confirm('重新读取会放弃本页未保存修改，是否继续？')) void run(refresh); }}>重新读取筹备资料</button>
    </aside><article className="ai-panel ai-form"><h2>{planningLabels[kind]}草稿</h2>
      <textarea className="material-preview" aria-label="筹备草稿" value={snapshot.value.drafts[kind]} disabled={busy} maxLength={100000} onChange={e => edit('drafts', e.target.value)} />
      <div className="actions"><button disabled={busy || !!snapshot.value.drafts[kind]} onClick={() => edit('drafts', planningHeadings[kind].map(h => `## ${h}\n\n待确认`).join('\n\n'))}>填入空白结构</button>
      <button className="primary" disabled={busy || running || dirty || blocked || !snapshot.value.drafts[kind].trim()} onClick={() => void run(async () => { await window.writer.acceptPlanning(projectId, kind, snapshot.hash, kind === 'outline' ? snapshot.hash : hashes[kind]); await refresh(); await onSaved(projectId); setMessage(kind === 'outline' ? '已确认采用故事大纲，后续写作与审稿将使用它' : kind === 'world' ? '已确认追加世界观' : '已确认新增角色，请到角色库启用'); })}>{kind === 'outline' ? '确认采用为本书大纲' : kind === 'world' ? '确认追加到本书世界观' : '确认新增角色卡'}</button></div>
      {dirty && <p>请先保存筹备资料，再确认采用。</p>}
      {task && <><h2>模型结果 · {statusLabels[task.status]}</h2><select aria-label="筹备生成历史" value={task.id} onChange={e => setSelected(e.target.value)}>{tasks.filter(t => t.mode === `plan-${kind}`).map(t => <option key={t.id} value={t.id}>{new Date(t.createdAt).toLocaleString()} · {statusLabels[t.status]} · {t.connection.name}</option>)}</select><pre className="material-output" aria-label="筹备 AI 输出">{task.text || '等待模型输出…'}</pre>{task.error && <p>{task.error}</p>}
      <div className="actions"><button disabled={busy || task.status !== 'complete'} onClick={() => { setSnapshot(current => current && ({ ...current, value: { ...current.value, drafts: { ...current.value.drafts, [kind]: task.text }, originTasks: { ...current.value.originTasks, [kind]: task.id } } })); setDirty(true); }}>放入可编辑草稿</button><button disabled={!task.text} onClick={() => void run(async () => { await window.writer.copyText(task.text); setMessage('筹备结果已复制'); })}>复制筹备结果</button>{task.status === 'running' && <button disabled={busy} onClick={() => void run(() => window.writer.cancelAI(projectId, task.id))}>停止筹备生成</button>}</div></>}
      <details><summary>当前已确认故事大纲</summary><pre className="material-output">{snapshot.value.outline || '尚未确认大纲。'}</pre></details>
    </article></div></>}
  </section>;
}
