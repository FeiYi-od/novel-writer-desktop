import { useEffect, useRef, useState } from 'react';
import type { CharacterStateSnapshotView, CharacterStateView, Chapter } from '../../shared/contracts';
import { describeRange, statesForChapter } from '../../core/character-states';
import { useSaveBeforeExit } from './save-before-exit';

/** Character states with chapter ranges; shows which states apply to the chapter being edited. */
export function StatesPanel({ projectId, chapters, currentPosition, blocked, onDirty, onClose }: {
  projectId: string; chapters: Chapter[]; currentPosition: number; blocked: boolean; onDirty: (value: boolean) => void; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<CharacterStateSnapshotView | null>(null);
  const [states, setStates] = useState<CharacterStateView[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [character, setCharacter] = useState(''), [label, setLabel] = useState(''), [note, setNote] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const dirty = !!snapshot && JSON.stringify(states) !== JSON.stringify(snapshot.states);
  useEffect(() => {
    let live = true;
    void Promise.all([window.writer.readCharacterStates(projectId), window.writer.readCharacters(projectId)]).then(([data, cards]) => {
      if (!live) return;
      setSnapshot(data); setStates(data.states); setNames([...new Set(cards.value.cards.map(card => card.name))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useSaveBeforeExit('人物状态', () => ({ dirty, busy, save }));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  async function save() { if (!snapshot) throw new Error('人物状态未加载'); const next = await window.writer.saveCharacterStates(projectId, states, snapshot.hash); setSnapshot(next); setStates(next.states); setMessage('人物状态已保存'); }
  const add = () => setStates(current => [...current, { id: `pending-${Date.now()}`, character, label: label.trim(), note: note.trim(),
    ...(from ? { fromChapter: Number(from) } : {}), ...(to ? { toChapter: Number(to) } : {}) }]);
  const active = currentPosition > 0 ? statesForChapter(states, currentPosition) : [];
  const grouped = [...new Set(states.map(item => item.character))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal states-modal" role="dialog" aria-modal="true" aria-label="人物状态" onKeyDown={event => { if (event.key === 'Escape' && !busy && !blocked) onClose(); }}>
    <header><div><h2>人物状态</h2><p>给角色记录会变化的状态并限定适用章节；写作时按当前章节取用。章节用本书顺序里的第几章，改名或移动都不影响。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="states-form">
      <label>角色<select aria-label="状态角色" disabled={busy || blocked} value={character} onChange={e => setCharacter(e.target.value)}><option value="">选择角色</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>状态<input aria-label="状态名称" maxLength={40} disabled={busy || blocked} value={label} onChange={e => setLabel(e.target.value)} placeholder="受伤 / 失忆 / 结盟" /></label>
      <label>起始章<input aria-label="起始章" inputMode="numeric" disabled={busy || blocked} value={from} onChange={e => setFrom(e.target.value.replace(/\D/gu, ''))} placeholder="不限" /></label>
      <label>结束章<input aria-label="结束章" inputMode="numeric" disabled={busy || blocked} value={to} onChange={e => setTo(e.target.value.replace(/\D/gu, ''))} placeholder="不限" /></label>
      <label>说明<textarea aria-label="状态说明" maxLength={1000} disabled={busy || blocked} value={note} onChange={e => setNote(e.target.value)} /></label>
      <button type="button" disabled={busy || blocked || !character || !label.trim()} onClick={add}>添加状态</button>
    </div>
    {currentPosition > 0 && <p className="notice" role="status">当前是第 {currentPosition} 章，生效状态：{active.length ? active.map(item => `${item.character}·${item.label}`).join('、') : '无'}</p>}
    <div className="states-groups">{grouped.map(name => <section key={name}><h3>{name}</h3><ul>{states.filter(item => item.character === name).map(item => <li key={item.id}>{item.label} · {describeRange(item)}{item.note && <small>{item.note}</small>}<button type="button" disabled={busy || blocked} aria-label={`删除 ${name}-${item.label}`} onClick={() => setStates(current => current.filter(entry => entry.id !== item.id))}>删除</button></li>)}</ul></section>)}</div>
    {!states.length && <p>还没有状态。选一个角色，写“受伤 / 第1–3章”试试。</p>}
    <footer><span>{dirty ? '有未保存改动' : '已保存'}</span><div><button disabled={busy} onClick={onClose}>关闭</button><button className="primary" disabled={busy || blocked || !dirty} onClick={() => void run(save)}>保存人物状态</button></div></footer>
  </section></div>;
}
