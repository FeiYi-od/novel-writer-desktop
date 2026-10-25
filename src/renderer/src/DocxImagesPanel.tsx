import { useEffect, useRef, useState } from 'react';
import type { FidelityTarget } from './FidelityCopyEditor';
import { exitSaves } from './save-before-exit';
import './docx-images.css';

type DocxImage = { name: string; bytes: number };
type ImageCopy = { path: string; name: string };
const identity = (target: FidelityTarget) => `${target.projectId}\0${target.path}\0${target.hash}`;
const editable = (name: string) => /^word\/media\/[^/\\\u0000-\u001f:]+\.(?:png|jpe?g)$/iu.test(name);
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const cleanError = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');

/** Replaces one existing media part in a separate copy of a frozen DOCX source. */
export function DocxImagesPanel({ target, blocked, onBusy, onClose, onSaved }: {
  target: FidelityTarget;
  blocked: boolean;
  onBusy: (value: boolean) => void;
  onClose: () => void;
  onSaved: (result: ImageCopy) => Promise<void>;
}) {
  const [images, setImages] = useState<DocxImage[]>([]), [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState<ImageCopy | null>(null);
  const panel = useRef<HTMLElement>(null), message = useRef<HTMLDivElement>(null);
  const mounted = useRef(false), running = useRef(true), ticket = useRef(0);
  const current = useRef(identity(target)); current.current = identity(target);
  const savedRef = useRef<ImageCopy | null>(null);
  const valid = (frozen: FidelityTarget, request: number) => mounted.current && current.current === identity(frozen) && ticket.current === request;

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { if (busy) panel.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => { if (error || notice || saved) message.current?.scrollIntoView({ block: 'nearest' }); }, [error, notice, saved]);
  useEffect(() => {
    mounted.current = true; const frozen = { ...target }, request = ++ticket.current;
    running.current = true; savedRef.current = null;
    setBusy(true); setLoaded(false); setImages([]); setSelected(''); setError(''); setNotice(''); setSaved(null);
    // The pending operation stays registered if another view unmounts this panel.
    const release = exitSaves.register('读取 Word 图片列表', () => ({ dirty: false, busy: true }));
    void window.writer.docxImages(frozen.projectId, frozen.path, frozen.hash).then(value => {
      if (!valid(frozen, request)) return;
      if (!Array.isArray(value) || value.length > 4096 || value.some(item => typeof item.name !== 'string' || item.name.length > 2000 || !Number.isSafeInteger(item.bytes) || item.bytes < 0)
        || new Set(value.map(item => item.name)).size !== value.length) throw new Error('图片列表格式无效，请关闭后重新打开原稿');
      setImages(value); setLoaded(true);
      setSelected(value.find(item => editable(item.name))?.name ?? '');
    }).catch(failure => { if (valid(frozen, request)) setError(cleanError(failure)); }).finally(() => {
      release(); if (valid(frozen, request)) { running.current = false; setBusy(false); }
    });
    return () => { mounted.current = false; ticket.current++; };
  }, [target.projectId, target.path, target.hash]);

  async function replace() {
    const image = images.find(item => item.name === selected);
    if (running.current || blocked || !loaded || !image || !editable(image.name) || savedRef.current) return;
    const frozen = { ...target }, name = image.name, request = ++ticket.current;
    running.current = true; setBusy(true); setError(''); setNotice('');
    const release = exitSaves.register('正在另存 Word 换图副本', () => ({ dirty: false, busy: true }));
    try {
      const result = await window.writer.replaceDocxImage(frozen.projectId, frozen.path, name, frozen.hash);
      if (!valid(frozen, request)) return;
      if (!result) { setNotice('已取消选择图片，没有生成新副本。'); return; }
      if (result.name !== name || typeof result.path !== 'string' || !result.path || result.path === frozen.path)
        throw new Error('换图结果与所选图片或原稿路径不匹配，请核对章节目录');
      savedRef.current = result; setSaved(result);
      // Record success before refreshing the parent: a refresh failure must never create another copy on retry.
      try { await onSaved(result); }
      catch (failure) { if (valid(frozen, request)) setError(`新副本已生成，但章节目录刷新失败：${cleanError(failure)}`); }
    } catch (failure) { if (valid(frozen, request)) setError(cleanError(failure)); }
    finally { release(); if (valid(frozen, request)) { running.current = false; setBusy(false); } }
  }
  const close = () => { if (!running.current && !blocked) onClose(); };
  const chosen = images.find(item => item.name === selected);

  return <div className="modal-overlay docx-images-overlay"><section ref={panel} tabIndex={-1} className="book-modal docx-images-panel" role="dialog" aria-modal="true" aria-labelledby="docx-images-title" aria-busy={busy} data-testid="docx-images-panel" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)')], first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="docx-images-title">Word 图片替换</h2><p>{target.path}</p></div><button type="button" data-testid="docx-images-close" disabled={busy || blocked} onClick={close}>关闭</button></header>
    <p className="docx-images-help">选择原稿中已有的 PNG/JPEG 图片部件，再选择一张本机图片，立即另存一个新 DOCX。保留原稿、现有图片布局与其他部件；如果同一图片部件在多处引用，新副本中的这些位置会一同更新。此处不新插图片、不调整尺寸，也不展示页面排版。</p>
    <div ref={message}>{error && <div role="alert" className="error" data-testid="docx-images-error">{error}<span>{saved ? '已生成的副本保持保留，请到章节目录核对。' : '原稿保留。原稿版本变化时，请关闭本页并重新打开章节。'}</span></div>}
      {notice && <p role="status" className="docx-images-notice" data-testid="docx-images-notice">{notice}</p>}
      {saved && <section className="docx-images-result" role="status" data-testid="docx-images-result"><strong>已另存换图副本</strong><code>{saved.path}</code><p>替换部件：{saved.name}。原稿保留，请打开新副本核对效果。</p></section>}</div>
    <div className="docx-images-content"><h3>原稿图片部件 · {images.length}</h3>
      {loaded && images.length === 0 && <p className="docx-images-help" data-testid="docx-images-empty">此文档没有内嵌图片部件。链接到外部的图片不会在这里读取或替换。</p>}
      <ul aria-label="Word 图片部件">{images.map(image => <li key={image.name}><button type="button" data-testid="docx-image-target" data-name={image.name} aria-pressed={selected === image.name} aria-label={`选择图片部件 ${image.name}`} disabled={busy || blocked || !!saved || !editable(image.name)} onClick={() => { if (!running.current) { setSelected(image.name); setError(''); setNotice(''); } }}><code>{image.name}</code><span>{size(image.bytes)}</span><small>{editable(image.name) ? '可替换 · PNG/JPEG' : '只读 · 暂不支持此图片格式'}</small></button></li>)}</ul>
      {images.some(image => !editable(image.name)) && <p className="docx-images-help">其他图片格式仅列出文件名与大小，保持原样；请使用 Word/WPS 编辑。</p>}
      {chosen && <p className="docx-images-selection" data-testid="docx-images-selection">当前目标：<code>{chosen.name}</code>。选择 PNG/JPEG 后按目标图片格式写入，沿用文档内的原尺寸与引用。</p>}
    </div>
    <footer><p role="status" data-testid="docx-images-status">{busy ? '正在读取 / 选择图片 / 另存副本，请稍候…' : saved ? '新副本已生成，原稿保留' : loaded ? '选择图片后立即另存，无需再次保存' : '尚未成功读取图片列表'}{blocked && '；请等待当前操作完成'}</p><button type="button" className="primary" data-testid="docx-images-replace" disabled={busy || blocked || !!saved || !loaded || !chosen || !editable(chosen.name)} onClick={() => void replace()}>选择图片并另存副本</button></footer>
  </section></div>;
}
