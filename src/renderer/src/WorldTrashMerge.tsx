import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './world-trash-merge.css';

type WorldBook = Awaited<ReturnType<typeof window.writer.readWorldBook>>;
type TrashItem = Awaited<ReturnType<typeof window.writer.listWorldEntryTrash>>['items'][number];
type Field = 'comment' | 'content' | 'keys';
type Choice = 'current' | 'backup';

/** The author chooses each field; unknown extensions on both original records stay untouched. */
export function WorldTrashMerge({ projectId, book, item, onBusy, onClose, onSaved }: { projectId: string; book: WorldBook; item: TrashItem; onBusy: (value: boolean) => void; onClose: () => void; onSaved: (name: string) => void }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof window.writer.previewWorldEntryTrash>> | null>(null);
  const [targetId, setTargetId] = useState('');
  const [fields, setFields] = useState<Record<Field, Choice>>({ comment: 'current', content: 'current', keys: 'current' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { onBusy(true); return () => onBusy(false); }, [onBusy]);
  useEffect(() => { const previous = document.activeElement; dialog.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => {
    let live = true;
    void window.writer.previewWorldEntryTrash({ projectId, trashId: item.id, expectedHash: item.hash }).then(value => { if (live) setPreview(value); }).catch(failure => { if (live) setError(String(failure instanceof Error ? failure.message : failure)); });
    return () => { live = false; };
  }, [projectId, item.id, item.hash]);
  const target = book.entries.find(entry => entry.id === targetId);
  const hasChoice = Object.values(fields).includes('backup');
  const lines: { field: Field; label: string; current: string; backup: string }[] = target && preview ? [
    { field: 'comment', label: '名称', current: target.comment, backup: preview.comment },
    { field: 'content', label: '正文', current: target.content, backup: preview.content },
    { field: 'keys', label: '关键词', current: target.keys.join('、'), backup: preview.keys.join('、') }
  ] : [];
  const save = () => {
    if (!target || !preview || !hasChoice || busy) return;
    if (!window.confirm(`将选中的备份字段写入「${target.comment || target.keys[0] || target.id}」？\n\n世界书会先备份，其他条目及目标扩展保留；若选择关键词，可能改变写作时的触发条件。`)) return;
    setBusy(true); setError('');
    void window.writer.mergeWorldEntryTrash({ projectId, trashId: item.id, expectedTrashHash: item.hash, targetEntryId: target.id, expectedBookHash: book.hash, fields }).then(() => onSaved(item.name)).catch(failure => setError(String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, ''))).finally(() => setBusy(false));
  };
  return createPortal(<div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal world-trash-merge" role="dialog" aria-modal="true" aria-label="比较并合并设定卡" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') { const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')].filter(element => element.getClientRects().length > 0); const first = controls[0], last = controls.at(-1); if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <header><div><h2>比较并合并设定卡</h2><p>备份：{item.name} · {item.book}。选择一张现有卡，再逐项决定使用哪个版本。</p></div><button disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="world-trash-merge-body">
    {error && <div className="error" role="alert">{error}</div>}
    <label>合并到现有卡<select aria-label="合并目标设定卡" disabled={busy || !preview} value={targetId} onChange={event => { setTargetId(event.target.value); setFields({ comment: 'current', content: 'current', keys: 'current' }); }}><option value="">选择目标设定卡</option>{book.entries.map(entry => <option key={entry.id} value={entry.id}>{entry.comment || entry.keys[0] || `未命名条目 ${entry.id}`} · {entry.id}</option>)}</select></label>
    {!preview && !error && <p>正在核对备份…</p>}
    {lines.map(line => <fieldset key={line.field}><legend>{line.label}</legend><div className="world-trash-merge-columns"><label><span><input type="radio" name={`merge-${line.field}`} aria-label={`${line.label}保留当前`} checked={fields[line.field] === 'current'} disabled={busy} onChange={() => setFields(current => ({ ...current, [line.field]: 'current' }))} />保留当前</span><pre>{line.current || '（空）'}</pre></label><label><span><input type="radio" name={`merge-${line.field}`} aria-label={`${line.label}使用备份`} checked={fields[line.field] === 'backup'} disabled={busy} onChange={() => setFields(current => ({ ...current, [line.field]: 'backup' }))} />使用备份</span><pre>{line.backup || '（空）'}</pre></label></div></fieldset>)}
    <p>只改所选字段，目标卡和备份的其他扩展均保留；备份不会删除。</p>
    </div>
    <footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !target || !preview || !hasChoice} onClick={save}>{busy ? '正在保存…' : '确认合并'}</button></footer>
  </section></div>, document.body);
}
