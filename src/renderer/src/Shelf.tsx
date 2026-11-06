import { useEffect, useRef, useState } from 'react';
import { exitSaves, useSaveBeforeExit } from './save-before-exit';
import { assignVolumeChapters, moveVolumes, removeVolumes } from '../../core/volume-management';
import type { BookDetails, BookSnapshot, Chapter, Project } from '../../shared/contracts';

export function BookCover({ title, src, small = false }: { title: string; src?: string; small?: boolean }) {
  return <div className={`cover-art ${small ? 'small' : ''}`} title={title}>
    {src ? <img alt={`${title}封面`} src={src} /> : <><span className="cover-line"/><span className="cover-title">{title}</span><span className="cover-caption">NOVEL / STORY</span></>}
  </div>;
}

export function Shelf({ projects, books, busy, onOpen, onSave, onRemove, onCreate, onRenameFolder }: {
  projects: Project[]; books: Record<string, BookSnapshot>; busy: boolean;
  onOpen: (project: Project) => void;
  onSave: (id: string, value: BookDetails, hash: string) => Promise<BookSnapshot>;
  onRemove: (project: Project) => Promise<void>;
  onRenameFolder: (project: Project, name: string) => Promise<void>;
  onCreate: (parent: string, title: string, firstChapter: boolean, extra: { introduction: string; coverBase64?: string }) => Promise<{ root: string }>;
}) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [renamingFolder, setRenamingFolder] = useState<Project | null>(null);
  const query = search.trim().toLocaleLowerCase();
  const filtered = projects.filter(p => (books[p.id]?.value.title ?? p.name).toLocaleLowerCase().includes(query));
  return <section className="library-page">
    <div className="page-title"><div><span className="eyebrow">YOUR PERSONAL LIBRARY</span><h1>我的书架<span>{projects.length} 部作品</span></h1><p>每一个世界，都有自己的书页。</p></div><div className="shelf-title-actions"><input aria-label="搜索书架" placeholder="搜索作品名称…" value={search} onChange={e => setSearch(e.target.value)} /><button className="primary" data-testid="new-book-open" disabled={busy} onClick={() => setCreating(true)}>＋ 新建小说</button></div></div>
    <div className="shelf-grid">{filtered.map(project => {
      const book = books[project.id]; const title = book?.value.title ?? project.name;
      return <article className="shelf-card" key={project.id}>
        <button className="cover-button" disabled={busy} aria-label={`打开作品 ${title}`} onClick={() => onOpen(project)}><BookCover title={title} src={book?.covers[book.value.cover]} /></button>
        <div className="card-details"><div className="card-meta">{book?.value.volumes.length ?? 0} 个分集</div><h2 title={title}>{title}</h2><p>{book?.value.introduction || '为这部小说写一段引言，让故事从这里开始。'}</p><div className="card-actions"><button className="primary" disabled={busy} onClick={() => onOpen(project)}>进入创作 →</button><button disabled={busy || !book} aria-label={`编辑作品 ${title}`} onClick={() => setEditing(project)}>书名、封面与分集</button><button disabled={busy || !!editing} aria-label={`修改文件夹名称 ${title}`} onClick={() => setRenamingFolder(project)}>文件夹改名</button><button className="shelf-remove" disabled={busy || !!editing} aria-label={`从书架移除 ${title}`} title="移除仅取消书架关联，原文件保留" onClick={() => void onRemove(project)}>移除</button></div></div>
      </article>;
    })}</div>
    {!filtered.length && <div className="empty-library" role="status"><b>{projects.length ? '没有找到这部作品' : '你的下一部小说，从这里开始'}</b><p>{projects.length ? '试试其他作品名称，或清除搜索条件。' : '点击右上角“打开小说文件夹”，将已有作品加入书架。'}</p>{projects.length > 0 && <button onClick={() => setSearch('')}>清除搜索</button>}</div>}
    {creating && <NewBookWizard busy={busy} onCreate={onCreate} onClose={() => setCreating(false)} />}
    {editing && books[editing.id] && <BookEditor key={editing.id} project={editing} snapshot={books[editing.id]} onSave={onSave} onClose={() => setEditing(null)} />}
    {renamingFolder && <FolderRename project={renamingFolder} onRename={onRenameFolder} onClose={() => setRenamingFolder(null)} />}
  </section>;
}

function FolderRename({ project, onRename, onClose }: { project: Project; onRename: (project: Project, name: string) => Promise<void>; onClose: () => void }) {
  const original = project.root.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
  const parent = project.root.slice(0, project.root.length - original.length);
  const [name, setName] = useState(original), [working, setWorking] = useState(false), [error, setError] = useState('');
  return <div className="modal-overlay"><section className="book-modal" role="dialog" aria-modal="true" aria-label="小说文件夹改名" style={{ width: 640, height: 'auto', maxHeight: '86vh', overflowY: 'auto', padding: '22px 26px' }}>
    <header><div><h2>小说文件夹改名</h2><p>修改这本小说在当前电脑上的实际文件夹名称。</p></div><button disabled={working} onClick={onClose}>关闭</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    <p style={{ overflowWrap: 'anywhere' }}>当前位置：<code>{project.root}</code></p>
    <label>新的文件夹名称<input aria-label="新的小说文件夹名称" autoFocus disabled={working} maxLength={120} value={name} onChange={event => { setName(event.target.value); setError(''); }} /></label>
    <p style={{ overflowWrap: 'anywhere' }}>改名后：<code>{parent}{name || '（请输入名称）'}</code></p>
    <p>小说文件会留在原父目录，书架将更新位置；网络目录暂不支持，其他设备或使用旧路径的程序需要重新定位。操作前请先保存所有修改并结束模型任务。</p>
    <footer><button disabled={working} onClick={onClose}>取消</button><button className="primary" disabled={working || !name.trim() || name === original} onClick={() => { setWorking(true); setError(''); void onRename(project, name).then(onClose).catch(failure => setError(String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, ''))).finally(() => setWorking(false)); }}>{working ? '正在改名…' : '确认修改文件夹'}</button></footer>
  </section></div>;
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
      <div className="book-fields"><label>{selected === 'book' ? '小说名称' : '分集名称'}<input aria-label={selected === 'book' ? '小说名称' : '分集名称'} aria-describedby={selected === 'book' ? 'book-title-scope' : undefined} disabled={locked} maxLength={200} value={entity.title} onChange={e => change({ title: e.target.value })} />{selected === 'book' && <small id="book-title-scope">仅修改书架显示名称，不会重命名本地文件夹。</small>}</label><label>{selected === 'book' ? '小说引言' : '分集引言'}<textarea disabled={locked} maxLength={20000} value={entity.introduction} onChange={e => change({ introduction: e.target.value })} placeholder="故事关于什么？从一句引言开始。" /></label>
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


/** 新建小说向导：书名 → 存放位置 → 预览完整路径 → 创建（可选首章）。 */
function NewBookWizard({ busy, onCreate, onClose }: {
  busy: boolean; onCreate: (parent: string, title: string, firstChapter: boolean, extra: { introduction: string; coverBase64?: string }) => Promise<{ root: string }>; onClose: () => void;
}) {
  const [title, setTitle] = useState(''), [parent, setParent] = useState(''), [firstChapter, setFirstChapter] = useState(true);
  const [busyLocal, setBusyLocal] = useState(false), [error, setError] = useState('');
  const [introduction, setIntroduction] = useState(''), [cover, setCover] = useState<{ base64: string; dataUrl: string } | null>(null);
  const locked = busy || busyLocal;
  const preview = parent && title.trim() ? `${parent.replace(/[\\/]+$/u, '')}\\${title.trim().replace(/[<>:"/\\|?*]/gu, '')}` : '';
  const create = async () => {
    if (locked) return;
    setError(''); setBusyLocal(true);
    try { await onCreate(parent, title, firstChapter, { introduction, coverBase64: cover?.base64 }); onClose(); }
    catch (failure) { setError(String(failure instanceof Error ? failure.message : failure).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')); }
    finally { setBusyLocal(false); }
  };
  return <div className="modal-overlay"><section className="book-modal" role="dialog" aria-modal="true" aria-label="新建小说" style={{ width: 640, height: 'auto', maxHeight: '86vh', overflowY: 'auto', padding: '22px 26px' }}>
    <header><div><h2>新建小说</h2><p>文件夹会在所选位置下新建；同名文件夹不会被复用。</p></div><button disabled={locked} onClick={onClose}>关闭</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    <label>小说的名字<input aria-label="小说名字" data-testid="new-book-title" disabled={locked} maxLength={60} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：海上城邦" /></label>
    <label>封面（可选）<div className="new-book-path"><button type="button" disabled={locked} data-testid="new-book-cover" onClick={() => void window.writer.pickCoverImage().then(picked => { if (picked) setCover(picked); }).catch(failure => setError(String(failure)))}>{cover ? '更换封面…' : '选择封面图片…'}</button>{cover && <img data-testid="new-book-cover-preview" alt="封面预览" src={cover.dataUrl} style={{ width: 52, height: 72, objectFit: 'cover', borderRadius: 6 }} />}<span className="fidelity-copy-help">PNG / JPG / WebP，最大 8 MB</span></div></label>
    <label>引言（可选）<textarea aria-label="小说引言" data-testid="new-book-introduction" disabled={locked} maxLength={20000} rows={3} value={introduction} onChange={event => setIntroduction(event.target.value)} placeholder="一句话说明这部小说写什么。" /></label>
    <label>存放位置<div className="new-book-path"><input aria-label="存放位置" data-testid="new-book-parent" disabled={locked} readOnly value={parent} placeholder="尚未选择" /><button type="button" disabled={locked} data-testid="new-book-pick" onClick={() => void window.writer.pickProjectParent().then(picked => { if (picked) setParent(picked); })}>选择位置…</button></div></label>
    <p className="fidelity-copy-help" data-testid="new-book-preview">最终文件夹：{preview || '（选择位置并填写书名后显示）'}</p>
    <label className="ai-check"><input type="checkbox" aria-label="同时创建首章" disabled={locked} checked={firstChapter} onChange={event => setFirstChapter(event.target.checked)} />同时创建第一章（DOCX，宋体五号、段首两个全角空格）</label>
    <footer><span role="status">{busyLocal ? '正在创建…' : '创建后可在写作页继续导入已有章节'}</span><div><button disabled={locked} onClick={onClose}>取消</button><button className="primary" data-testid="new-book-create" disabled={locked || !title.trim() || !parent} onClick={() => void create()}>创建小说</button></div></footer>
  </section></div>;
}
