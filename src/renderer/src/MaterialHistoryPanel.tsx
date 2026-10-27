import { useEffect, useRef, useState } from 'react';
import type { MaterialHistoryArchiveResult, MaterialHistoryCapacitySnapshot, MaterialHistoryCopyResult, MaterialHistoryFile, MaterialHistoryPreview, MaterialHistorySnapshot, MaterialHistoryVersion } from '../../shared/material-sync';
import { MaterialHistoryImportPanel } from './MaterialHistoryImportPanel';
import { MaterialHistoryDagPanel } from './MaterialHistoryDagPanel';
import { MaterialHistoryDagImportPanel } from './MaterialHistoryDagImportPanel';
import './material-history.css';

interface MaterialHistoryPanelProps {
  projectId: string;
  title: string;
  blocked: boolean;
  onClose: () => void;
  onBeforeCopy: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const date = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString();
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const key = (version: Pick<MaterialHistoryVersion, 'source' | 'id'>) => `${version.source}:${version.id}`;
const changeNames: Record<MaterialHistoryFile['change'], string> = {
  unchanged: '内容相同', 'history-only': '仅历史中存在', 'current-only': '仅当前存在', changed: '内容不同'
};
const capacityNames = { normal: '名额充足', warning: '接近上限', full: '已达上限', 'over-limit': '已超过上限' };
function verifyCapacity(value: MaterialHistoryCapacitySnapshot, projectId: string) {
  if (!value || value.schemaVersion !== 1 || value.projectId !== projectId || value.limit !== 1000 || value.warningAt !== 800
    || typeof value.checkedAt !== 'string' || Number.isNaN(Date.parse(value.checkedAt))) throw new Error('历史容量的小说、版本或统计参数不匹配，未在本页应用');
  for (const source of ['local', 'transport'] as const) {
    const item = value[source];
    if (!item || !Number.isSafeInteger(item.entries) || item.entries < 0 || item.entries > value.limit + 1 || typeof item.exact !== 'boolean'
      || item.exact !== (item.entries <= value.limit) || item.remaining !== Math.max(0, value.limit - item.entries)
      || item.level !== (item.entries > value.limit ? 'over-limit' : item.entries === value.limit ? 'full' : item.entries >= value.warningAt ? 'warning' : 'normal'))
      throw new Error('历史容量统计不完整或边界不匹配，未在本页应用');
  }
}

function HistorySide({ file, side, preview, loading }: { file: MaterialHistoryFile; side: 'current' | 'history'; preview: MaterialHistoryPreview; loading: boolean }) {
  const hash = side === 'current' ? file.currentHash : file.historyHash;
  const bytes = side === 'current' ? file.currentBytes : file.historyBytes;
  const detail = preview.detail?.path === file.path ? preview.detail : undefined;
  const text = side === 'current' ? detail?.currentText : detail?.historyText;
  const truncated = side === 'current' ? detail?.currentTruncated : detail?.historyTruncated;
  return <section className="material-history-side" aria-label={`${file.path} ${side === 'current' ? '当前资料' : '历史资料'}`}>
    <h4>{side === 'current' ? '当前资料' : '历史资料'}{hash !== null && <small>{size(bytes)}</small>}</h4>
    <code>{hash === null ? '此侧不存在该文件' : `SHA-256 ${hash}`}</code>
    {hash === null ? <p>（不存在）</p> : !detail ? <p>{loading ? '正在读取文件预览…' : '未能读取文件预览，请重新选择文件或刷新版本。'}</p> : text === undefined ? <p>此文件无法作为纯文本预览，可恢复为新副本后使用对应程序查看。</p> : <pre>{text || '（空文件）'}</pre>}
    {truncated && <p className="material-history-truncated">文本仅预览前 16,000 个字符；新副本保留完整原文件。</p>}
  </section>;
}

/** Read-only comparisons and a separate recovery copy; no current material is replaced. */
export function MaterialHistoryPanel({ projectId, title, blocked, onClose, onBeforeCopy, onBusy }: MaterialHistoryPanelProps) {
  const [snapshot, setSnapshot] = useState<MaterialHistorySnapshot | null>(null);
  const [capacity, setCapacity] = useState<MaterialHistoryCapacitySnapshot | null>(null);
  const [capacityError, setCapacityError] = useState('');
  const [selected, setSelected] = useState<MaterialHistoryVersion | null>(null);
  const [preview, setPreview] = useState<MaterialHistoryPreview | null>(null);
  const [path, setPath] = useState('');
  const [result, setResult] = useState<MaterialHistoryCopyResult | null>(null);
  const [archiveResult, setArchiveResult] = useState<MaterialHistoryArchiveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [dagOpen, setDagOpen] = useState(false);
  const [dagBusy, setDagBusy] = useState(false);
  const [dagImportOpen, setDagImportOpen] = useState(false);
  const [dagImportBusy, setDagImportBusy] = useState(false);
  const nestedOpen = importOpen || dagOpen || dagImportOpen;
  const mounted = useRef(false); const currentProject = useRef(projectId); currentProject.current = projectId;
  const request = useRef(0); const running = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const valid = (id: string, ticket: number) => mounted.current && currentProject.current === id && request.current === ticket;
  const verify = (value: { schemaVersion: number; projectId: string; source?: string; id?: string }, id: string, version?: MaterialHistoryVersion) => {
    if (!value || value.schemaVersion !== 1 || value.projectId !== id || (version && (value.source !== version.source || value.id !== version.id)))
      throw new Error('历史结果的小说或版本标识不匹配，未在本页应用');
  };
  const load = async (id: string, ticket: number) => {
    const [historyResult, capacityResult] = await Promise.allSettled([
      window.writer.materialHistory(id), window.writer.materialHistoryCapacity(id)
    ]);
    if (!valid(id, ticket)) return;
    if (historyResult.status === 'fulfilled') {
      try {
        verify(historyResult.value, id); setSnapshot(historyResult.value);
        setSelected(null); setPreview(null); setPath(''); setResult(null); setArchiveResult(null);
      } catch (e) { setError(errorText(e)); }
    } else setError(errorText(historyResult.reason));
    if (capacityResult.status === 'fulfilled') {
      try { verifyCapacity(capacityResult.value, id); setCapacity(capacityResult.value); setCapacityError(''); }
      catch (e) { setCapacity(null); setCapacityError(errorText(e)); }
    } else { setCapacity(null); setCapacityError(errorText(capacityResult.reason)); }
  };
  const operate = async (action: (id: string, ticket: number) => Promise<void>) => {
    if (running.current || nestedOpen) return;
    const id = projectId; const ticket = ++request.current;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(id, ticket); }
    catch (e) { if (valid(id, ticket)) setError(errorText(e)); }
    finally { if (valid(id, ticket)) { running.current = false; setBusy(false); } }
  };
  useEffect(() => { onBusy(busy || importBusy || dagBusy || dagImportBusy); return () => { onBusy(false); }; }, [busy, importBusy, dagBusy, dagImportBusy, onBusy]);
  useEffect(() => {
    const previous = document.activeElement;
    panelRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (error || result || archiveResult || notice) messageRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error, result, archiveResult, notice]);
  useEffect(() => { if (busy) panelRef.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => {
    mounted.current = true;
    const id = projectId; const ticket = ++request.current;
    running.current = true; setBusy(true); setSnapshot(null); setCapacity(null); setCapacityError(''); setSelected(null); setPreview(null); setPath(''); setResult(null); setArchiveResult(null); setError(''); setNotice('');
    void load(id, ticket).catch(e => { if (valid(id, ticket)) setError(errorText(e)); }).finally(() => {
      if (valid(id, ticket)) { running.current = false; setBusy(false); }
    });
    return () => { mounted.current = false; request.current++; running.current = false; };
  }, [projectId]);

  const refresh = () => void operate(async (id, ticket) => {
    setCapacityError(''); await load(id, ticket);
  });
  const open = (version: MaterialHistoryVersion) => {
    if (running.current) return;
    setSelected(version); setPreview(null); setPath(''); setResult(null); setArchiveResult(null);
    void operate(async (id, ticket) => {
      const value = await window.writer.previewMaterialHistory({ projectId: id, source: version.source, id: version.id });
      if (!valid(id, ticket)) return;
      verify(value, id, version); setPreview(value);
    });
  };
  const openFile = (file: MaterialHistoryFile) => {
    if (!selected || !preview || running.current) return;
    const version = selected; const fingerprint = preview.fingerprint;
    setPath(file.path);
    void operate(async (id, ticket) => {
      const value = await window.writer.previewMaterialHistory({ projectId: id, source: version.source, id: version.id, path: file.path, fingerprint });
      if (!valid(id, ticket)) return;
      verify(value, id, version);
      if (value.detail?.path !== file.path) throw new Error('文件预览与所选路径不匹配，请重新打开历史版本');
      setPreview(value);
    });
  };
  const copy = () => {
    if (!selected || !preview || blocked || result || running.current) return;
    const version = selected; const fingerprint = preview.fingerprint;
    void operate(async (id, ticket) => {
      await onBeforeCopy();
      if (!valid(id, ticket)) return;
      const value = await window.writer.copyMaterialHistory({ projectId: id, source: version.source, id: version.id, fingerprint });
      if (!valid(id, ticket)) return;
      verify(value, id, version); setResult(value);
    });
  };
  const copyDirectory = () => {
    if (!result) return;
    const directory = result.directory;
    void operate(async (id, ticket) => {
      await window.writer.copyText(directory);
      if (valid(id, ticket)) setNotice('新副本目录已复制');
    });
  };
  const archive = () => {
    if (!selected || !preview || blocked || archiveResult || running.current) return;
    const version = selected; const fingerprint = preview.fingerprint;
    void operate(async (id, ticket) => {
      await onBeforeCopy(); if (!valid(id, ticket)) return;
      const value = await window.writer.archiveMaterialHistory({ projectId: id, source: version.source, id: version.id, fingerprint });
      if (!valid(id, ticket)) return;
      verify(value, id, version); setArchiveResult(value);
    });
  };
  const copyArchivePath = () => {
    if (!archiveResult) return;
    const file = archiveResult.file;
    void operate(async (id, ticket) => { await window.writer.copyText(file); if (valid(id, ticket)) setNotice('历史ZIP路径已复制'); });
  };
  const selectedFile = preview?.files.find(file => file.path === path);
  const close = () => { if (!running.current && !nestedOpen) onClose(); };

  return <><div className="modal-overlay material-history-overlay" inert={nestedOpen} aria-hidden={nestedOpen || undefined}><section ref={panelRef} tabIndex={-1} className="book-modal material-history-panel" role="dialog" aria-modal="true" aria-labelledby="material-history-title" data-testid="history-panel" aria-busy={busy} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="material-history-title">历史版本与资料找回</h2><p>{title}</p></div><button type="button" data-testid="history-close" aria-label="关闭资料历史" disabled={busy} onClick={close}>关闭</button></header>
    <p className="material-history-help">选择历史版本后可只读对照当前资料。“恢复为新副本”会单独保存所选历史的完整文件，不替换当前设定、不改变同步设置，也不会自动确认为正史。外层尚未执行的同步选择会保留。</p>
    <section className="material-history-capacity" data-testid="history-capacity" aria-label="历史目录容量">
      <header><h3>历史目录容量</h3>{capacity && <span>核对于 {date(capacity.checkedAt)}</span>}</header>
      {capacityError && <p role="alert" data-testid="history-capacity-error">{capacityError}。容量暂未核对；历史列表与原件保留。</p>}
      {capacity ? <div className="material-history-capacity-grid">{(['local', 'transport'] as const).map(source => {
        const item = capacity[source];
        return <section key={source} data-testid={`history-capacity-${source}`} data-level={item.level}>
          <div><strong>{source === 'local' ? '本机替换前归档' : '书内传输目录'}</strong><span>{capacityNames[item.level]}</span></div>
          <p><b>{item.exact ? '' : '至少 '}{item.entries.toLocaleString()}</b> / {capacity.limit.toLocaleString()} 个条目<span>剩余 {item.remaining.toLocaleString()} 个</span></p>
          <progress max={capacity.limit} value={Math.min(item.entries, capacity.limit)} aria-label={`${source === 'local' ? '本机归档' : '书内传输'}条目占用`} />
        </section>;
      })}</div> : !capacityError && <p>{busy ? '正在读取目录容量…' : '容量尚未核对'}</p>}
      <p className="material-history-help">统计目录条目，包含尚未完成的传输目录；不等于已核验版本数或磁盘占用。每侧上限1,000个，达到800个时提醒。打包ZIP不会释放名额；请保留完整历史及父版本，勿删除目录绕过上限。刷新历史列表可重新核对。</p>
    </section>
    <div ref={messageRef}>{error && <div role="alert" className="error" data-testid="history-error">{error}<span>当前资料和历史原件均保留。版本发生变化时，请刷新列表并重新打开后再恢复。</span></div>}
    {notice && <p role="status" className="material-history-notice">{notice}</p>}
    {result && <section className="material-history-result" data-testid="history-result" role="status"><strong>已恢复为新副本</strong><p>{result.files} 个文件 · {size(result.bytes)}</p><code>{result.directory}</code><button type="button" data-testid="history-copy-directory" disabled={busy} onClick={copyDirectory}>复制新副本目录</button><p>当前设定未变。请核对副本内容，再决定是否手动采纳。</p></section>}
    {archiveResult && <section className="material-history-result" data-testid="history-archive-result" role="status"><strong>历史ZIP已完成</strong><p>{archiveResult.files} 个文件 · 原始 {size(archiveResult.bytes)} · ZIP {size(archiveResult.archiveBytes)}</p><code>{archiveResult.file}</code><code>SHA-256 {archiveResult.sha256}</code><button type="button" data-testid="history-archive-path" disabled={busy} onClick={copyArchivePath}>复制历史ZIP路径</button><p>ZIP与完成清单位于本书“小说资料/资料历史归档”。旧历史继续保留；本次归档不会删除父版本或解除历史数量上限。</p></section>}</div>
    <div className="material-history-toolbar"><span>{busy ? '正在读取 / 核对…' : snapshot ? `共 ${snapshot.versions.length} 个历史版本` : '尚未读取'}</span><div className="actions"><button type="button" data-testid="history-dag-open" disabled={busy || nestedOpen} onClick={() => setDagOpen(true)}>完整历史归档…</button><button type="button" data-testid="history-dag-import-open" disabled={busy || nestedOpen} onClick={() => setDagImportOpen(true)}>导入完整历史…</button><button type="button" data-testid="history-import-open" disabled={busy || nestedOpen} onClick={() => setImportOpen(true)}>导入历史ZIP…</button><button type="button" data-testid="history-refresh" disabled={busy} onClick={refresh}>刷新历史列表</button></div></div>
    <div className="material-history-content"><aside className="material-history-versions" aria-label="资料历史版本"><h3>历史版本</h3>
      <p className="material-history-help">本机归档显示目录记录时间；书内版本显示快照创建时间。列表未核验内容，打开后才校验文件与归属。</p>
      <ul>{snapshot?.versions.map(version => <li key={key(version)}><button type="button" data-testid="history-version" data-source={version.source} data-id={version.id} aria-pressed={selected ? key(selected) === key(version) : false} disabled={busy} onClick={() => open(version)}>
        <strong>{version.source === 'local' ? '本机替换前归档' : '书内传输版本'}</strong><span>{date(version.createdAt)}{version.source === 'local' ? '（目录记录）' : ''}</span><span>{version.files === null ? '文件数量待打开核验' : `${version.files} 个文件`}{version.bytes === null ? ' · 大小待核验' : ` · ${size(version.bytes)}`}</span><code>{version.id}</code>
      </button></li>)}</ul>
      {snapshot?.versions.length === 0 && <p className="material-history-help" data-testid="history-empty">暂无可浏览历史。同步替换前归档及书内完整版本会在这里列出。</p>}
    </aside><section className="material-history-preview" aria-label="历史资料差异">
      {!selected && <p className="material-history-help">从左侧选择一个历史版本。停用同步后仍可查看已经保留的历史。</p>}
      {selected && !preview && !busy && <p className="material-history-help">该版本尚未成功打开，可重新选择以校验。</p>}
      {preview && <><h3>与当前资料对照 · {preview.files.length} 个路径</h3><div className="material-history-files" aria-label="历史版本文件"><ul>{preview.files.map(file => <li key={file.path}><button type="button" data-testid="history-file" data-path={file.path} aria-pressed={path === file.path} disabled={busy} onClick={() => openFile(file)}><span>{file.path}</span><small>{changeNames[file.change]}</small></button></li>)}</ul></div>
        {preview.files.length === 0 && <p className="material-history-help">当前资料与历史版本均没有文件。</p>}
        {preview.files.length > 0 && !selectedFile && <p className="material-history-help">选择文件查看双栏纯文本。历史副本不包含“仅当前存在”的文件。</p>}
        {selectedFile && <div className="material-history-detail"><h3>{selectedFile.path}</h3><div className="material-history-sides">{(['current', 'history'] as const).map(side => <HistorySide key={side} side={side} file={selectedFile} preview={preview} loading={busy} />)}</div></div>}
      </>}
    </section></div>
    <footer><p>{blocked ? '请先保存各页修改并等待当前操作结束，再生成副本或ZIP。' : '恢复为独立目录或压缩ZIP；当前资料及历史原件保持不变。'}</p><div className="actions"><button type="button" data-testid="history-archive" disabled={busy || blocked || !preview || !!archiveResult} onClick={archive}>{archiveResult ? 'ZIP已完成' : '打包历史ZIP'}</button><button type="button" className="primary" data-testid="history-copy" disabled={busy || blocked || !preview || !!result} onClick={copy}>{result ? '已恢复为新副本' : busy ? '正在处理…' : '恢复为新副本'}</button></div></footer>
  </section></div>{importOpen && <MaterialHistoryImportPanel key={projectId} projectId={projectId} title={title} blocked={blocked} onBeforeCopy={onBeforeCopy} onBusy={setImportBusy} onClose={() => setImportOpen(false)} />}{dagOpen && <MaterialHistoryDagPanel key={projectId} projectId={projectId} title={title} blocked={blocked} onBeforeCopy={onBeforeCopy} onBusy={setDagBusy} onClose={() => setDagOpen(false)} />}{dagImportOpen && <MaterialHistoryDagImportPanel key={projectId} projectId={projectId} title={title} blocked={blocked} onBeforeCopy={onBeforeCopy} onBusy={setDagImportBusy} onClose={() => setDagImportOpen(false)} />}</>;
}
