import { useEffect, useRef, useState } from 'react';
import './world-info.css';
import { CharacterTagMappingPanel } from './CharacterTagMappingPanel';
import { SillyPluginInspectionPanel } from './SillyPluginInspectionPanel';

type Book = { name: string; entries: number; keys: number; hash?: string; error?: string };
type Hit = { book: string; content: string; keys: string[]; comment: string; order: number; position: string };
type WorldView = Awaited<ReturnType<typeof window.writer.readWorldBook>>;
/** World info (lorebook) books for this novel, with a preview of what the current chapter triggers. */
export function WorldInfoPanel({ projectId, sampleText, blocked, initialBook, onClose, onMappingDirty, onMappingBusy, onPluginBusy }: {
  projectId: string; sampleText: string; blocked: boolean; initialBook?: string; onClose: () => void; onMappingDirty: (dirty: boolean) => void; onMappingBusy: (busy: boolean) => void; onPluginBusy: (busy: boolean) => void;
}) {
  const [books, setBooks] = useState<Book[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [details, setDetails] = useState<WorldView | null>(null);
  const cardBrowser = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [sample, setSample] = useState(sampleText);
  const [useTagIds, setUseTagIds] = useState(false);
  const [tagIds, setTagIds] = useState('');
  const [mappingOpen, setMappingOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const load = async () => { const next = await window.writer.listWorldBooks(projectId); setBooks(next); return next; };
  useEffect(() => { let live = true; void (async () => {
    const next = await window.writer.listWorldBooks(projectId);
    if (!live) return;
    setBooks(next); setPicked(next.filter(book => !book.error).map(book => book.name));
    if (initialBook && next.some(book => book.name === initialBook && !book.error)) {
      const value = await window.writer.readWorldBook(projectId, initialBook);
      if (live) setDetails(value);
    }
  })().catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [projectId, initialBook]);
  useEffect(() => { if (details) cardBrowser.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); }, [details]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  return <><div className="modal-overlay" inert={mappingOpen || pluginOpen}><section className="book-modal world-modal" role="dialog" aria-modal="true" aria-label="世界书">
    <header><div><h2>世界书与设定卡</h2><p>查看本书的地点、势力和其他设定卡；也可导入 SillyTavern 世界书并检查章节触发。卡片浏览显示全部条目，触发预览按关键词和角色关联筛选。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    {details && <section ref={cardBrowser} className="world-card-browser" data-testid="world-card-browser">
      <div className="world-card-heading"><div><h3>{details.name}</h3><p>共 {details.entries.length} 张设定卡 · 显示全部条目，与章节是否触发无关</p></div><button onClick={() => setDetails(null)}>收起卡片</button></div>
      <label className="world-card-search">搜索设定卡<input aria-label="搜索设定卡" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、关键词或内容" /></label>
      <div className="world-card-grid">{details.entries.filter(entry => [entry.comment, entry.content, ...entry.keys, ...entry.secondaryKeys].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).map(entry => <article className="world-card" key={entry.id}>
        <header><h4>{entry.comment || entry.keys[0] || `未命名条目 ${entry.id}`}</h4><span>{entry.disabled ? '已停用' : entry.constant ? '常驻' : '关键词触发'}</span></header>
        <p className="world-card-keys">关键词：{entry.keys.join('、') || '无'}{entry.secondaryKeys.length ? ` · 次级：${entry.secondaryKeys.join('、')}` : ''}</p>
        <pre>{entry.content || '暂无设定内容'}</pre>
      </article>)}</div>
      {query.trim() && !details.entries.some(entry => [entry.comment, entry.content, ...entry.keys, ...entry.secondaryKeys].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) && <p>没有找到匹配的设定卡。</p>}
      <p className="world-card-note">此处用于查看；正文触发规则和世界书文件不会因浏览而改变。</p>
    </section>}
    <label>检查用文本<textarea aria-label="检查用文本" rows={4} maxLength={20000} disabled={busy || blocked} value={sample} onChange={e => setSample(e.target.value)} placeholder="默认取当前章节正文；也可以粘贴一段文字试触发。" /></label>
    <label className="ai-check world-tag-toggle"><input type="checkbox" checked={useTagIds} disabled={busy || blocked} onChange={e => setUseTagIds(e.target.checked)} />手动指定本次预览的酒馆标签 ID</label>
    {useTagIds ? <label>每行一个标签 ID；留空表示已知没有标签<textarea aria-label="酒馆标签 ID" rows={3} maxLength={15000} disabled={busy || blocked} value={tagIds} onChange={e => setTagIds(e.target.value)} /></label> : <p>预览使用已确认的角色关联；映射未知时预览跳过标签筛选，AI 写作不会注入该角色标签未知的受限条目。</p>}
    {useTagIds && <p>仅供本次预览，不会保存或用于 AI 写作；多角色时名称和标签可能来自不同角色，请自行核对。</p>}
    <div className="actions">
      <button data-testid="world-import" disabled={busy || blocked} onClick={() => void run(async () => { const imported = await window.writer.importWorldBook(projectId); if (imported) { setMessage(`已导入「${imported.name}」（${imported.entries} 条）`); setPicked(current => current.includes(imported.name) ? current : [...current, imported.name]); await load(); } })}>导入世界书…</button>
      <button data-testid="tag-mapping-open" disabled={busy || blocked} onClick={() => setMappingOpen(true)}>酒馆角色关联…</button>
      <button data-testid="plugin-inspect-open" disabled={busy || blocked} onClick={() => setPluginOpen(true)}>插件兼容检查…</button>
      <button data-testid="world-preview" disabled={busy || blocked || !picked.length || !sample.trim()} onClick={() => void run(async () => { const ids = useTagIds ? tagIds.split(/\r?\n/u).map(id => id.trim()).filter(Boolean) : undefined; setHits(await window.writer.previewWorldInfoEnabled(projectId, picked, sample, ids)); })}>检查当前章节触发</button>
    </div>
    {!books && <p>正在读取…</p>}
    {books && !books.length && <p>还没有世界书。导入一个 SillyTavern 的 JSON 世界书开始。</p>}
    {books && books.length > 0 && <ul className="world-books">{books.map(book => <li key={book.name}>
      <label className="ai-check"><input type="checkbox" aria-label={`选择世界书 ${book.name}`} disabled={busy || blocked || Boolean(book.error)} checked={picked.includes(book.name)} onChange={e => setPicked(current => e.target.checked ? [...current, book.name] : current.filter(name => name !== book.name))} />
        {book.name} <small>{book.error ?? `${book.entries} 条 · ${book.keys} 个关键词`}</small></label>
      <div className="world-book-actions"><button data-testid="world-view-book" disabled={busy || blocked || Boolean(book.error)} onClick={() => void run(async () => { setDetails(await window.writer.readWorldBook(projectId, book.name)); setQuery(''); })}>查看设定卡片</button><button disabled={busy || blocked || !book.hash} onClick={() => void run(async () => { if (!book.hash) throw new Error('世界书无法核验，请先检查原文件'); await window.writer.removeWorldBook(projectId, book.name, book.hash); if (details?.name === book.name) setDetails(null); setMessage(`已删除「${book.name}」，原文件已备份到本书资料目录`); await load(); })}>删除</button></div>
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
  </section></div>{mappingOpen && <CharacterTagMappingPanel projectId={projectId} onDirty={onMappingDirty} onBusy={onMappingBusy} onClose={() => setMappingOpen(false)} />}{pluginOpen && <SillyPluginInspectionPanel projectId={projectId} onBusy={onPluginBusy} onClose={() => setPluginOpen(false)} />}</>;
}
