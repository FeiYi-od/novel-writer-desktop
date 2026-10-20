import { useEffect, useRef, useState } from 'react';
import type { Chapter, TimelineEntryView, TimelineSnapshotView } from '../../shared/contracts';
import { sortTimeline } from '../../core/timeline';
import { useSaveBeforeExit } from './save-before-exit';

/** Story timeline: plain list ordered by the author's own time labels, saved as project material. */
export function TimelinePanel({ projectId, chapters, blocked, onDirty, onClose, onOpenChapter }: {
  projectId: string; chapters: Chapter[]; blocked: boolean; onDirty: (value: boolean) => void; onClose: () => void;
  onOpenChapter: (path: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<TimelineSnapshotView | null>(null);
  const [entries, setEntries] = useState<TimelineEntryView[]>([]);
  const [when, setWhen] = useState(''); const [title, setTitle] = useState(''); const [note, setNote] = useState(''); const [chapterPath, setChapterPath] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const dirty = !!snapshot && JSON.stringify(entries) !== JSON.stringify(snapshot.entries);
  useEffect(() => { let live = true; void window.writer.readTimeline(projectId).then(next => { if (!live) return; setSnapshot(next); setEntries(next.entries); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [projectId]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  useSaveBeforeExit('故事时间线', () => ({ dirty, busy, save }));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  async function save() { if (!snapshot) throw new Error('时间线未加载'); const next = await window.writer.saveTimeline(projectId, entries, snapshot.hash); setSnapshot(next); setEntries(next.entries); setMessage('时间线已保存'); }
  const add = () => { if (!when.trim() || !title.trim()) { setError('请填写时间点与事件标题'); return; } setEntries(current => sortTimeline([...current, { id: `pending-${Date.now()}`, when: when.trim(), title: title.trim(), note: note.trim(), ...(chapterPath ? { chapterPath } : {}) }])); setWhen(''); setTitle(''); setNote(''); setChapterPath(''); setError(''); };
  const remove = (id: string) => setEntries(current => current.filter(item => item.id !== id));
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal timeline-modal" role="dialog" aria-modal="true" aria-label="故事时间线" onKeyDown={event => { if (event.key === 'Escape' && !busy && !blocked) onClose(); }}>
    <header><div><h2>故事时间线</h2><p>按你自己的时间点排列事件（如「第3天清晨」「第一年·春」）；数字会按数值排序。保存后随本书资料一起存放。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="timeline-form">
      <label>时间点<input aria-label="时间点" maxLength={60} disabled={busy || blocked} value={when} onChange={e => setWhen(e.target.value)} placeholder="第3天清晨" /></label>
      <label>事件标题<input aria-label="事件标题" maxLength={120} disabled={busy || blocked} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>关联章节<select aria-label="关联章节" disabled={busy || blocked} value={chapterPath} onChange={e => setChapterPath(e.target.value)}><option value="">不关联</option>{chapters.map(chapter => <option key={chapter.path} value={chapter.path}>{chapter.name}</option>)}</select></label>
      <label>备注<textarea aria-label="事件备注" maxLength={2000} disabled={busy || blocked} value={note} onChange={e => setNote(e.target.value)} /></label>
      <button type="button" disabled={busy || blocked} onClick={add}>添加到时间线</button>
    </div>
    <ol className="timeline-list" aria-label="时间线列表">{entries.map(entry => <li key={entry.id}>
      <strong>{entry.when}</strong><span>{entry.title}</span>
      {entry.note && <p>{entry.note}</p>}
      {entry.chapterPath && <button type="button" disabled={busy || blocked} onClick={() => onOpenChapter(entry.chapterPath!)}>打开关联章节</button>}
      <button type="button" disabled={busy || blocked} onClick={() => remove(entry.id)} aria-label={`删除 ${entry.title}`}>删除</button>
    </li>)}</ol>
    {!entries.length && <p>还没有事件。先写一条“第1天 出发”试试。</p>}
    <footer><span>{dirty ? '有未保存改动' : '已保存'}</span><div><button disabled={busy} onClick={onClose}>关闭</button><button className="primary" disabled={busy || blocked || !dirty} onClick={() => void run(save)}>保存时间线</button></div></footer>
  </section></div>;
}
