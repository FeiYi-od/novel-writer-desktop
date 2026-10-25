import { useEffect, useRef, useState } from 'react';
import type { MaterialHistoryFile, MaterialHistoryImportPreview, MaterialHistoryImportResult } from '../../shared/material-sync';
import { useSaveBeforeExit } from './save-before-exit';
import './material-history.css';

interface Props {
  projectId: string;
  title: string;
  blocked: boolean;
  onBeforeCopy: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const changes: Record<MaterialHistoryFile['change'], string> = { unchanged: '内容相同', changed: '内容不同', 'history-only': '仅归档存在', 'current-only': '仅当前存在' };

function ImportSide({ side, file, preview }: { side: 'current' | 'history'; file: MaterialHistoryFile; preview: MaterialHistoryImportPreview }) {
  const hash = side === 'current' ? file.currentHash : file.historyHash;
  const detail = preview.detail?.path === file.path ? preview.detail : undefined;
  const text = side === 'current' ? detail?.currentText : detail?.historyText;
  const truncated = side === 'current' ? detail?.currentTruncated : detail?.historyTruncated;
  return <section className="material-history-side" aria-label={`${file.path} ${side === 'current' ? '当前资料' : '归档资料'}`}>
    <h4>{side === 'current' ? '当前资料' : '归档资料'}</h4><code>{hash === null ? '此侧不存在该文件' : `SHA-256 ${hash}`}</code>
    {hash === null ? <p>（不存在）</p> : !detail ? <p>请选择文件读取预览。</p> : text === undefined ? <p>此文件不提供纯文本预览，导入副本保留原字节。</p> : <pre>{text || '（空文件）'}</pre>}
    {truncated && <p className="material-history-truncated">仅预览前16,000个字符；副本保存完整文件。</p>}
  </section>;
}

/** Native-picker authorization and a frozen preview precede a new-only recovery copy. */
export function MaterialHistoryImportPanel({ projectId, title, blocked, onBeforeCopy, onBusy, onClose }: Props) {
  const [preview, setPreview] = useState<MaterialHistoryImportPreview | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [result, setResult] = useState<MaterialHistoryImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false), running = useRef(false), consumed = useRef(false), request = useRef(0);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const panel = useRef<HTMLElement>(null), messages = useRef<HTMLDivElement>(null);
  const valid = (id: string, ticket: number) => mounted.current && currentProject.current === id && request.current === ticket;
  // Use the same group as the outer sync panel: its before-copy clean check excludes
  // this operation itself, while application exit still sees the synchronous busy ref.
  useSaveBeforeExit('固定资料同步', () => ({ dirty: false, busy: running.current }));
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement; panel.current?.focus();
    return () => { mounted.current = false; request.current++; running.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { if (busy) panel.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => { if (error || notice || result) messages.current?.scrollIntoView({ block: 'nearest' }); }, [error, notice, result]);
  const verify = (value: MaterialHistoryImportPreview, id: string, expected?: MaterialHistoryImportPreview) => {
    if (value.projectId !== id || (expected && (value.token !== expected.token || value.fingerprint !== expected.fingerprint
      || value.source !== expected.source || value.id !== expected.id || value.archiveId !== expected.archiveId || value.sha256 !== expected.sha256)))
      throw new Error('归档预览的小说或来源版本不匹配，请重新选择ZIP');
  };
  const operate = (action: (id: string, ticket: number) => Promise<void>) => {
    if (running.current) return;
    const id = projectId, ticket = ++request.current; running.current = true; setBusy(true); setError(''); setNotice('');
    void action(id, ticket).catch(e => { if (valid(id, ticket)) setError(errorText(e)); }).finally(() => {
      if (valid(id, ticket)) { running.current = false; setBusy(false); }
    });
  };
  const pick = () => operate(async (id, ticket) => {
    setPreview(null); setSelectedPath(''); setResult(null); consumed.current = false;
    const value = await window.writer.openMaterialHistoryArchive(id);
    if (!valid(id, ticket)) return;
    if (!value) { setNotice('已取消选择，未创建副本。'); return; }
    verify(value, id); setPreview(value);
  });
  const openFile = (path: string) => {
    if (!preview || consumed.current) return;
    const expected = preview; setSelectedPath(path);
    operate(async (id, ticket) => {
      const value = await window.writer.previewMaterialHistoryArchive({ projectId: id, token: expected.token, fingerprint: expected.fingerprint, path });
      if (!valid(id, ticket)) return;
      verify(value, id, expected);
      if (value.detail?.path !== path) throw new Error('文件预览路径不匹配，请重新选择ZIP');
      setPreview(value);
    });
  };
  const confirm = () => {
    if (!preview || blocked || consumed.current || running.current) return;
    const expected = preview;
    operate(async (id, ticket) => {
      await onBeforeCopy(); if (!valid(id, ticket)) return;
      const value = await window.writer.importMaterialHistoryArchive({ projectId: id, token: expected.token, fingerprint: expected.fingerprint });
      if (!valid(id, ticket)) return;
      if (value.projectId !== id || value.source !== expected.source || value.id !== expected.id || value.archiveId !== expected.archiveId || value.sha256 !== expected.sha256)
        throw new Error('导入结果的小说或归档不匹配，未在本页应用');
      consumed.current = true; setResult(value);
    });
  };
  const copyDirectory = () => {
    if (!result) return; const directory = result.directory;
    operate(async (id, ticket) => { await window.writer.copyText(directory); if (valid(id, ticket)) setNotice('导入副本目录已复制'); });
  };
  const close = () => { if (!running.current) onClose(); };
  const file = preview?.files.find(value => value.path === selectedPath);
  return <div className="modal-overlay material-history-import-overlay"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="history-import-title" aria-busy={busy} className="book-modal material-history-panel material-history-import-panel" data-testid="history-import-panel" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="history-import-title">导入历史ZIP为新副本</h2><p>{title}</p></div><button type="button" data-testid="history-import-close" disabled={busy} onClick={close}>关闭</button></header>
    <p className="material-history-help">选择本应用生成的“历史资料.zip”，并保留同目录的“完成清单.json”。先核对本书归属与逐文件哈希，再单独保存归档内容。预览15分钟有效，文件或当前资料变化后需重新选择。当前设定、同步基线和正史状态保持不变。</p>
    <div className="material-history-toolbar"><button type="button" data-testid="history-import-pick" disabled={busy} onClick={pick}>{preview ? '重新选择历史ZIP' : '选择历史ZIP…'}</button><span>{busy ? '正在读取 / 校验…' : 'ZIP最多80 MiB，原文最多64 MiB'}</span></div>
    <div ref={messages}>{error && <div role="alert" className="error" data-testid="history-import-error">{error}<span>当前资料及归档原件均保留；文件或当前资料变化后，请重新选择ZIP。</span></div>}
      {notice && <p role="status" className="material-history-notice">{notice}</p>}
      {result && <section className="material-history-result" role="status" data-testid="history-import-result"><strong>历史ZIP已导入为新副本</strong><p>{result.files} 个文件 · {size(result.bytes)}</p><code>{result.directory}</code><button type="button" data-testid="history-import-copy-directory" disabled={busy} onClick={copyDirectory}>复制导入副本目录</button><p>请核对副本后手动采纳；没有替换本书正式资料。</p></section>}
    </div>
    {preview && <section data-testid="history-import-preview" className="material-history-preview"><h3>{preview.name} · {size(preview.archiveBytes)}</h3><code className="material-history-import-hash">SHA-256 {preview.sha256}</code><p className="material-history-help">归档与当前资料对照 · {preview.files.length} 个路径。“仅当前存在”的文件不会写入导入副本。</p>
      <div className="material-history-files"><ul>{preview.files.map(value => <li key={value.path}><button type="button" data-testid="history-import-file" data-path={value.path} aria-pressed={selectedPath === value.path} disabled={busy || !!result} onClick={() => openFile(value.path)}><span>{value.path}</span><small>{changes[value.change]}</small></button></li>)}</ul></div>
      {file && <div className="material-history-detail"><h3>{file.path}</h3><div className="material-history-sides">{(['current', 'history'] as const).map(side => <ImportSide key={side} side={side} file={file} preview={preview} />)}</div></div>}
    </section>}
    <footer><p>{blocked ? '请先保存各页修改并等待当前操作结束。' : '导入位置：本书“小说资料/资料历史导入”中的独立新目录。'}</p><button type="button" className="primary" data-testid="history-import-confirm" disabled={busy || blocked || !preview || !!result} onClick={confirm}>{result ? '已导入为新副本' : '确认导入为新副本'}</button></footer>
  </section></div>;
}
