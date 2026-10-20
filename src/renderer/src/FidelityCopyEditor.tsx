import { useEffect, useRef, useState } from 'react';
import { exitSaves, useSaveBeforeExit } from './save-before-exit';

export type FidelityTarget = { projectId: string; path: string; hash: string };
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
const sameParagraphs = (left: string[], right: string[]) => left.length === right.length && left.every((paragraph, index) => paragraph === right[index]);
const PAGE_SIZE = 50;

/** Edits a frozen disk version rather than the lossy HTML manuscript preview. */
export function FidelityCopyEditor({ target, blocked, onDirty, onSaved, onClose, onSaveExit }: {
  target: FidelityTarget; blocked: boolean; onDirty: (value: boolean) => void;
  onSaved: (target: FidelityTarget, result: { path: string; paragraphs: number; changed: number }) => Promise<void>;
  onClose: () => void;
  onSaveExit: () => Promise<void>;
}) {
  const [paragraphs, setParagraphs] = useState<string[]>([]), [selected, setSelected] = useState(0);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const original = useRef<string[]>([]), current = useRef<string[]>([]), busyRef = useRef(true), alive = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const dirty = loaded && !sameParagraphs(paragraphs, original.current);
  useEffect(() => { const previous = document.activeElement; dialog.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => {
    alive.current = true; let disposed = false;
    const release = exitSaves.register('读取 Word 原稿', () => ({ dirty: false, busy: true }));
    void window.writer.readFidelitySource(target.projectId, target.path, target.hash).then(source => {
      if (disposed) return;
      if (source.projectId !== target.projectId || source.path !== target.path || source.hash !== target.hash) throw new Error('原稿版本或小说不匹配，请重新打开章节');
      original.current = [...source.paragraphs]; current.current = [...source.paragraphs];
      setParagraphs(source.paragraphs); setLoaded(true);
    }).catch(failure => { if (!disposed) setError(cleanError(failure)); }).finally(() => {
      release(); if (!disposed) { busyRef.current = false; setBusy(false); }
    });
    return () => { disposed = true; alive.current = false; };
  }, [target.projectId, target.path, target.hash]);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  async function save() {
    if (busyRef.current) throw new Error('Word 副本正在处理，请等待完成');
    if (!loaded) throw new Error('尚未读取原稿，不能保存');
    if (sameParagraphs(current.current, original.current)) return;
    const frozen = [...current.current]; busyRef.current = true; setBusy(true); setError('');
    // Keep the pending IPC registered even if another navigation unmounts this dialog.
    const release = exitSaves.register('Word 保真副本', () => ({ dirty: false, busy: true }));
    try {
      const result = await window.writer.saveFidelityCopy(target.projectId, target.path, frozen, target.hash);
      original.current = frozen;
      if (alive.current) { setParagraphs([...frozen]); await onSaved(target, result); }
    } catch (failure) { if (alive.current) setError(cleanError(failure)); throw failure; }
    finally { release(); busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useSaveBeforeExit('Word 保真副本', () => ({ dirty: loaded && !sameParagraphs(current.current, original.current), busy: busyRef.current, save }));
  const close = () => { if (!busyRef.current && !blocked && (!dirty || window.confirm('保真副本有未保存修改，确定放弃并关闭吗？'))) onClose(); };
  const update = (next: string[]) => { current.current = next; setParagraphs(next); setError(''); };
  const page = Math.floor(selected / PAGE_SIZE), pageStart = page * PAGE_SIZE;
  return <div className="modal-overlay"><section ref={dialog} tabIndex={-1} className="book-modal fidelity-copy" role="dialog" aria-modal="true" aria-label="Word 保真副本编辑" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!busy && !blocked && dirty) void save().catch(() => {}); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><div><h2>Word 保真副本编辑</h2><p>{target.path}</p></div><button disabled={busy || blocked} onClick={close}>关闭</button></header>
    <p className="fidelity-copy-help">修改正文段落后另存新 DOCX。原稿保留，表格、图片及页眉等部件沿用原文件；不支持的结构会提示并停止保存。</p>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="fidelity-copy-content">
      <aside><div className="fidelity-copy-pagination"><button disabled={busy || blocked || page === 0} onClick={() => setSelected(Math.max(0, pageStart - PAGE_SIZE))}>上一页</button><span>{paragraphs.length ? page + 1 : 0} / {Math.ceil(paragraphs.length / PAGE_SIZE)}</span><button disabled={busy || blocked || pageStart + PAGE_SIZE >= paragraphs.length} onClick={() => setSelected(pageStart + PAGE_SIZE)}>下一页</button></div>
        <ol start={pageStart + 1} aria-label="原稿正文段落">{paragraphs.slice(pageStart, pageStart + PAGE_SIZE).map((paragraph, offset) => { const index = pageStart + offset; return <li key={index}><button disabled={busy || blocked} aria-pressed={index === selected} aria-label={`编辑第 ${index + 1} 段`} onClick={() => setSelected(index)}>{paragraph.trim().slice(0, 80) || '（空段）'}</button></li>; })}</ol>
      </aside>
      <div className="fidelity-copy-text"><label htmlFor="fidelity-paragraph">{paragraphs.length ? `第 ${selected + 1} 段` : '原稿暂无正文段落'}</label><textarea id="fidelity-paragraph" aria-label="保真段落正文" disabled={busy || blocked || !loaded || !paragraphs.length} value={paragraphs[selected] ?? ''} onChange={event => update(paragraphs.map((value, index) => index === selected ? event.target.value : value))} />
        <div className="fidelity-copy-controls"><button disabled={busy || blocked || !loaded || paragraphs.length >= 10000} onClick={() => { update([...paragraphs, '　　']); setSelected(paragraphs.length); }}>末尾新增段落</button><button disabled={busy || blocked || !loaded || !paragraphs.length} onClick={() => { if (paragraphs.at(-1)?.trim() && !window.confirm('删除最后一段正文？保存时仍会保留原稿。')) return; update(paragraphs.slice(0, -1)); setSelected(value => Math.min(value, Math.max(0, paragraphs.length - 2))); }}>删除末段</button></div>
        <small>新增段落带两个可复制的全角空格。此页按原稿正文段落编辑，表格内文字不在此列表。</small>
      </div>
    </div>
    <footer><span role="status">{busy ? '正在处理…' : dirty ? '副本有未保存修改' : loaded ? `已读取 ${paragraphs.length} 个正文段落` : '未读取原稿'}</span><div><button disabled={busy || blocked} onClick={close}>取消</button><button className="fidelity-exit" disabled={busy || blocked} onClick={() => void onSaveExit()}>保存副本并退出应用</button><button className="primary" data-testid="fidelity-save" disabled={busy || blocked || !dirty} onClick={() => void save().catch(() => {})}>另存保真 DOCX</button></div></footer>
  </section></div>;
}
