import { useEffect, useRef, useState } from 'react';
import type { RelationSnapshotView, RelationView } from '../../shared/contracts';
import { groupRelations } from '../../core/relations';
import { useSaveBeforeExit } from './save-before-exit';

/** Character relations: pick two characters, name the relation, and see every character's view. */
export function RelationsPanel({ projectId, blocked, onDirty, onClose }: { projectId: string; blocked: boolean; onDirty: (value: boolean) => void; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<RelationSnapshotView | null>(null);
  const [list, setList] = useState<RelationView[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [label, setLabel] = useState(''), [note, setNote] = useState('');
  const [strength, setStrength] = useState(3), [mutual, setMutual] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const dirty = !!snapshot && JSON.stringify(list) !== JSON.stringify(snapshot.relations);
  useEffect(() => {
    let live = true;
    void Promise.all([window.writer.readRelations(projectId), window.writer.readCharacters(projectId)]).then(([relations, cards]) => {
      if (!live) return;
      setSnapshot(relations); setList(relations.relations);
      setNames([...new Set(cards.value.cards.map(card => card.name))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useSaveBeforeExit('人物关系', () => ({ dirty, busy, save }));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  async function save() { if (!snapshot) throw new Error('人物关系未加载'); const next = await window.writer.saveRelations(projectId, list, snapshot.hash); setSnapshot(next); setList(next.relations); setMessage('人物关系已保存'); }
  const add = () => { setError(''); setList(current => [...current, { id: `pending-${Date.now()}`, from, to, label: label.trim(), note: note.trim(), mutual, strength }]); setLabel(''); setNote(''); };
  const remove = (id: string) => setList(current => current.filter(item => item.id !== id));
  const groups = groupRelations(list);
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal relations-modal" role="dialog" aria-modal="true" aria-label="人物关系" onKeyDown={event => { if (event.key === 'Escape' && !busy && !blocked) onClose(); }}>
    <header><div><h2>人物关系</h2><p>从角色库里选两端，写清关系名称与强度。关系会同时出现在双方名下，保存在本书资料中。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="relations-form">
      <label>角色 A<select aria-label="关系角色A" disabled={busy || blocked} value={from} onChange={e => setFrom(e.target.value)}><option value="">选择角色</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>角色 B<select aria-label="关系角色B" disabled={busy || blocked} value={to} onChange={e => setTo(e.target.value)}><option value="">选择角色</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label>关系<input aria-label="关系名称" maxLength={60} disabled={busy || blocked} value={label} onChange={e => setLabel(e.target.value)} placeholder="师徒 / 宿敌 / 血亲" /></label>
      <label>强度<select aria-label="关系强度" disabled={busy || blocked} value={strength} onChange={e => setStrength(Number(e.target.value))}>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="ai-check"><input type="checkbox" aria-label="关系对等" checked={mutual} disabled={busy || blocked} onChange={e => setMutual(e.target.checked)} />双向关系（如「兄妹」）</label>
      <label>备注<textarea aria-label="关系备注" maxLength={1000} disabled={busy || blocked} value={note} onChange={e => setNote(e.target.value)} /></label>
      <button type="button" disabled={busy || blocked || !from || !to || !label.trim()} onClick={add}>添加关系</button>
    </div>
    <div className="relations-groups">{groups.map(group => <section key={group.name}><h3>{group.name}</h3><ul>{group.items.map(item => <li key={`${item.relation.id}-${group.name}`}>{item.outgoing ? '→' : '←'} {item.other} · {item.relation.label}（强度 {item.relation.strength}{item.relation.mutual ? ' · 双向' : ''}）{item.relation.note && <small>{item.relation.note}</small>}<button type="button" disabled={busy || blocked} aria-label={`删除 ${group.name}-${item.other}-${item.relation.label}`} onClick={() => remove(item.relation.id)}>删除</button></li>)}</ul></section>)}</div>
    {!list.length && <p>还没有关系。选两个角色，写一条“师徒”试试。</p>}
    <footer><span>{dirty ? '有未保存改动' : '已保存'}</span><div><button disabled={busy} onClick={onClose}>关闭</button><button className="primary" disabled={busy || blocked || !dirty} onClick={() => void run(save)}>保存人物关系</button></div></footer>
  </section></div>;
}
