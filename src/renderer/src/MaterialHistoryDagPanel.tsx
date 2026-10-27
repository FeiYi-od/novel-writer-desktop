import { useEffect, useRef, useState } from 'react';
import type { MaterialHistoryDagArchiveResult, MaterialHistoryDagPreview } from '../../shared/material-sync';
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
const digest = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
function verifyPreview(value: MaterialHistoryDagPreview, projectId: string) {
  const count = (number: number, max: number) => Number.isSafeInteger(number) && number >= 0 && number <= max;
  if (!value || value.schemaVersion !== 1 || value.projectId !== projectId || !digest.test(value.fingerprint)
    || !count(value.transportVersions, 1000) || !count(value.localArchives, 1000) || value.transportVersions + value.localArchives < 1
    || !count(value.branches, value.transportVersions) || (value.transportVersions === 0 ? value.branches !== 0 : value.branches === 0)
    || !count(value.files, 10000) || value.files < value.transportVersions || !count(value.blobs, 10000)
    || value.blobs > value.files || !count(value.bytes, 64 * 1024 * 1024))
    throw new Error('完整历史预览的小说、版本或统计不匹配，未在本页应用');
}
function verifyResult(value: MaterialHistoryDagArchiveResult, projectId: string, expected: MaterialHistoryDagPreview) {
  verifyPreview(value, projectId);
  if (value.fingerprint !== expected.fingerprint || value.transportVersions !== expected.transportVersions || value.localArchives !== expected.localArchives
    || value.branches !== expected.branches || value.files !== expected.files || value.blobs !== expected.blobs || value.bytes !== expected.bytes
    || !uuid.test(value.archiveId) || !digest.test(value.sha256) || !Number.isSafeInteger(value.archiveBytes)
    || value.archiveBytes < 22 || value.archiveBytes > 80 * 1024 * 1024 || typeof value.directory !== 'string' || !value.directory || value.directory.length > 4096
    || typeof value.file !== 'string' || value.file.length > 4096 || !/[\\/]完整资料历史\.zip$/u.test(value.file)
    || value.directory.includes('\0') || value.file.includes('\0'))
    throw new Error('完整历史归档结果的小说或来源不匹配，请核对本书归档目录后再操作');
}

/** A complete immutable export, never a history cleanup or a canonical replacement. */
export function MaterialHistoryDagPanel({ projectId, title, blocked, onBeforeCopy, onBusy, onClose }: Props) {
  const [preview, setPreview] = useState<MaterialHistoryDagPreview | null>(null);
  const [result, setResult] = useState<MaterialHistoryDagArchiveResult | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), running = useRef(false), consumed = useRef(false), request = useRef(0);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const panel = useRef<HTMLElement>(null), messages = useRef<HTMLDivElement>(null);
  const valid = (id: string, ticket: number) => mounted.current && currentProject.current === id && request.current === ticket;
  useSaveBeforeExit('固定资料同步', () => ({ dirty: false, busy: running.current }));
  useEffect(() => {
    const previous = document.activeElement; panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => { if (busy) panel.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => { if (error || notice || result) messages.current?.scrollIntoView({ block: 'nearest' }); }, [error, notice, result]);
  const load = async (id: string, ticket: number) => {
    setPreview(null);
    const value = await window.writer.previewMaterialHistoryDag(id);
    if (!valid(id, ticket)) return;
    verifyPreview(value, id); setPreview(value);
  };
  useEffect(() => {
    mounted.current = true; const id = projectId, ticket = ++request.current;
    consumed.current = false; running.current = true; setBusy(true); setPreview(null); setResult(null); setError(''); setNotice('');
    void load(id, ticket).catch(e => { if (valid(id, ticket)) setError(errorText(e)); }).finally(() => {
      if (valid(id, ticket)) { running.current = false; setBusy(false); }
    });
    return () => { mounted.current = false; request.current++; running.current = false; };
  }, [projectId]);
  const operate = (action: (id: string, ticket: number) => Promise<void>) => {
    if (running.current) return;
    const id = projectId, ticket = ++request.current; running.current = true; setBusy(true); setError(''); setNotice('');
    void action(id, ticket).catch(e => { if (valid(id, ticket)) setError(errorText(e)); }).finally(() => {
      if (valid(id, ticket)) { running.current = false; setBusy(false); }
    });
  };
  const refresh = () => { if (!consumed.current) operate(load); };
  const archive = () => {
    if (!preview || blocked || consumed.current || running.current) return;
    const expected = preview;
    operate(async (id, ticket) => {
      await onBeforeCopy(); if (!valid(id, ticket)) return;
      let value: MaterialHistoryDagArchiveResult;
      try { value = await window.writer.archiveMaterialHistoryDag({ projectId: id, fingerprint: expected.fingerprint }); }
      catch (e) { if (valid(id, ticket)) setPreview(null); throw e; }
      if (!valid(id, ticket)) return;
      // A completed response must not be accidentally submitted again, including
      // an invalid DTO whose on-disk outcome needs manual inspection.
      consumed.current = true; verifyResult(value, id, expected); setResult(value);
    });
  };
  const copyPath = () => {
    if (!result) return; const file = result.file;
    operate(async (id, ticket) => { await window.writer.copyText(file); if (valid(id, ticket)) setNotice('完整历史ZIP路径已复制'); });
  };
  const close = () => { if (!running.current) onClose(); };
  return <div className="modal-overlay material-history-dag-overlay"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="history-dag-title" aria-busy={busy} className="book-modal material-history-panel material-history-dag-panel" data-testid="history-dag-panel" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="history-dag-title">完整历史归档</h2><p>{title}</p></div><button type="button" data-testid="history-dag-close" disabled={busy} onClick={close}>关闭</button></header>
    <p className="material-history-help">核对本书全部书内传输版本（包含全部父版本和并行分支）及本机替换前归档，另存为独立ZIP与完成清单。有未完成上传、缺失父版本或损坏内容时停止，不生成不完整的成功归档。</p>
    <div className="material-history-toolbar"><button type="button" data-testid="history-dag-refresh" disabled={busy || consumed.current} onClick={refresh}>重新核对完整历史</button><span>{busy ? '正在读取 / 校验…' : '原始唯一内容最多64 MiB · ZIP最多80 MiB'}</span></div>
    {preview && <section className="material-history-dag-summary" data-testid="history-dag-preview" aria-label="完整历史核对结果">
      <div><strong>{preview.transportVersions.toLocaleString()}</strong><span>书内传输版本</span></div><div><strong>{preview.localArchives.toLocaleString()}</strong><span>本机替换前归档</span></div><div><strong>{preview.branches.toLocaleString()}</strong><span>当前分支</span></div><div><strong>{size(preview.bytes)}</strong><span>去重后的原始内容</span></div>
      <p>相同原字节按哈希去重保存，全部版本的路径、清单和父链关系仍保留。</p>
    </section>}
    <div ref={messages}>{error && <div role="alert" className="error" data-testid="history-dag-error">{error}<span>{consumed.current ? '请核对本书完整历史归档目录；关闭本窗口后再决定是否重新归档。' : '历史及当前资料均保留。完成传输或核对变动后，请重新读取完整历史。'}</span></div>}
      {notice && <p role="status" className="material-history-notice">{notice}</p>}
      {result && <section className="material-history-result" role="status" data-testid="history-dag-result"><strong>完整历史ZIP已完成</strong><p>{result.transportVersions} 份书内版本 · {result.localArchives} 份本机归档 · ZIP {size(result.archiveBytes)}</p><code>{result.file}</code><code>SHA-256 {result.sha256}</code><button type="button" data-testid="history-dag-copy-path" disabled={busy} onClick={copyPath}>复制完整历史ZIP路径</button><p>请连同同目录“完成清单.json”保存。原历史仍全部保留，未清理或释放名额。</p></section>}
    </div>
    <p className="material-history-help">本包只保存历史资料，不额外打包当前正式资料、同步设置或模型连接，也不会替换设定或将草稿确认为正史。分享前请确认历史内容适合分享。请通过“导入完整历史…”校验并恢复为新副本；“导入历史ZIP…”接收单版本的“历史资料.zip”。</p>
    <footer><p>{blocked ? '请先保存各页修改并等待当前操作结束。' : '输出：本书“小说资料/完整历史归档”中的独立新目录。'}</p><button type="button" className="primary" data-testid="history-dag-confirm" disabled={busy || blocked || !preview || consumed.current} onClick={archive}>{result ? '完整历史已归档' : consumed.current ? '请核对归档结果' : '生成完整历史ZIP'}</button></footer>
  </section></div>;
}
