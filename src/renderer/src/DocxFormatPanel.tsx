import { useEffect, useRef, useState } from 'react';
import type { FidelityTarget } from './FidelityCopyEditor';

type Align = 'left' | 'center' | 'right' | 'both';
type Draft = { align?: Align; firstLineChars?: number; lineSpacing?: number; spaceBeforePt?: number; spaceAfterPt?: number };
const cleanError = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
const PAGE = 40;

/** 段落排版：只改对齐/首行缩进/行距/段间距，另存“排版副本”，原稿不动。 */
export function DocxFormatPanel({ target, blocked, onClose, onBusy, onSaved }: {
  target: FidelityTarget; blocked: boolean; onClose: () => void;
  onBusy: (value: boolean) => void;
  onSaved: (result: { path: string; changed: number }) => Promise<void>;
}) {
  const [paragraphs, setParagraphs] = useState<string[]>([]), [selected, setSelected] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [saved, setSaved] = useState<string>('');
  const alive = useRef(true), ticket = useRef(0), dialog = useRef<HTMLElement>(null);
  const targets = Object.entries(drafts).map(([index, format]) => ({ index: Number(index), format })).sort((a, b) => a.index - b.index);
  const inactive = busy || blocked || !!saved;
  useEffect(() => { const previous = document.activeElement; dialog.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  useEffect(() => {
    alive.current = true; const request = ++ticket.current;
    const release = performance.now();
    void window.writer.readFidelitySource(target.projectId, target.path, target.hash).then(source => {
      if (!alive.current || ticket.current !== request) return;
      if (source.projectId !== target.projectId || source.path !== target.path || source.hash !== target.hash) throw new Error('原稿版本或小说不匹配，请重新打开章节');
      setParagraphs(source.paragraphs);
    }).catch(failure => { if (alive.current && ticket.current === request) setError(cleanError(failure)); })
      .finally(() => { if (alive.current && ticket.current === request) { setBusy(false); onBusy(false); } });
    return () => { alive.current = false; ticket.current++; onBusy(false); };
  }, [target.projectId, target.path, target.hash, onBusy]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const setDraft = (patch: Draft) => setDrafts(current => {
    const next = { ...current, [selected]: { ...current[selected], ...patch } };
    for (const key of Object.keys(patch) as (keyof Draft)[]) {
      if (patch[key] === undefined || (typeof patch[key] === 'number' && Number.isNaN(patch[key] as number))) {
        const copy = { ...next[selected] }; delete copy[key]; next[selected] = copy;
      }
    }
    if (!Object.keys(next[selected]).length) delete next[selected];
    return next;
  });
  const save = async () => {
    if (inactive || !targets.length) return;
    setBusy(true); setError('');
    try {
      const result = await window.writer.formatDocxParagraphs(target.projectId, target.path, targets, target.hash);
      if (!alive.current) return;
      if (result.projectId !== target.projectId || result.sourcePath !== target.path || result.sourceHash !== target.hash)
        throw new Error('排版结果与原稿版本或小说不匹配，请重新核对原稿');
      setSaved(result.path);
      await onSaved(result);
    } catch (failure) { if (alive.current) setError(cleanError(failure)); }
    finally { if (alive.current) setBusy(false); }
  };
  const page = Math.floor(selected / PAGE), start = page * PAGE, draft = drafts[selected] ?? {};
  return <div className="modal-overlay" aria-hidden="false"><section ref={dialog} tabIndex={-1} className="book-modal" role="dialog" aria-modal="true" aria-label="段落排版" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }} style={{ width: 900, height: 'auto', maxHeight: '88vh', overflowY: 'auto', padding: '22px 26px' }}>
    <header><div><h2>段落排版</h2><p>{target.path}</p></div><button disabled={busy} onClick={onClose}>关闭</button></header>
    <p className="fidelity-copy-help">只改对齐、首行缩进、行距与段前段后间距，另存「排版副本」；原稿与其它内容（表格、图片、页眉）都不动。不承诺支持分节、编号、脚注与样式表级联。</p>
    {error && <div role="alert" className="error">{error}</div>}
    {saved && <p role="status">排版副本已生成：{saved}。请关闭后打开新副本查看。</p>}
    <div className="fidelity-copy-content">
      <aside>
        <div className="fidelity-copy-pagination"><button disabled={inactive || page === 0} onClick={() => setSelected(Math.max(0, start - PAGE))}>上一页</button><span>{paragraphs.length ? page + 1 : 0} / {Math.ceil(paragraphs.length / PAGE)}</span><button disabled={inactive || start + PAGE >= paragraphs.length} onClick={() => setSelected(start + PAGE)}>下一页</button></div>
        <ol start={start + 1} aria-label="正文段落">{paragraphs.slice(start, start + PAGE).map((text, offset) => { const index = start + offset; return <li key={index}><button disabled={inactive} aria-pressed={index === selected} aria-label={`选择第 ${index + 1} 段`} onClick={() => setSelected(index)}>{drafts[index] ? '· ' : ''}{text.trim().slice(0, 60) || '（空段）'}</button></li>; })}</ol>
      </aside>
      <div>
        <label htmlFor="format-align">对齐方式</label>
        <select id="format-align" data-testid="format-align" disabled={inactive} value={draft.align ?? ''} onChange={event => setDraft({ align: event.target.value ? event.target.value as Align : undefined })}>
          <option value="">保持不变</option><option value="both">两端对齐</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
        </select>
        <label htmlFor="format-indent">首行缩进（字符）</label>
        <input id="format-indent" data-testid="format-indent" type="number" min={0} max={20} step={1} disabled={inactive} value={draft.firstLineChars ?? ''} placeholder="保持不变" onChange={event => setDraft({ firstLineChars: event.target.value === '' ? undefined : Number(event.target.value) })} />
        <label htmlFor="format-spacing">行距（倍数）</label>
        <input id="format-spacing" data-testid="format-spacing" type="number" min={1} max={3} step={0.25} disabled={inactive} value={draft.lineSpacing ?? ''} placeholder="保持不变" onChange={event => setDraft({ lineSpacing: event.target.value === '' ? undefined : Number(event.target.value) })} />
        <label htmlFor="format-before">段前间距（磅）</label>
        <input id="format-before" data-testid="format-before" type="number" min={0} max={200} step={1} disabled={inactive} value={draft.spaceBeforePt ?? ''} placeholder="保持不变" onChange={event => setDraft({ spaceBeforePt: event.target.value === '' ? undefined : Number(event.target.value) })} />
        <label htmlFor="format-after">段后间距（磅）</label>
        <input id="format-after" data-testid="format-after" type="number" min={0} max={200} step={1} disabled={inactive} value={draft.spaceAfterPt ?? ''} placeholder="保持不变" onChange={event => setDraft({ spaceAfterPt: event.target.value === '' ? undefined : Number(event.target.value) })} />
        <p className="fidelity-copy-help" data-testid="format-summary">已设置 {targets.length} 段；保存时另存新 DOCX，原稿保留。</p>
      </div>
    </div>
    <footer><span role="status">{busy ? '正在处理…' : saved ? '已生成排版副本' : `已读取 ${paragraphs.length} 段`}</span><div><button disabled={busy} onClick={onClose}>取消</button><button className="primary" data-testid="format-save" disabled={inactive || !targets.length} onClick={() => void save()}>另存排版副本 DOCX</button></div></footer>
  </section></div>;
}
