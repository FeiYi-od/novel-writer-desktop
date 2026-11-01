import { useEffect, useRef, useState } from 'react';
import type { AIConnection, AITask, UiDraft } from '../../shared/contracts';
import { materialTemplate, type MaterialKind } from '../../core/material-conversion';

export function Materials({ projectId, connections, blocked, onDirty, onSaved }: { projectId: string; connections: AIConnection[]; blocked: boolean; onDirty: (dirty: boolean) => void; onSaved: (projectId: string) => Promise<void> }) {
  const [kind, setKind] = useState<MaterialKind>('character'); const [source, setSource] = useState(''); const [name, setName] = useState('导入文段');
  const [preview, setPreview] = useState(''); const [model, setModel] = useState(''); const [location, setLocation] = useState('');
  const [hashes, setHashes] = useState({ character: '', world: '' }); const [tasks, setTasks] = useState<AITask[]>([]); const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const refresh = async () => { const [characters, notes, directory] = await Promise.all([window.writer.readCharacters(projectId), window.writer.readNotes(projectId), window.writer.materialLocation(projectId)]); setHashes({ character: characters.hash, world: notes.hash }); setLocation(directory); };
  useEffect(() => { void refresh().catch(e => setError(String(e))); }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  // Unsaved conversion input survives an exit; restoring is always an explicit author action.
  const [restorable, setRestorable] = useState<UiDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const draftLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    void window.writer.readUiDraft(projectId, 'materials').then(value => { if (live) { draftLoaded.current = true; setRestorable(value); } }).catch(() => { draftLoaded.current = true; });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => {
    if (!draftLoaded.current || !dirty) return;
    const timer = setTimeout(() => { void window.writer.saveUiDraft(projectId, 'materials', { doc: JSON.stringify({ kind, source, name, preview, model }) }).then(() => setDraftError('')).catch(e => setDraftError('未保存草稿自动备份失败，请保留当前页面并先保存或复制内容：' + String(e))); }, 800);
    return () => clearTimeout(timer);
  }, [dirty, projectId, kind, source, name, preview, model]);
  const restoreDraft = () => {
    if (!restorable?.values.doc) return;
    try {
      const value = JSON.parse(restorable.values.doc) as { kind?: MaterialKind; source?: string; name?: string; preview?: string; model?: string };
      if (value.kind) setKind(value.kind);
      if (typeof value.source === 'string') setSource(value.source);
      if (typeof value.name === 'string') setName(value.name);
      if (typeof value.preview === 'string') setPreview(value.preview);
      if (typeof value.model === 'string') setModel(value.model);
      setDirty(true); setRestorable(null); setMessage('已恢复上次未保存的资料转换草稿，尚未确认保存');
    } catch { setError('上次的资料转换草稿无法解析，已保留原文件'); }
  };
  const discardDraft = () => { void window.writer.clearUiDraft(projectId, 'materials').catch(() => {}); setRestorable(null); };
  useEffect(() => { let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const list = (await window.writer.aiTasks(projectId)).filter(t => t.mode === 'character' || t.mode === 'world'); if (!disposed) { setTasks(list); timer = setTimeout(poll, list.some(t => t.status === 'running') ? 800 : 4000); } } catch (e) { if (!disposed) setError(String(e)); } };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const task = tasks.find(t => t.id === selected) ?? tasks[0]; const running = tasks.some(t => t.status === 'running');
  return <section className="ai-page"><header className="ai-heading"><div><small>MANUSCRIPT TO MATERIALS</small><h1>资料转换</h1><p>DOCX / TXT → 固定格式人物卡或世界观 → 确认保存 Markdown</p></div></header>
    <p className="material-location">本书固定资料目录：{location || '正在读取…'}</p>
    {error && <div role="alert" className="error">{error}</div>}{draftError && <div role="alert" className="error">{draftError}</div>}{message && <p role="status">{message}</p>}
    <div className="ai-columns"><aside className="ai-panel ai-form"><h2>导入与整理</h2>
      {restorable?.values.doc && <div className="notice" role="status">上次退出前有未保存的资料转换草稿（{new Date(restorable.updatedAt).toLocaleString()}）。<button disabled={busy} onClick={restoreDraft}>恢复上次草稿</button><button disabled={busy} onClick={discardDraft}>丢弃草稿</button></div>}
      <button disabled={busy || running} onClick={() => void run(async () => { const imported = await window.writer.importMaterialText(projectId); if (imported) { setSource(imported.text); setName(imported.name); setDirty(true); } })}>导入 DOCX / TXT 文段</button>
      <label>资料类型<select aria-label="资料类型" value={kind} disabled={busy || running} onChange={e => setKind(e.target.value as MaterialKind)}><option value="character">人物卡</option><option value="world">世界观</option></select></label>
      <label>原文<textarea aria-label="转换原文" maxLength={100000} value={source} onChange={e => { setSource(e.target.value); setDirty(true); }} /></label>
      <button disabled={busy || !source.trim()} onClick={() => { setPreview(materialTemplate(kind, source, name.replace(/\.(docx|txt)$/i, ''))); setDirty(true); }}>套用模板（不调用 AI）</button>
      <label>整理模型<select aria-label="整理模型" value={model} onChange={e => setModel(e.target.value)}><option value="">选择模型</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label>
      <button disabled={busy || running || !source.trim() || !model} onClick={() => void run(async () => { const next = await window.writer.startMaterialAI({ projectId, connectionId: model, kind, sourceName: name, sourceText: source }); setTasks(current => [next, ...current]); setSelected(next.id); })}>用 AI 整理资料</button>
      <p>仅发送上方文段。模型可能漏提或误解信息，请核对后确认。新人物卡默认不启用；世界观追加到现有资料。</p>
      <button disabled={busy} onClick={() => void run(async () => { await refresh(); setMessage('已刷新本书保存基准，转换稿保留'); })}>重新读取保存基准</button>
    </aside><article className="ai-panel ai-form"><h2>Markdown 保存预览</h2><textarea className="material-preview" aria-label="Markdown 资料预览" value={preview} maxLength={100000} onChange={e => { setPreview(e.target.value); setDirty(true); }} />
      <button className="primary" disabled={busy || running || blocked || !preview.trim()} onClick={() => void run(async () => { await window.writer.saveMaterial(projectId, kind, preview, hashes[kind]); await refresh(); await onSaved(projectId); setDirty(false); await window.writer.clearUiDraft(projectId, 'materials').catch(() => {}); setRestorable(null); setMessage(kind === 'character' ? '已确认保存人物卡.md，请到角色库勾选启用' : '已确认追加世界观到创作笔记.md'); })}>确认保存 Markdown 资料</button>
      {blocked && <p className="notice">请先保存其他页面的正文或资料。</p>}
      {task && <><h2>AI 整理结果</h2><select aria-label="资料转换历史" value={task.id} onChange={e => setSelected(e.target.value)}>{tasks.map(t => <option key={t.id} value={t.id}>{t.mode === 'character' ? '人物卡' : '世界观'} · {t.status} · {t.connection.name}</option>)}</select><pre className="material-output" aria-label="资料 AI 输出">{task.text || '等待模型输出…'}</pre>{task.error && <p>{task.error}</p>}
        <div className="actions"><button disabled={task.status !== 'complete' || busy} onClick={() => { setKind(task.mode as MaterialKind); setPreview(task.text); setDirty(true); }}>将结果放入保存预览</button>{task.status === 'running' && <button disabled={busy} onClick={() => void run(() => window.writer.cancelAI(projectId, task.id))}>停止整理</button>}</div></>}
    </article></div>
  </section>;
}
