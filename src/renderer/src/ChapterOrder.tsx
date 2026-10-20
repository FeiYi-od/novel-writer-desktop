import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChapterOrderSnapshot } from '../../shared/contracts';
import './chapter-order.css';

export function ChapterOrder({ projectId, blocked, onDirty, onSave, onClose }: { projectId: string; blocked: boolean; onDirty: (value: boolean) => void; onSave: (paths: string[], hash: string) => Promise<ChapterOrderSnapshot>; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<ChapterOrderSnapshot | null>(null); const [paths, setPaths] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const dirty = !!snapshot && JSON.stringify(paths) !== JSON.stringify(snapshot.value.paths);
  const entries = useMemo(() => new Map(snapshot?.entries.map(entry => [entry.path, entry]) ?? []), [snapshot]);
  useEffect(() => { let disposed = false; setBusy(true); void window.writer.chapterOrder(projectId).then(next => { if (!disposed) { setSnapshot(next); setPaths(next.value.paths); } }).catch(e => { if (!disposed) setError(String(e)); }).finally(() => { if (!disposed) setBusy(false); }); return () => { disposed = true; }; }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  const close = () => { if (!busy && !blocked && (!dirty || window.confirm('章节排序尚未保存，确定放弃排列并关闭吗？'))) onClose(); };
  const save = () => { if (snapshot && dirty && !busy && !blocked) void run(async () => { await onSave(paths, snapshot.hash); }); };
  const move = (index: number, direction: number) => { setPaths(current => { const next = [...current], target = index + direction; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; }); setError(''); };
  // Batch reorder: move every selected chapter to the top or bottom in one step, keeping their
  // relative order. Only the index list changes; file names and正文 stay untouched until save.
  const batchMove = (to: 'top' | 'bottom') => { setPaths(current => { const chosen = current.filter(path => picked.has(path)); if (!chosen.length) return current; const rest = current.filter(path => !picked.has(path)); return to === 'top' ? [...chosen, ...rest] : [...rest, ...chosen]; }); setError(''); };
  const togglePick = (path: string) => setPicked(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  // Drag reorder: moving one row to another index. The list order is only local until "保存顺序".
  const dragIndex = useRef<number | null>(null); const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dragTo = (target: number) => { setPaths(current => { const from = dragIndex.current; if (from === null || from === target || from < 0 || from >= current.length) return current; const next = [...current]; const [moved] = next.splice(from, 1); next.splice(target, 0, moved); return next; }); setError(''); };
  // Keyboard/time-typing equivalent of dragging: works for long lists and stays automatable.
  const [moveFrom, setMoveFrom] = useState(''), [moveTo, setMoveTo] = useState('');
  const moveRange = () => {
    const from = Number(moveFrom), to = Number(moveTo);
    setPaths(current => {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || from > current.length || to > current.length) { setError(`请输入 1 到 ${current.length} 之间的位置`); return current; }
      if (from === to) return current;
      const next = [...current]; const [moved] = next.splice(from - 1, 1); next.splice(to - 1, 0, moved); return next;
    });
    setError('');
  };
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal chapter-order" role="dialog" aria-modal="true" aria-label="本书章节排序" onKeyDown={e => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Tab') { const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]; const first = buttons[0], last = buttons.at(-1); if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first?.focus(); } }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }}><header><div><h2>本书章节排序</h2><p>调整阅读顺序，文件名称和正文内容保留。</p></div><button disabled={busy || blocked} onClick={() => { if (dirty && !window.confirm('放弃尚未保存的章节排列并刷新目录吗？')) return; void run(async () => { const next = await window.writer.chapterOrder(projectId); setSnapshot(next); setPaths(next.value.paths); }); }}>刷新章节</button></header>
    {error && <div className="error" role="alert">{error}</div>}
    <ol aria-label="章节顺序列表">{paths.map((p, index) => { const entry = entries.get(p); const name = entry?.name ?? p; return <li key={p} data-path={p} className={`${entry?.present ? '' : 'missing'}${dropIndex === index ? ' drop-target' : ''}`} draggable={!busy && !blocked} onDragStart={event => { dragIndex.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', p); }} onDragOver={event => { if (dragIndex.current === null) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropIndex(index); }} onDragLeave={() => setDropIndex(current => (current === index ? null : current))} onDrop={event => { event.preventDefault(); dragTo(index); dragIndex.current = null; setDropIndex(null); }} onDragEnd={() => { dragIndex.current = null; setDropIndex(null); }} aria-label={`第 ${index + 1} 章 ${name}，可拖拽调整顺序`}><input type="checkbox" aria-label={`选择 ${name}`} checked={picked.has(p)} disabled={busy || blocked} onChange={() => togglePick(p)} /><span className="order-index">{index + 1}</span><div><strong>{name}</strong><small>{p}{!entry?.present && <> · <span>文件缺失</span>，位置保留</>}</small></div><button aria-label={`上移 ${p}`} disabled={busy || blocked || index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`下移 ${p}`} disabled={busy || blocked || index === paths.length - 1} onClick={() => move(index, 1)}>↓</button></li>; })}</ol>
    <div className="chapter-order-batch"><span>已选 {picked.size} 章</span><button type="button" disabled={busy || blocked || !picked.size} onClick={() => { batchMove('top'); }}>移到最前</button><button type="button" disabled={busy || blocked || !picked.size} onClick={() => { batchMove('bottom'); }}>移到最后</button><button type="button" disabled={busy || blocked || !picked.size} onClick={() => setPicked(new Set())}>清空选择</button>
      <label>精确移动<input aria-label="移动起点" disabled={busy || blocked} inputMode="numeric" value={moveFrom} onChange={e => setMoveFrom(e.target.value.replace(/\D/gu, ''))} placeholder="第几位" />→<input aria-label="移动终点" disabled={busy || blocked} inputMode="numeric" value={moveTo} onChange={e => setMoveTo(e.target.value.replace(/\D/gu, ''))} placeholder="到第几位" /><button type="button" disabled={busy || blocked || !moveFrom || !moveTo} onClick={moveRange}>移动到该位置</button></label>
    </div>
    {snapshot && !paths.length && <p className="empty-order">本书尚无章节。</p>}
    <p className="order-hint">本书各分集沿用此顺序；新文件追加到末尾，缺失文件保留位置。排序不改变故事记忆或剧情时间线。</p>
    <footer><span>{busy ? '处理中…' : dirty ? '顺序未保存' : '顺序已读取'}</span><div><button disabled={busy || blocked} onClick={close}>取消</button><button className="primary" disabled={busy || blocked || !dirty || !snapshot} onClick={save}>保存顺序</button></div></footer>
  </section></div>;
}
