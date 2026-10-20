import { useEffect, useState } from 'react';

type Book = { name: string; entries: number; keys: number; error?: string };
type Hit = { book: string; content: string; keys: string[]; comment: string; order: number; position: string };
/** World info (lorebook) books for this novel, with a preview of what the current chapter triggers. */
export function WorldInfoPanel({ projectId, sampleText, characterNames, blocked, onClose }: {
  projectId: string; sampleText: string; characterNames: string[]; blocked: boolean; onClose: () => void;
}) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [sample, setSample] = useState(sampleText);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = async () => { const next = await window.writer.listWorldBooks(projectId); setBooks(next); return next; };
  useEffect(() => { let live = true; void load().then(next => { if (live) setPicked(next.filter(book => !book.error).map(book => book.name)); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  return <div className="modal-overlay"><section className="book-modal world-modal" role="dialog" aria-modal="true" aria-label="世界书">
    <header><div><h2>世界书</h2><p>导入 SillyTavern 的世界书 JSON，按关键词检查当前章节会触发哪些条目。逐条内容按原文保存，不改写。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <label>检查用文本<textarea aria-label="检查用文本" rows={4} maxLength={20000} disabled={busy || blocked} value={sample} onChange={e => setSample(e.target.value)} placeholder="默认取当前章节正文；也可以粘贴一段文字试触发。" /></label>
    <div className="actions">
      <button data-testid="world-import" disabled={busy || blocked} onClick={() => void run(async () => { const imported = await window.writer.importWorldBook(projectId); if (imported) { setMessage(`已导入「${imported.name}」（${imported.entries} 条）`); setPicked(current => current.includes(imported.name) ? current : [...current, imported.name]); await load(); } })}>导入世界书…</button>
      <button data-testid="world-preview" disabled={busy || blocked || !picked.length || !sample.trim()} onClick={() => void run(async () => { setHits(await window.writer.previewWorldInfo(projectId, picked, sample, characterNames)); })}>检查当前章节触发</button>
    </div>
    {!books && <p>正在读取…</p>}
    {books && !books.length && <p>还没有世界书。导入一个 SillyTavern 的 JSON 世界书开始。</p>}
    {books && books.length > 0 && <ul className="world-books">{books.map(book => <li key={book.name}>
      <label className="ai-check"><input type="checkbox" aria-label={`选择世界书 ${book.name}`} disabled={busy || blocked || Boolean(book.error)} checked={picked.includes(book.name)} onChange={e => setPicked(current => e.target.checked ? [...current, book.name] : current.filter(name => name !== book.name))} />
        {book.name} <small>{book.error ?? `${book.entries} 条 · ${book.keys} 个关键词`}</small></label>
      <button disabled={busy || blocked} onClick={() => void run(async () => { await window.writer.removeWorldBook(projectId, book.name); setMessage(`已删除「${book.name}」`); await load(); })}>删除</button>
    </li>)}</ul>}
    {hits && <section className="world-hits">
      <h3>当前章节会触发 {hits.length} 条</h3>
      {!hits.length && <p>没有条目被触发。检查关键词是否写进了正文。</p>}
      <ul>{hits.map(hit => <li key={`${hit.book}-${hit.keys.join()}-${hit.content.slice(0, 8)}`}>
        <small>{hit.book} · 关键词 {hit.keys.join('、') || '（常驻）'} · 顺序 {hit.order} · {hit.position}</small>
        <pre>{hit.content}</pre>
      </li>)}</ul>
    </section>}
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
