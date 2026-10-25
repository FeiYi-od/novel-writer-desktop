import { useEffect, useRef, useState } from 'react';
import type { MaterialSyncDifference, MaterialSyncSnapshot } from '../../shared/material-sync';
import { useSaveBeforeExit } from './save-before-exit';
import { MaterialHistoryPanel } from './MaterialHistoryPanel';
import './material-sync.css';

interface MaterialSyncPanelProps {
  projectId: string;
  title: string;
  blocked: boolean;
  onClose: () => void;
  onBeforeSync: () => Promise<void>;
  onSynchronized: (snapshot: MaterialSyncSnapshot) => Promise<void>;
  onBusy?: (busy: boolean) => void;
}

const statusNames: Record<MaterialSyncSnapshot['status'], string> = {
  disabled: '未启用', clean: '已核对', pending: '有待同步内容', conflicts: '需要选择版本', blocked: '暂时无法同步'
};
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const date = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString();

function MaterialSide({ file, source, selected, busy, onSelect }: {
  file: MaterialSyncDifference; source: 'local' | 'remote'; selected: boolean; busy: boolean; onSelect: () => void;
}) {
  const hash = source === 'local' ? file.localHash : file.remoteHash;
  const bytes = source === 'local' ? file.localBytes : file.remoteBytes;
  const preview = source === 'local' ? file.localPreview : file.remotePreview;
  const name = source === 'local' ? '本机' : '传输版本';
  return <section className={`material-sync-side${selected ? ' selected' : ''}`} aria-label={`${file.path} ${name}`}>
    <h4>{name}{hash === null ? <span className="material-sync-deleted">缺失 / 已删除</span> : <small>{size(bytes)}</small>}</h4>
    <code className="material-sync-hash">{hash === null ? '此侧没有该文件' : `SHA-256 ${hash}`}</code>
    {preview !== undefined && <details><summary>查看文本预览</summary><pre>{preview || '（空文件）'}</pre></details>}
    {file.action === 'conflict' && <button type="button" data-testid={`material-sync-${source}`} data-path={file.path} aria-pressed={selected} disabled={busy} onClick={onSelect}>
      {selected ? '已选' : '采用'}{name}{hash === null ? '的删除状态' : '内容'}
    </button>}
  </section>;
}

/** The project ID is frozen for every request; a late result cannot update another book. */
export function MaterialSyncPanel({ projectId, title, blocked, onClose, onBeforeSync, onSynchronized, onBusy }: MaterialSyncPanelProps) {
  const [snapshot, setSnapshot] = useState<MaterialSyncSnapshot | null>(null);
  const [selectedRevision, setSelectedRevision] = useState('');
  const [resolutions, setResolutions] = useState<Record<string, 'local' | 'remote'>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const mounted = useRef(false); const request = useRef(0); const running = useRef(false);
  const hasSelections = Object.keys(resolutions).length > 0 || (!!selectedRevision && (snapshot?.remoteRevisions.length ?? 0) > 1);
  const conflicts = snapshot?.files.filter(file => file.action === 'conflict') ?? [];
  const unresolved = conflicts.filter(file => !resolutions[file.path]).length;
  const mustChooseRevision = (snapshot?.remoteRevisions.length ?? 0) > 1 && (!selectedRevision || snapshot?.selectedRemoteRevision !== selectedRevision);
  const valid = (id: string, ticket: number) => mounted.current && currentProject.current === id && request.current === ticket;

  useSaveBeforeExit('固定资料同步', () => ({
    dirty: hasSelections, busy: busy || historyBusy,
    reason: '固定资料同步还有未执行的版本选择，请先同步或关闭面板放弃选择，再保存退出'
  }));
  useEffect(() => { onBusy?.(busy || historyBusy); return () => { onBusy?.(false); }; }, [busy, historyBusy, onBusy]);

  const accept = (result: MaterialSyncSnapshot, id: string, revision?: string) => {
    if (result.projectId !== id) throw new Error('同步结果的小说标识不匹配，未在本页应用');
    setSnapshot(result); setResolutions({});
    setSelectedRevision(revision && result.remoteRevisions.some(item => item.id === revision) ? revision : '');
  };
  const operate = async (action: (id: string) => Promise<MaterialSyncSnapshot>, options: { mutate?: boolean; revision?: string; synchronized?: boolean } = {}) => {
    if (running.current || historyOpen || (options.mutate && blocked)) return;
    const id = projectId; const ticket = ++request.current;
    running.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (options.mutate) await onBeforeSync();
      if (!valid(id, ticket)) return;
      const result = await action(id);
      if (!valid(id, ticket)) return;
      accept(result, id, options.revision);
      if (options.synchronized && result.status === 'clean') {
        setNotice('本机固定资料与书内传输目录已核对。请等待外部同步客户端完成传输，再到另一台设备打开。');
        // Keep the successful snapshot even if refreshing another page fails.
        await onSynchronized(result);
      }
    } catch (e) { if (valid(id, ticket)) setError(errorText(e)); }
    finally { if (valid(id, ticket)) { running.current = false; setBusy(false); } }
  };
  useEffect(() => {
    mounted.current = true;
    const id = projectId; const ticket = ++request.current;
    running.current = true; setBusy(true); setSnapshot(null); setError(''); setNotice(''); setResolutions({}); setSelectedRevision('');
    void window.writer.materialSyncStatus(id).then(result => {
      if (valid(id, ticket)) accept(result, id);
    }).catch(e => { if (valid(id, ticket)) setError(errorText(e)); }).finally(() => {
      if (valid(id, ticket)) { running.current = false; setBusy(false); }
    });
    return () => { mounted.current = false; request.current++; running.current = false; };
  }, [projectId]);

  const discardSelections = () => !hasSelections || window.confirm('放弃尚未执行的同步版本选择？文件不会因此改变。');
  const close = () => { if (!historyOpen && !running.current && discardSelections()) onClose(); };
  const refresh = () => { if (!running.current && discardSelections()) void operate(id => window.writer.materialSyncStatus(id)); };
  const chooseRevision = (revision: string) => {
    if (running.current || !discardSelections()) return;
    void operate(id => window.writer.materialSyncStatus(id, revision || undefined), { revision: revision || undefined });
  };
  const sync = () => {
    if (!snapshot || !snapshot.enabled || mustChooseRevision || unresolved > 0 || snapshot.status === 'blocked') return;
    const fingerprint = snapshot.fingerprint; const revision = selectedRevision || snapshot.selectedRemoteRevision || undefined;
    const choices = conflicts.map(file => ({ path: file.path, source: resolutions[file.path] }));
    void operate(id => window.writer.synchronizeMaterials({ projectId: id, fingerprint, remoteRevision: revision, resolutions: choices }), { mutate: true, synchronized: true });
  };

  return <><div className="modal-overlay" inert={historyOpen} aria-hidden={historyOpen || undefined}><section className="book-modal material-sync-panel" role="dialog" aria-modal="true" aria-labelledby="material-sync-title" data-testid="material-sync-panel" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
  }}>
    <header><div><h2 id="material-sync-title">固定资料同步</h2><p>{title}</p></div><button type="button" aria-label="关闭固定资料同步" data-testid="material-sync-close" disabled={busy} onClick={close}>关闭</button></header>
    <p className="material-sync-intro">人物卡、世界观、文风和已保存资料仍保存在应用的固定“创作资料”目录。启用后，本书目录内的“小说资料/创作资料同步”保存可传输版本，由 NAS 或网盘客户端带到其他设备。未确认筹备草稿保留原有标记，不会自动成为正史。</p>
    <p className="material-sync-help">应用只核对本机与书内目录，无法确认云端传输进度。打开本书和保存退出时会自动核对；两台电脑请轮流写作。密钥、模型连接和本机缓存不在同步范围内。</p>
    {error && <div role="alert" className="error" data-testid="material-sync-error">{error}<span>当前页面与未执行选择已保留；可刷新后重新核对。</span></div>}
    {notice && <p role="status" className="material-sync-notice" data-testid="material-sync-result">{notice}</p>}
    {blocked && <p className="material-sync-warning">请先保存其他页面的修改并等待当前操作完成，再改变同步设置或执行同步。</p>}
    <div className="material-sync-toolbar"><div data-testid="material-sync-status" role="status"><strong>{busy ? '正在核对…' : snapshot ? statusNames[snapshot.status] : '尚未读取'}</strong>{snapshot && <span>{snapshot.enabled ? `本机 ${snapshot.localFiles} 个文件 · 传输版本 ${snapshot.remoteFiles} 个文件` : '启用后核对本机文件'}</span>}</div>
      <div className="actions"><button type="button" data-testid="material-sync-refresh" disabled={busy} onClick={refresh}>刷新核对</button>
        <button type="button" data-testid="material-sync-toggle" disabled={busy || blocked || !snapshot} onClick={() => {
          if (!snapshot || !discardSelections()) return;
          const enabled = !snapshot.enabled;
          void operate(id => window.writer.configureMaterialSync(id, enabled), { mutate: true });
        }}>{snapshot?.enabled ? '停用本机自动核对' : '启用本书资料同步'}</button></div>
    </div>
    {snapshot && <>
      <p className="material-sync-message" data-testid="material-sync-message">{snapshot.message}</p>
      {!snapshot.enabled && <p className="material-sync-help">启用只保存设置。随后点击“立即同步”首次核对文件；停用不会删除书内版本或固定资料。</p>}
      {snapshot.remoteRevisions.length > 1 && <section className="material-sync-branches">
        <h3>发现 {snapshot.remoteRevisions.length} 个并行版本</h3>
        <label>本次采用的传输版本<select aria-label="本次采用的传输版本" data-testid="material-sync-remote-revision" value={selectedRevision} disabled={busy} onChange={event => chooseRevision(event.target.value)}>
          <option value="">请明确选择一个版本</option>{snapshot.remoteRevisions.map(revision => <option key={revision.id} value={revision.id}>{date(revision.createdAt)} · {revision.files} 个文件 · {size(revision.bytes)} · {revision.id}</option>)}
        </select></label>
        <p>所选版本作为本次比较的完整远端内容；其他分支的独有文件不会自动合并，仍保留在历史版本中。选定后再逐项处理下方冲突。</p>
      </section>}
      <div className="material-sync-files" data-testid="material-sync-files">
        {snapshot.files.length > 0 && <h3>文件差异 · {snapshot.files.length} 项{conflicts.length > 0 ? `（${conflicts.length} 项冲突，${unresolved} 项未选择）` : ''}</h3>}
        {snapshot.files.map(file => <article key={file.path} className={`material-sync-file ${file.action}`} data-testid="material-sync-file" data-path={file.path}>
          <header><h3>{file.path}</h3><span>{file.action === 'push' ? '本机 → 传输目录' : file.action === 'pull' ? '传输目录 → 本机' : '双方均有变化'}</span></header>
          <div className="material-sync-sides">{(['local', 'remote'] as const).map(source => <MaterialSide key={source} file={file} source={source} selected={resolutions[file.path] === source} busy={busy || mustChooseRevision || blocked} onSelect={() => { setResolutions(previous => ({ ...previous, [file.path]: source })); setError(''); }} />)}</div>
        </article>)}
        {snapshot.files.length === 0 && !mustChooseRevision && <p className="material-sync-help">{snapshot.enabled ? '当前没有文件内容差异。' : '启用后可核对本书的固定资料。'}</p>}
      </div>
      {snapshot.lastSyncedAt && <p className="material-sync-help">本机上次核对完成：{date(snapshot.lastSyncedAt)}</p>}
    </>}
    <details className="material-sync-history"><summary>历史版本与原稿保护</summary><p>浏览本机替换前归档及全部已完成的书内版本，可比较后恢复为独立副本。当前资料、同步设置和外层尚未执行的选择都会保留。</p>
      {snapshot?.historyDirectory && <p>本机历史目录：<code>{snapshot.historyDirectory}</code></p>}
      <button type="button" data-testid="history-open" disabled={busy || historyOpen} onClick={() => setHistoryOpen(true)}>浏览历史与找回资料</button>
    </details>
    <footer><p>{mustChooseRevision ? '请先选择本次采用的传输版本。' : unresolved > 0 ? `还有 ${unresolved} 项冲突需要明确选择。` : '未执行的选择不会写入任何资料。'}</p><button type="button" className="primary" data-testid="material-sync-run" disabled={busy || blocked || !snapshot?.enabled || mustChooseRevision || unresolved > 0 || snapshot.status === 'blocked'} onClick={sync}>{busy ? '正在处理…' : conflicts.length > 0 ? '按选择合并并同步' : '立即同步'}</button></footer>
  </section></div>{historyOpen && <MaterialHistoryPanel key={projectId} projectId={projectId} title={title} blocked={blocked} onBeforeCopy={onBeforeSync} onBusy={setHistoryBusy} onClose={() => setHistoryOpen(false)} />}</>;
}
