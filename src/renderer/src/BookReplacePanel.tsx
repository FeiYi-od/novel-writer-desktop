import { useRef, useState } from 'react';
import type { ReplaceOutcome } from '../../shared/contracts';
import { useSaveBeforeExit } from './save-before-exit';

/** Two-step whole-book replace: preview the hit count per chapter, then write. Nothing is written
 * before the author confirms, and chapters edited by another program are reported instead of overwritten. */
export function BookReplacePanel({ projectId, blocked, onDirty, onDone, onClose }: { projectId: string; blocked: boolean; onDirty: (value: boolean) => void; onDone: () => Promise<void>; onClose: () => void }) {
  const [query, setQuery] = useState(''), [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [preview, setPreview] = useState<ReplaceOutcome | null>(null);
  const [result, setResult] = useState<ReplaceOutcome | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const dialog = useRef<HTMLElement>(null);
  useSaveBeforeExit('整书替换', () => ({ dirty: false, busy }));
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); onDirty(false); } };
  const stale = !!preview && preview.chapters.some(chapter => chapter.status === 'skipped');
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal replace-modal" role="dialog" aria-modal="true" aria-label="整书替换" onKeyDown={event => { if (event.key === 'Escape' && !busy && !blocked) onClose(); }}>
    <header><div><h2>整书替换</h2><p>先预览命中，再决定是否写入。每章保存都会留下 history 备份；被外部改过的章节会跳过并说明原因。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}
    {message && <p role="status">{message}</p>}
    <div className="replace-form">
      <label>查找<input aria-label="查找内容" maxLength={2000} disabled={busy || blocked} value={query} onChange={e => { setQuery(e.target.value); setPreview(null); setResult(null); }} /></label>
      <label>替换为<input aria-label="替换内容" maxLength={2000} disabled={busy || blocked} value={replacement} onChange={e => { setReplacement(e.target.value); setPreview(null); setResult(null); }} /></label>
      <label className="ai-check"><input type="checkbox" aria-label="区分大小写" checked={caseSensitive} disabled={busy || blocked} onChange={e => setCaseSensitive(e.target.checked)} />区分大小写</label>
      <div className="actions">
        <button disabled={busy || blocked || !query.trim()} onClick={() => void run(async () => { setPreview(await window.writer.previewBookReplace({ projectId, query, replacement, caseSensitive })); })}>预览命中</button>
        <button className="primary" disabled={busy || blocked || !query.trim() || !preview?.total} onClick={() => void run(async () => {
          const next = await window.writer.runBookReplace({ projectId, query, replacement, caseSensitive });
          setResult(next); setPreview(null); await onDone();
        })}>写入替换</button>
      </div>
    </div>
    {preview && <div className="replace-report"><h3>预览：共 {preview.total} 处，涉及 {preview.chapters.filter(chapter => chapter.count > 0).length} 章</h3>
      <ul>{preview.chapters.filter(chapter => chapter.count > 0 || chapter.status === 'skipped').map(chapter => <li key={chapter.path}>{chapter.path} · {chapter.count} 处{chapter.message ? ` · ${chapter.message}` : ''}</li>)}</ul>
      {stale && <p className="usage-warning">有章节当前无法替换（版本冲突或读取失败），执行时会跳过它们。</p>}</div>}
    {result && <div className="replace-report"><h3>已替换 {result.total} 处，写入 {result.replacedFiles} 章</h3>
      <ul>{result.chapters.filter(chapter => chapter.status !== 'unchanged').map(chapter => <li key={chapter.path}>{chapter.path} · {chapter.status === 'replaced' ? `${chapter.count} 处已替换` : `跳过：${chapter.message ?? '未知原因'}`}</li>)}</ul>
      {result.batchId && <button onClick={() => void run(async () => {
        const undone = await window.writer.undoBookReplace(projectId, result.batchId!);
        setMessage(`已恢复 ${undone.restored.length} 章${undone.skipped.length ? `；${undone.skipped.length} 章因替换后又被修改而跳过` : ''}`);
        setResult(null); await onDone();
      })}>撤销本次替换</button>}
      <p>撤销只恢复仍保持替换后内容的章节，替换后又改过的章节会跳过。</p></div>}
    <footer><button disabled={busy} onClick={onClose}>关闭</button></footer>
  </section></div>;
}
