import { useEffect, useRef, useState } from 'react';
import type { MaterialHistoryDagImportPreview, MaterialHistoryDagImportResult } from '../../shared/material-sync';
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

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const digest = /^[a-f0-9]{64}$/u;
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

function verifyPreview(value: MaterialHistoryDagImportPreview, projectId: string, expected?: MaterialHistoryDagImportPreview) {
  const number = (item: number, max: number) => Number.isSafeInteger(item) && item >= 0 && item <= max;
  if (!value || value.schemaVersion !== 1 || value.projectId !== projectId || !uuid.test(value.token) || !uuid.test(value.archiveId)
    || !digest.test(value.fingerprint) || !digest.test(value.sha256) || value.name !== '完整资料历史.zip'
    || !number(value.transportVersions, 1000) || !number(value.localArchives, 1000) || value.transportVersions + value.localArchives < 1
    || !number(value.branches, value.transportVersions) || (value.transportVersions === 0 ? value.branches !== 0 : value.branches === 0)
    || !number(value.files, 10000) || value.files < value.transportVersions || !number(value.blobs, 10000) || value.blobs > value.files
    || !number(value.bytes, 64 * 1024 * 1024) || !number(value.archiveBytes, 80 * 1024 * 1024) || value.archiveBytes < 22
    || !number(value.directories, 10000)) throw new Error('完整历史预览的小说、版本或统计不匹配，请重新选择ZIP');
  if (expected && (value.token !== expected.token || value.archiveId !== expected.archiveId || value.fingerprint !== expected.fingerprint
    || value.sha256 !== expected.sha256 || value.archiveBytes !== expected.archiveBytes || value.name !== expected.name
    || value.transportVersions !== expected.transportVersions || value.localArchives !== expected.localArchives || value.branches !== expected.branches
    || value.files !== expected.files || value.blobs !== expected.blobs || value.bytes !== expected.bytes || value.directories !== expected.directories))
    throw new Error('完整历史预览的来源或统计已变化，请重新选择ZIP');
}

function verifyResult(value: MaterialHistoryDagImportResult, projectId: string, expected: MaterialHistoryDagImportPreview) {
  verifyPreview(value, projectId, expected);
  if (!uuid.test(value.copyId) || typeof value.directory !== 'string' || !value.directory || value.directory.length > 4096 || value.directory.includes('\0'))
    throw new Error('完整历史导入结果不匹配，请核对本书导入目录');
}

/** Main authorizes the source and returns a frozen ticket; the renderer never supplies a path. */
export function MaterialHistoryDagImportPanel({ projectId, title, blocked, onBeforeCopy, onBusy, onClose }: Props) {
  const [preview, setPreview] = useState<MaterialHistoryDagImportPreview | null>(null);
  const [result, setResult] = useState<MaterialHistoryDagImportResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), running = useRef(false), consumed = useRef(false), request = useRef(0);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const panel = useRef<HTMLElement>(null), messages = useRef<HTMLDivElement>(null);
  const valid = (id: string, ticket: number) => mounted.current && currentProject.current === id && request.current === ticket;
  useSaveBeforeExit('固定资料同步', () => ({ dirty: false, busy: running.current }));
  useEffect(() => {
    mounted.current = true; consumed.current = false; setPreview(null); setResult(null); setError(''); setNotice('');
    const previous = document.activeElement; panel.current?.focus();
    return () => { mounted.current = false; request.current++; running.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [projectId]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { if (busy) panel.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => { if (error || notice || result) messages.current?.scrollIntoView({ block: 'nearest' }); }, [error, notice, result]);
  const operate = (action: (id: string, ticket: number) => Promise<void>) => {
    if (running.current) return;
    const id = projectId, ticket = ++request.current; running.current = true; setBusy(true); setError(''); setNotice('');
    void action(id, ticket).catch(e => { if (valid(id, ticket)) setError(errorText(e)); }).finally(() => {
      if (valid(id, ticket)) { running.current = false; setBusy(false); }
    });
  };
  const pick = () => {
    if (consumed.current) return;
    operate(async (id, ticket) => {
      let value: MaterialHistoryDagImportPreview | null;
      try { value = await window.writer.openMaterialHistoryDagArchive(id); }
      catch (e) { if (valid(id, ticket)) setPreview(null); throw e; }
      if (!valid(id, ticket)) return;
      // Cancellation does not invalidate an existing ticket or create any files.
      if (!value) { setNotice('已取消选择，原预览保留。'); return; }
      try { verifyPreview(value, id); } catch (e) { setPreview(null); throw e; }
      setPreview(value); setResult(null);
    });
  };
  const refresh = () => {
    if (!preview || consumed.current) return; const expected = preview;
    operate(async (id, ticket) => {
      try {
        const value = await window.writer.previewMaterialHistoryDagArchive({ projectId: id, token: expected.token, fingerprint: expected.fingerprint });
        if (!valid(id, ticket)) return; verifyPreview(value, id, expected); setPreview(value); setNotice('归档和当前资料已重新核对。');
      } catch (e) { if (valid(id, ticket)) setPreview(null); throw e; }
    });
  };
  const confirm = () => {
    if (!preview || blocked || consumed.current || running.current) return; const expected = preview;
    operate(async (id, ticket) => {
      await onBeforeCopy(); if (!valid(id, ticket)) return;
      let value: MaterialHistoryDagImportResult;
      try { value = await window.writer.importMaterialHistoryDagArchive({ projectId: id, token: expected.token, fingerprint: expected.fingerprint }); }
      catch (e) { if (valid(id, ticket)) setPreview(null); throw e; }
      if (!valid(id, ticket)) return;
      // Even a malformed success response can correspond to a completed copy.
      consumed.current = true; verifyResult(value, id, expected); setResult(value);
    });
  };
  const copyPath = () => {
    if (!result) return; const directory = result.directory;
    operate(async (id, ticket) => { await window.writer.copyText(directory); if (valid(id, ticket)) setNotice('导入副本目录已复制。'); });
  };
  const close = () => { if (!running.current) onClose(); };
  return <div className="modal-overlay material-history-dag-import-overlay"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="history-dag-import-title" aria-busy={busy} className="book-modal material-history-panel material-history-dag-import-panel" data-testid="history-dag-import-panel" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="history-dag-import-title">导入完整历史为新副本</h2><p>{title}</p></div><button type="button" data-testid="history-dag-import-close" disabled={busy} onClick={close}>关闭</button></header>
    <p className="material-history-help">选择本应用生成的“完整资料历史.zip”，并保留同目录“完成清单.json”。应用会核对归属、所有文件和完整父链，再保存为独立副本；单版本“历史资料.zip”请使用“导入历史ZIP…”。</p>
    <div className="material-history-toolbar"><div className="actions"><button type="button" data-testid="history-dag-import-select" disabled={busy || consumed.current} onClick={pick}>选择完整历史ZIP…</button><button type="button" data-testid="history-dag-import-refresh" disabled={busy || consumed.current || !preview} onClick={refresh}>重新核对</button></div><span>{busy ? '正在读取 / 校验…' : 'ZIP最多80 MiB · 去重内容最多64 MiB'}</span></div>
    {preview && <section className="material-history-dag-summary" data-testid="history-dag-import-preview" aria-label="完整历史导入预览">
      <div><strong>{preview.transportVersions.toLocaleString()}</strong><span>书内传输版本</span></div><div><strong>{preview.localArchives.toLocaleString()}</strong><span>本机历史归档</span></div><div><strong>{preview.branches.toLocaleString()}</strong><span>历史分支</span></div><div><strong>{size(preview.bytes)}</strong><span>去重后的原始内容</span></div>
      <p>{preview.files.toLocaleString()} 个文件引用 · {preview.blobs.toLocaleString()} 个唯一对象 · {preview.directories.toLocaleString()} 个目录 · ZIP {size(preview.archiveBytes)}</p><code>SHA-256 {preview.sha256}</code>
    </section>}
    <div ref={messages}>{error && <div role="alert" className="error" data-testid="history-dag-import-error">{error}<span>{consumed.current ? '请核对本书导入目录；关闭本窗口后再决定是否重新导入。' : '源归档和当前资料均保留；请核对导入目录后再重新选择ZIP。'}</span></div>}
      {notice && <p role="status" className="material-history-notice">{notice}</p>}
      {result && <section className="material-history-result" role="status" data-testid="history-dag-import-result"><strong>完整历史已导入为新副本</strong><p>{result.transportVersions} 份书内版本 · {result.localArchives} 份本机归档</p><code>{result.directory}</code><button type="button" data-testid="history-dag-import-copy-path" disabled={busy} onClick={copyPath}>复制副本目录</button><p>请核对副本内容，再决定是否手动采纳。</p></section>}
    </div>
    <p className="material-history-help">当前设定、现有历史和同步基线保持不变；未确认草稿不会自动成为正史。预览票据有效15分钟，来源或本机资料变化后请重新选择。</p>
    <footer><p>{blocked ? '请先保存各页修改并等待当前操作结束。' : '输出：本书“小说资料/完整历史导入”中的独立新目录。'}</p><button type="button" className="primary" data-testid="history-dag-import-confirm" disabled={busy || blocked || !preview || consumed.current} onClick={confirm}>{result ? '已导入为新副本' : consumed.current ? '请核对导入结果' : '确认导入为新副本'}</button></footer>
  </section></div>;
}
