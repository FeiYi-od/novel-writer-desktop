import { useEffect, useRef, useState } from 'react';
import type { BlueprintNodeView, BlueprintSnapshotView, Chapter } from '../../shared/contracts';
import { blueprintFor } from '../../core/blueprint';
import { useSaveBeforeExit } from './save-before-exit';

/** Volume/chapter plans: goals + beats, saved as project material, with a stale marker when the
 * chapter text has changed since the plan was written. */
export function BlueprintPanel({ projectId, volumes, chapters, blocked, onDirty, onClose }: {
  projectId: string; volumes: { id: string; title: string }[]; chapters: Chapter[]; blocked: boolean; onDirty: (value: boolean) => void; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<BlueprintSnapshotView | null>(null);
  const [nodes, setNodes] = useState<BlueprintNodeView[]>([]);
  const [scope, setScope] = useState<'volume' | 'chapter'>('chapter'), [ref, setRef] = useState('');
  const [title, setTitle] = useState(''), [goals, setGoals] = useState(''), [beats, setBeats] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const dirty = !!snapshot && JSON.stringify(nodes) !== JSON.stringify(snapshot.nodes);
  const load = async () => {
    const data = await window.writer.readBlueprints(projectId);
    setSnapshot(data); setNodes(data.nodes);
    return data;
  };
  useEffect(() => { let live = true; void load().catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [projectId]);
  const pick = (nextScope: 'volume' | 'chapter', nextRef: string, list = nodes) => {
    setScope(nextScope); setRef(nextRef);
    const existing = blueprintFor(list, nextScope, nextRef);
    setTitle(existing?.title ?? ''); setGoals(existing?.goals ?? ''); setBeats((existing?.beats ?? []).join('\n'));
  };
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useSaveBeforeExit('蓝图', () => ({ dirty, busy, save }));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  async function save() {
    if (!snapshot) throw new Error('蓝图未加载');
    const next = await window.writer.saveBlueprints(projectId, nodes, snapshot.hash);
    setSnapshot(next); setNodes(next.nodes); setMessage('蓝图已保存');
  }
  const upsert = async () => {
    const target = ref || (scope === 'chapter' ? chapters[0]?.path : volumes[0]?.id) || '';
    if (!target) { setError('本书还没有可写蓝图的分卷或章节'); return; }
    // Record the chapter's current hash so later text changes can be flagged as "source changed".
    let sourceHash: string | undefined;
    if (scope === 'chapter') sourceHash = await window.writer.readChapter(projectId, target).then(chapter => chapter.hash).catch(() => undefined);
    const entry: BlueprintNodeView = { id: nodes.find(node => node.scope === scope && node.ref === target)?.id ?? `pending-${Date.now()}`,
      scope, ref: target, title: title.trim() || (scope === 'volume' ? '分卷蓝图' : '章节蓝图'), goals: goals.trim(),
      beats: beats.split('\n').map(line => line.trim()).filter(Boolean), ...(sourceHash ? { sourceHash } : {}), updatedAt: '' };
    setNodes(current => [...current.filter(node => !(node.scope === scope && node.ref === target)), entry]);
    setError(''); setMessage('');
  };
  const stale = new Map((snapshot?.stale ?? []).map(item => [item.ref, item.title]));
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal blueprint-modal" role="dialog" aria-modal="true" aria-label="蓝图" onKeyDown={event => { if (event.key === 'Escape' && !busy && !blocked) onClose(); }}>
    <header><div><h2>分卷 / 章节蓝图</h2><p>写目标与情节点，按分卷或章节归档；章节正文改动后，对应的蓝图会提示来源已变化。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="blueprint-form">
      <label>归属<select aria-label="蓝图归属" disabled={busy || blocked} value={scope} onChange={e => { const next = e.target.value as 'volume' | 'chapter'; setScope(next); pick(next, ''); }}><option value="chapter">章节</option><option value="volume">分卷</option></select></label>
      <label>对象<select aria-label="蓝图对象" disabled={busy || blocked} value={ref} onChange={e => pick(scope, e.target.value)}><option value="">选择{scope === 'chapter' ? '章节' : '分卷'}</option>
        {scope === 'chapter' ? chapters.map(chapter => <option key={chapter.path} value={chapter.path}>{chapter.name}</option>) : volumes.map(volume => <option key={volume.id} value={volume.id}>{volume.title}</option>)}
      </select></label>
      <label>标题<input aria-label="蓝图标题" maxLength={120} disabled={busy || blocked} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>目标与要点<textarea aria-label="蓝图目标" maxLength={5000} disabled={busy || blocked} value={goals} onChange={e => setGoals(e.target.value)} /></label>
      <label>情节点（一行一条）<textarea aria-label="蓝图情节点" maxLength={15000} disabled={busy || blocked} value={beats} onChange={e => setBeats(e.target.value)} /></label>
      <button type="button" data-testid="blueprint-upsert" disabled={busy || blocked} onClick={() => void upsert()}>保存到蓝图草稿</button>
    </div>
    <ul className="blueprint-list" aria-label="蓝图列表">{nodes.map(node => <li key={node.id}>
      <strong>{node.title}</strong> · {node.scope === 'volume' ? `分卷 ${node.ref}` : node.ref}
      {stale.has(node.ref) && <span className="usage-warning">来源已变化，建议复核</span>}
      {node.goals && <p>{node.goals}</p>}{node.beats.length > 0 && <p>情节点 {node.beats.length} 条</p>}
      <button type="button" disabled={busy || blocked} onClick={() => pick(node.scope, node.ref)}>编辑</button>
      <button type="button" disabled={busy || blocked} onClick={() => setNodes(current => current.filter(item => item.id !== node.id))} aria-label={`删除蓝图 ${node.title}`}>删除</button>
    </li>)}</ul>
    {!nodes.length && <p>还没有蓝图。</p>}
    <footer><span>{dirty ? '有未保存改动' : '已保存'}</span><div><button disabled={busy} onClick={onClose}>关闭</button><button className="primary" data-testid="blueprint-save" disabled={busy || blocked || !dirty} onClick={() => void run(save)}>保存蓝图</button></div></footer>
  </section></div>;
}
