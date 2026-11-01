import { useEffect, useRef, useState } from 'react';
import { exitSaves, useSaveBeforeExit } from './save-before-exit';
import { DocxStructurePanel } from './DocxStructurePanel';
import { DocxImagesPanel } from './DocxImagesPanel';
import { DocxFormatPanel } from './DocxFormatPanel';
import { bodyActions, bodyDraft, bodyStructuralChanges, insertBodyParagraph, type BodyDraftParagraph } from '../../core/docx-body-draft';
import type { DocxBodyEditResult, DocxBodySnapshot } from '../../shared/docx-body';

export type FidelityTarget = { projectId: string; path: string; hash: string };
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
const identity = (target: FidelityTarget) => `${target.projectId}\0${target.path}\0${target.hash}`;
const PAGE_SIZE = 50;

/** All edits keep their original paragraph identity; intervening Word objects never shift. */
export function FidelityCopyEditor({ target, blocked, onDirty, onSaved, onClose, onSaveExit }: {
  target: FidelityTarget; blocked: boolean; onDirty: (value: boolean) => void;
  onSaved: (target: FidelityTarget, result: { path: string; paragraphs?: number; changed: number }) => Promise<void>;
  onClose: () => void;
  onSaveExit: () => Promise<void>;
}) {
  const [paragraphs, setParagraphs] = useState<BodyDraftParagraph[]>([]), [selected, setSelected] = useState(0);
  const [snapshot, setSnapshot] = useState<DocxBodySnapshot | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [saved, setSaved] = useState<DocxBodyEditResult | null>(null);
  const [structureOpen, setStructureOpen] = useState(false), [structureDirty, setStructureDirty] = useState(false), [structureBusy, setStructureBusy] = useState(false);
  const [imagesOpen, setImagesOpen] = useState(false), [imagesBusy, setImagesBusy] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false), [formatBusy, setFormatBusy] = useState(false);
  const baseline = useRef<DocxBodySnapshot | null>(null), current = useRef<BodyDraftParagraph[]>([]), busyRef = useRef(true), alive = useRef(false);
  const published = useRef<DocxBodyEditResult | null>(null), ticket = useRef(0), newId = useRef(0);
  const targetIdentity = useRef(identity(target)); targetIdentity.current = identity(target);
  const dialog = useRef<HTMLElement>(null);
  const dirty = !saved && bodyActions(snapshot, paragraphs).length > 0;
  const inactive = busy || blocked || !!saved;
  const structuralChanges = bodyStructuralChanges(snapshot, paragraphs);
  const selectedParagraph = paragraphs[selected];
  const valid = (frozen: FidelityTarget, request: number) => alive.current && targetIdentity.current === identity(frozen) && ticket.current === request;
  useEffect(() => { const previous = document.activeElement; dialog.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => {
    alive.current = true; const frozen = { ...target }, request = ++ticket.current;
    busyRef.current = true; baseline.current = null; current.current = []; published.current = null;
    setBusy(true); setSnapshot(null); setParagraphs([]); setSelected(0); setError(''); setSaved(null);
    const release = exitSaves.register('读取 Word 原稿', () => ({ dirty: false, busy: true }));
    void window.writer.readFidelityBody(frozen.projectId, frozen.path, frozen.hash).then(source => {
      if (!valid(frozen, request)) return;
      if (source.schemaVersion !== 1 || source.projectId !== frozen.projectId || source.path !== frozen.path || source.hash !== frozen.hash) throw new Error('原稿版本或小说不匹配，请重新打开章节');
      const next = bodyDraft(source); baseline.current = source; current.current = next;
      setSnapshot(source); setParagraphs(next);
    }).catch(failure => { if (valid(frozen, request)) setError(cleanError(failure)); }).finally(() => {
      release(); if (valid(frozen, request)) { busyRef.current = false; setBusy(false); }
    });
    return () => { alive.current = false; ticket.current++; };
  }, [target.projectId, target.path, target.hash]);
  useEffect(() => { onDirty(dirty || busy || structureDirty || structureBusy || imagesBusy || formatBusy); return () => onDirty(false); }, [dirty, busy, structureDirty, structureBusy, imagesBusy, onDirty]);
  async function save() {
    if (busyRef.current || structureBusy || imagesBusy || formatBusy || blocked) throw new Error('Word 副本正在处理，请等待完成');
    if (!baseline.current) throw new Error('尚未读取原稿，不能保存');
    if (published.current) return;
    const actions = bodyActions(baseline.current, current.current); if (!actions.length) return;
    const frozen = { ...target }, request = ++ticket.current;
    busyRef.current = true; setBusy(true); setError('');
    const release = exitSaves.register('Word 保真副本', () => ({ dirty: false, busy: true }));
    try {
      const result = await window.writer.editFidelityBody(frozen.projectId, frozen.path, actions, frozen.hash);
      if (!valid(frozen, request)) return;
      if (result.projectId !== frozen.projectId || result.sourcePath !== frozen.path || result.sourceHash !== frozen.hash) throw new Error('副本结果与原稿版本或小说不匹配，请重新核对原稿');
      published.current = result; setSaved(result);
      await onSaved(frozen, result);
    } catch (failure) { if (valid(frozen, request)) setError(cleanError(failure)); throw failure; }
    finally { release(); if (valid(frozen, request)) { busyRef.current = false; setBusy(false); } }
  }
  useSaveBeforeExit('Word 保真副本', () => ({ dirty: !published.current && bodyActions(baseline.current, current.current).length > 0, busy: busyRef.current || structureBusy || imagesBusy || formatBusy, save }));
  const close = () => { if (!structureOpen && !imagesOpen && !busyRef.current && !blocked && (!dirty || window.confirm('保真副本有未保存修改，确定放弃并关闭吗？'))) onClose(); };
  const update = (next: BodyDraftParagraph[]) => { current.current = next; setParagraphs(next); setError(''); };
  const canInsert = (index: number) => !inactive && !!snapshot && paragraphs.length < 10000 && structuralChanges < 200 && !!paragraphs[index]?.insertable;
  const insert = (index: number, position: 'before' | 'after') => {
    if (!canInsert(index)) return;
    update(insertBodyParagraph(current.current, index, position, `new-${++newId.current}`)); setSelected(index + (position === 'after' ? 1 : 0));
  };
  const canRemove = (index: number) => !inactive && paragraphs.length > 1 && !!paragraphs[index]?.removable && (paragraphs[index].sourceIndex === null || structuralChanges < 200);
  const remove = (index: number) => {
    if (!canRemove(index)) return;
    if (current.current[index].text.trim() && !window.confirm('从本次副本中删除这一段正文？保存时仍会保留原稿。')) return;
    const next = current.current.filter((_, offset) => offset !== index); update(next); setSelected(Math.min(index, next.length - 1));
  };
  const page = Math.floor(selected / PAGE_SIZE), pageStart = page * PAGE_SIZE;
  return <><div className="modal-overlay" inert={structureOpen || imagesOpen} aria-hidden={structureOpen || imagesOpen || undefined}><section ref={dialog} tabIndex={-1} className="book-modal fidelity-copy" role="dialog" aria-modal="true" aria-label="Word 保真副本编辑" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!inactive && dirty) void save().catch(() => {}); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])], first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><div><h2>Word 保真副本编辑</h2><p>{target.path}</p></div><button disabled={busy || blocked} onClick={close}>关闭</button></header>
    <p className="fidelity-copy-help">修改或插删正文段落后另存新 DOCX。原稿保留，表格、图片及页眉等部件沿用原文件。<button type="button" data-testid="docx-structure-open" disabled={inactive || dirty || structureOpen || imagesOpen || formatOpen} onClick={() => { if (!busyRef.current && !dirty) setStructureOpen(true); }}>表格与页眉页脚…</button><button type="button" data-testid="docx-images-open" disabled={inactive || dirty || structureOpen || imagesOpen || formatOpen} onClick={() => { if (!busyRef.current && !dirty) setImagesOpen(true); }}>替换已有图片…</button><button type="button" data-testid="docx-format-open" disabled={inactive || dirty || structureOpen || imagesOpen || formatOpen} onClick={() => { if (!busyRef.current && !dirty) setFormatOpen(true); }}>段落排版…</button>{dirty && <span>正文段落有未保存修改，请先另存保真 DOCX，再打开新副本编辑结构、图片或排版；当前正文修改保留。</span>}</p>
    {error && <div role="alert" className="error">{error}</div>}
    {saved && <p role="status">副本已生成：{saved.path}。请关闭此页后打开新副本继续编辑。</p>}
    <div className="fidelity-copy-content">
      <aside><div className="fidelity-copy-pagination"><button disabled={inactive || page === 0} onClick={() => setSelected(Math.max(0, pageStart - PAGE_SIZE))}>上一页</button><span>{paragraphs.length ? page + 1 : 0} / {Math.ceil(paragraphs.length / PAGE_SIZE)}</span><button disabled={inactive || pageStart + PAGE_SIZE >= paragraphs.length} onClick={() => setSelected(pageStart + PAGE_SIZE)}>下一页</button></div>
        <ol start={pageStart + 1} aria-label="原稿正文段落">{paragraphs.slice(pageStart, pageStart + PAGE_SIZE).map((paragraph, offset) => { const index = pageStart + offset; return <li key={paragraph.key}><button disabled={inactive} aria-pressed={index === selected} aria-label={`编辑第 ${index + 1} 段`} onClick={() => setSelected(index)}>{paragraph.sourceIndex === null && '【新增】'}{paragraph.text.trim().slice(0, 80) || '（空段）'}</button></li>; })}</ol>
      </aside>
      <div className="fidelity-copy-text"><label htmlFor="fidelity-paragraph">{paragraphs.length ? `第 ${selected + 1} 段${selectedParagraph?.sourceIndex === null ? ' · 新增' : ''}` : '原稿暂无正文段落'}</label><textarea id="fidelity-paragraph" aria-label="保真段落正文" disabled={inactive || !snapshot || !selectedParagraph?.editable} value={selectedParagraph?.text ?? ''} onChange={event => update(paragraphs.map((value, index) => index === selected ? { ...value, text: event.target.value } : value))} />
        {selectedParagraph?.reason && <p className="fidelity-copy-help" data-testid="fidelity-body-restriction">{selectedParagraph.reason}</p>}
        <div className="fidelity-copy-controls"><button data-testid="fidelity-body-insert-before" disabled={!canInsert(selected)} onClick={() => insert(selected, 'before')}>在此段前插入</button><button data-testid="fidelity-body-insert-after" disabled={!canInsert(selected)} onClick={() => insert(selected, 'after')}>在此段后插入</button><button data-testid="fidelity-body-remove" disabled={!canRemove(selected)} onClick={() => remove(selected)}>删除当前段</button><button disabled={!canInsert(paragraphs.length - 1)} onClick={() => insert(paragraphs.length - 1, 'after')}>末尾新增段落</button><button disabled={!canRemove(paragraphs.length - 1)} onClick={() => remove(paragraphs.length - 1)}>删除末段</button></div>
        <small>新增段落为宋体五号，带两个可复制的全角空格。插入紧邻所选段落，段间表格保留原位置；本批最多插删 200 段。含受保护结构的段落会限制操作。</small>
      </div>
    </div>
    <footer><span role="status">{busy ? '正在处理…' : dirty ? `副本有未保存修改 · 插删 ${structuralChanges} 段` : snapshot ? `已读取 ${paragraphs.length} 个正文段落` : '未读取原稿'}</span><div><button disabled={busy || blocked} onClick={close}>取消</button><button className="fidelity-exit" disabled={busy || blocked} onClick={() => void onSaveExit().catch(failure => { if (alive.current) setError(cleanError(failure)); })}>保存副本并退出应用</button><button className="primary" data-testid="fidelity-save" disabled={inactive || !dirty} onClick={() => void save().catch(() => {})}>另存保真 DOCX</button></div></footer>
  </section></div>{formatOpen && <DocxFormatPanel key={target.projectId + ':' + target.path + ':' + target.hash} target={target} blocked={blocked} onBusy={setFormatBusy} onClose={() => setFormatOpen(false)} onSaved={result => onSaved(target, result)} />}{structureOpen && <DocxStructurePanel key={`${target.projectId}:${target.path}:${target.hash}`} target={target} blocked={blocked} onDirty={setStructureDirty} onBusy={setStructureBusy} onClose={() => setStructureOpen(false)} onSaveExit={onSaveExit} onSaved={result => onSaved(target, result)} />}{imagesOpen && <DocxImagesPanel key={`${target.projectId}:${target.path}:${target.hash}`} target={target} blocked={blocked} onBusy={setImagesBusy} onClose={() => setImagesOpen(false)} onSaved={result => onSaved(target, { path: result.path, changed: 1 })} />}</>;
}
