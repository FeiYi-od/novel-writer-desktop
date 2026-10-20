import { useEffect, useRef, useState } from 'react';
import { exitSaves, useSaveBeforeExit } from './save-before-exit';
import { assignVolumeChapters, moveVolumes, removeVolumes } from '../../core/volume-management';
import type { BookDetails, BookSnapshot, Chapter, Project } from '../../shared/contracts';

export function BookCover({ title, src, small = false }: { title: string; src?: string; small?: boolean }) {
  return <div className={`cover-art ${small ? 'small' : ''}`}>
    {src ? <img alt={`${title}封面`} src={src} /> : <><span className="cover-line"/><span className="cover-title">{title}</span><span className="cover-caption">NOVEL / STORY</span></>}
  </div>;
}

export function Shelf({ projects, books, busy, onOpen, onSave }: {
  projects: Project[]; books: Record<string, BookSnapshot>; busy: boolean;
  onOpen: (project: Project) => void;
  onSave: (id: string, value: BookDetails, hash: string) => Promise<BookSnapshot>;
}) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Project | null>(null);
  const filtered = projects.filter(p => (books[p.id]?.value.title ?? p.name).includes(search));
  return <section className="library-page">
    <div className="page-title"><div><span className="eyebrow">YOUR PERSONAL LIBRARY</span><h1>我的书架<span>{projects.length} 部作品</span></h1><p>每一个世界，都有自己的书页。</p></div><input aria-label="搜索书架" placeholder="搜索作品名称…" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <div className="shelf-grid">{filtered.map(project => {
      const book = books[project.id]; const title = book?.value.title ?? project.name;
      return <article className="shelf-card" key={project.id}>
        <button className="cover-button" disabled={busy} aria-label={`打开作品 ${title}`} onClick={() => onOpen(project)}><BookCover title={title} src={book?.covers[book.value.cover]} /></button>
        <div className="card-details"><div className="card-meta">{book?.value.volumes.length ?? 0} 个分集 · DOCX</div><h2>{title}</h2><p>{book?.value.introduction || '为这部小说写一段引言，让故事从这里开始。'}</p><div className="card-actions"><button className="primary" disabled={busy} onClick={() => onOpen(project)}>进入创作 →</button><button disabled={busy || !book} aria-label={`编辑作品 ${title}`} onClick={() => setEditing(project)}>封面与分集</button></div></div>
      </article>;
    })}</div>
    {!filtered.length && <div className="empty-library"><b>{projects.length ? '没有找到这部作品' : '你的下一部小说，从这里开始'}</b><p>点击右上角“打开小说文件夹”，将已有作品加入书架。</p></div>}
    {editing && books[editing.id] && <BookEditor key={editing.id} project={editing} snapshot={books[editing.id]} onSave={onSave} onClose={() => setEditing(null)} />}
  </section>;
}

function BookEditor({ project, snapshot, onSave, onClose }: {
  project: Project; snapshot: BookSnapshot;
  onSave: (id: string, value: BookDetails, hash: string) => Promise<BookSnapshot>; onClose: () => void;
}) {
  const [value, setValue] = useState(() => structuredClone(snapshot.value));
  const [covers, setCovers] = useState(snapshot.covers);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selected, setSelected] = useState('book');
  const [selectedVolumes, setSelectedVolumes] = useState<string[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<string[]>([]);
  const [filter, setFilter] = useState(''); const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(true); const [directoryFailed, setDirectoryFailed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [dirty, setDirty] = useState(false);
  const mounted = useRef(true), running = useRef(false), baseline = useRef(snapshot.hash);
  const locked = busy || loading;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    const release = exitSaves.register('分集章节目录', () => ({ dirty: false, busy: true }));
    void window.writer.chapters(project.id).then(items => { if (active && mounted.current) { setChapters(items); setDirectoryFailed(false); } })
      .catch(e => { if (active && mounted.current) { setError(String(e)); setDirectoryFailed(true); } })
      .finally(() => { release(); if (active && mounted.current) setLoading(false); });
    return () => { active = false; };
  }, [project.id]);
  useEffect(() => { const prevent = (event: BeforeUnloadEvent) => { if (dirty || locked) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty, locked]);
  async function save() {
    if (running.current || loading) throw new Error('书架资料正在处理，请等待完成');
    const frozen = structuredClone(value), id = project.id, expectedHash = baseline.current;
    running.current = true; setBusy(true); setError('');
    const release = exitSaves.register('书架资料保存', () => ({ dirty: false, busy: true }));
    try { await onSave(id, frozen, expectedHash); if (mounted.current) { setDirty(false); onClose(); } }
    finally { release(); running.current = false; if (mounted.current) setBusy(false); }
  }
  useSaveBeforeExit('书架与分集资料', () => ({ dirty, busy: locked || running.current, version: value, save }));
  const entity = selected === 'book' ? value : value.volumes.find(v => v.id === selected);
  const visibleChapters = chapters.filter(chapter => `${chapter.name}\n${chapter.path}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const available = chapters.map(chapter => chapter.path);
  function edit(action: (current: BookDetails) => BookDetails) {
    if (locked || running.current) return;
    try { const next = action(value); setValue(next); setDirty(true); setError(''); } catch (e) { setError(String(e)); }
  }
  function change(patch: { title?: string; introduction?: string; cover?: string }, targetId = selected) {
    edit(current => targetId === 'book' ? { ...current, ...patch } : { ...current, volumes: current.volumes.map(v => v.id === targetId ? { ...v, ...patch } : v) });
  }
  async function pickCover() {
    if (locked || running.current) return;
    const id = project.id, targetId = selected;
    running.current = true; setBusy(true); setError('');
    const release = exitSaves.register('书架封面导入', () => ({ dirty: false, busy: true }));
    try {
      const picked = await window.writer.importCover(id);
      if (picked && mounted.current) {
        setCovers(c => ({ ...c, [picked.asset]: picked.dataUrl }));
        setValue(current => targetId === 'book' ? { ...current, cover: picked.asset } : { ...current, volumes: current.volumes.map(v => v.id === targetId ? { ...v, cover: picked.asset } : v) });
        setDirty(true);
      }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { release(); running.current = false; if (mounted.current) setBusy(false); }
  }
  function remove(ids: string[]) {
    if (locked || running.current || !ids.length) return;
    const count = value.volumes.filter(v => ids.includes(v.id)).reduce((n, v) => n + v.chapters.length, 0);
    if (!window.confirm(`删除所选 ${ids.length} 个分集的名称、引言、封面关联及章节归属？其中 ${count} 个章节将归为未分集。正文文件和封面图片原件全部保留。点击保存书架资料后生效。`)) return;
    try {
      const next = removeVolumes(value, project.id, ids); setValue(next); setDirty(true); setError('');
      setSelectedVolumes(current => current.filter(id => !ids.includes(id))); if (ids.includes(selected)) setSelected('book'); if (ids.includes(target)) setTarget('');
    } catch (e) { setError(String(e)); }
  }
  function assign(paths: string[], targetId: string | null) { edit(current => assignVolumeChapters(current, project.id, paths, targetId, available)); }
  return <div className="modal-overlay"><section className="book-modal" role="dialog" aria-modal="true" aria-label="封面与分集管理">
    <header><div><span className="eyebrow">BOOK DETAILS</span><h2>封面与分集管理</h2></div><button disabled={locked} onClick={() => { if (!dirty || window.confirm('放弃尚未保存的封面、引言或分集修改？')) onClose(); }}>关闭</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="book-modal-body"><nav><button disabled={locked} className={selected === 'book' ? 'selected' : ''} onClick={() => setSelected('book')}>整部小说</button><div className="section-label">分集 / 卷 · 已选 {selectedVolumes.length}</div>
    {value.volumes.map((v, i) => <div className="volume-row" data-volume-id={v.id} key={v.id}>
      <div className="volume-row-heading"><input type="checkbox" aria-label={`选择分集 ${v.title}`} disabled={locked} checked={selectedVolumes.includes(v.id)} onChange={e => setSelectedVolumes(current => e.target.checked ? [...current, v.id] : current.filter(id => id !== v.id))} /><button disabled={locked} className={selected === v.id ? 'selected' : ''} onClick={() => setSelected(v.id)}>{String(i + 1).padStart(2, '0')} · {v.title}</button></div>
      <div className="volume-row-actions"><button disabled={locked || i === 0} aria-label={`上移分集 ${v.title}`} onClick={() => edit(current => moveVolumes(current, project.id, [v.id], 'up'))}>上移</button><button disabled={locked || i === value.volumes.length - 1} aria-label={`下移分集 ${v.title}`} onClick={() => edit(current => moveVolumes(current, project.id, [v.id], 'down'))}>下移</button><button disabled={locked} aria-label={`删除分集 ${v.title}`} onClick={() => remove([v.id])}>删除</button></div>
    </div>)}
    <div className="volume-batch-actions"><button disabled={locked || !selectedVolumes.length} onClick={() => edit(current => moveVolumes(current, project.id, selectedVolumes, 'up'))}>上移所选分集</button><button disabled={locked || !selectedVolumes.length} onClick={() => edit(current => moveVolumes(current, project.id, selectedVolumes, 'down'))}>下移所选分集</button><button disabled={locked || !selectedVolumes.length} onClick={() => remove(selectedVolumes)}>删除所选分集</button><button disabled={locked || !selectedVolumes.length} onClick={() => setSelectedVolumes([])}>清空分集选择</button></div>
    <button disabled={locked || value.volumes.length >= 1000} onClick={() => { const id = crypto.randomUUID(); edit(current => ({ ...current, volumes: [...current.volumes, { id, title: `第 ${current.volumes.length + 1} 集`, introduction: '', cover: '', chapters: [] }] })); setSelected(id); }}>＋ 添加分集</button></nav>
    {entity && <div className="book-form" key={selected}><div className="cover-editor"><BookCover title={entity.title} src={covers[entity.cover]} /><button disabled={locked} onClick={() => void pickCover()}>选择{selected === 'book' ? '小说' : '分集'}封面</button>{entity.cover && <button disabled={locked} onClick={() => change({ cover: '' })}>移除封面</button>}<small>PNG / JPG / WebP，最大 8 MB</small></div>
    <div className="book-fields"><label>{selected === 'book' ? '小说名称' : '分集名称'}<input disabled={locked} maxLength={200} value={entity.title} onChange={e => change({ title: e.target.value })} /></label><label>{selected === 'book' ? '小说引言' : '分集引言'}<textarea disabled={locked} maxLength={20000} value={entity.introduction} onChange={e => change({ introduction: e.target.value })} placeholder="故事关于什么？从一句引言开始。" /></label>
    <section className="chapter-assignment"><b>章节批量归属</b><small>分集调整仅保存目录资料；章节正文和封面原件保留。每章只属于一个分集，未列出的旧章节映射保留。</small>
    <input aria-label="筛选分集管理章节" disabled={locked || directoryFailed} value={filter} onChange={e => setFilter(e.target.value)} placeholder="筛选章节名称或完整路径" />
    <div className="chapter-batch-actions"><button disabled={locked || directoryFailed || !visibleChapters.length} onClick={() => setSelectedChapters(current => [...new Set([...current, ...visibleChapters.map(c => c.path)])])}>选择筛选章节</button><button disabled={locked || !selectedChapters.length} onClick={() => setSelectedChapters([])}>清空章节选择</button><span>已选 {selectedChapters.length} 章</span></div>
    <div className="chapter-batch-actions"><button disabled={locked || directoryFailed || !selectedChapters.length || selected === 'book'} onClick={() => assign(selectedChapters, selected)}>归入当前分集</button><select aria-label="批量目标分集" disabled={locked || directoryFailed} value={target} onChange={e => setTarget(e.target.value)}><option value="">选择目标分集</option>{value.volumes.map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select><button disabled={locked || directoryFailed || !selectedChapters.length || !target} onClick={() => assign(selectedChapters, target)}>移到所选分集</button><button disabled={locked || directoryFailed || !selectedChapters.length} onClick={() => assign(selectedChapters, null)}>移出分集</button></div>
    {loading && <p role="status">正在读取本书章节目录…</p>}{directoryFailed && <p>章节目录读取失败，请关闭后重新打开；现有分集归属保留。</p>}
    {!loading && !directoryFailed && chapters.length === 0 && <p>先在写作页新建章节，再来归入分集。</p>}
    <div className="chapter-assignment-list">{visibleChapters.map(chapter => {
      const owner = value.volumes.find(v => v.chapters.includes(chapter.path));
      return <div className="chapter-assignment-row" key={chapter.path}><label><input type="checkbox" aria-label={`选择章节 ${chapter.path}`} disabled={locked || directoryFailed} checked={selectedChapters.includes(chapter.path)} onChange={e => setSelectedChapters(current => e.target.checked ? [...current, chapter.path] : current.filter(p => p !== chapter.path))} /><span>{chapter.path}<small>{owner?.title ?? '未分集'}</small></span></label>{selected !== 'book' && <label className="single-chapter"><input type="checkbox" aria-label={`本集章节 ${chapter.path}`} disabled={locked || directoryFailed} checked={owner?.id === selected} onChange={e => assign([chapter.path], e.target.checked ? selected : null)} />本集</label>}</div>;
    })}</div></section>
    </div></div>}</div>
    <footer><span>先调整再保存；删除分集保留正文和封面原件。</span><button className="primary" disabled={locked || !dirty} onClick={() => void save().catch(e => { if (mounted.current) setError(String(e)); })}>保存书架资料</button></footer>
  </section></div>;
}

