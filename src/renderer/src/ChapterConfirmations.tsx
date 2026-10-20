import { useEffect, useRef, useState } from 'react';
import type { Chapter, ChapterConfirmationEntry, ChapterConfirmationPreview, ChapterConfirmationSnapshot } from '../../shared/contracts';
import { useSaveBeforeExit } from './save-before-exit';
import './chapter-confirmations.css';

const PREVIEW_LIMIT = 8000;
const confirmationLabel = '我已核对整个正文版本，确认作为本书故事事实';
type RequestScope = { projectId: string; view: number; request: number };
type Phase = '' | 'metadata' | 'preview' | 'confirm' | 'disable';

function errorText(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, '') || '操作失败，请重新读取确认记录。';
}

function checkSnapshot(snapshot: ChapterConfirmationSnapshot, projectId: string) {
  const entries = snapshot.value.entries;
  if (snapshot.value.schemaVersion !== 1 || snapshot.value.projectId !== projectId
    || entries.some(entry => entry.projectId !== projectId)
    || new Set(entries.map(entry => entry.id)).size !== entries.length
    || snapshot.staleIds.some(id => !entries.some(entry => entry.id === id))) {
    throw new Error('确认记录与本书不一致，请重新读取确认记录。');
  }
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function ChapterConfirmations({ projectId, title, visible, hasUnsaved, onBusy }: {
  projectId: string; title: string; visible: boolean; hasUnsaved: boolean; onBusy: (busy: boolean) => void;
}) {
  const [chapters, setChapters] = useState<Chapter[]>([]), [selectedPath, setSelectedPath] = useState('');
  const [snapshot, setSnapshot] = useState<ChapterConfirmationSnapshot | null>(null);
  const [preview, setPreview] = useState<ChapterConfirmationPreview | null>(null), [checked, setChecked] = useState(false);
  const [pendingCount, setPendingCount] = useState(0), [phase, setPhase] = useState<Phase>('');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(true), pending = useRef(0), requestGeneration = useRef(0);
  const scope = useRef({ projectId, visible, view: 0 }), unsaved = useRef(hasUnsaved);
  unsaved.current = hasUnsaved;
  // Invalidate before effects run so a reply cannot cross a render that changes book or visibility.
  if (scope.current.projectId !== projectId || scope.current.visible !== visible) {
    scope.current = { projectId, visible, view: scope.current.view + 1 };
  }
  const processing = pendingCount > 0;
  useSaveBeforeExit('正文版本确认', () => ({ dirty: false, busy: pending.current > 0 }));
  useEffect(() => { onBusy(processing); return () => onBusy(false); }, [processing, onBusy]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestGeneration.current++; };
  }, []);
  useEffect(() => { if (hasUnsaved) setChecked(false); }, [hasUnsaved]);

  const current = (target: RequestScope) => mounted.current && scope.current.visible
    && scope.current.projectId === target.projectId && scope.current.view === target.view
    && requestGeneration.current === target.request;
  const begin = (nextPhase: Phase): RequestScope => {
    const target = { projectId: scope.current.projectId, view: scope.current.view, request: ++requestGeneration.current };
    pending.current++; setPendingCount(pending.current); setPhase(nextPhase); setError(''); setMessage('');
    return target;
  };
  const finish = (target: RequestScope) => {
    pending.current--;
    if (mounted.current) { setPendingCount(pending.current); if (current(target)) setPhase(''); }
  };
  const clearIntent = () => { setPreview(null); setChecked(false); };
  const load = async () => {
    if (!scope.current.visible) return;
    const target = begin('metadata');
    setSnapshot(null); setChapters([]); setSelectedPath(''); clearIntent();
    try {
      // Wait for both reads even if one rejects; busy protects exit until both IPC calls settle.
      const [chapterResult, snapshotResult] = await Promise.allSettled([
        window.writer.chapters(target.projectId), window.writer.chapterConfirmations(target.projectId)
      ]);
      if (!current(target)) return;
      if (chapterResult.status === 'rejected') throw chapterResult.reason;
      if (snapshotResult.status === 'rejected') throw snapshotResult.reason;
      checkSnapshot(snapshotResult.value, target.projectId);
      if (chapterResult.value.some(chapter => !chapter.path || !chapter.name)
        || new Set(chapterResult.value.map(chapter => chapter.path)).size !== chapterResult.value.length) {
        throw new Error('本书章节目录无效，请重新读取确认记录。');
      }
      setChapters(chapterResult.value); setSnapshot(snapshotResult.value);
    } catch (e) { if (current(target)) setError(errorText(e)); }
    finally { finish(target); }
  };
  useEffect(() => {
    clearIntent(); setError(''); setMessage(''); setPhase(''); setSnapshot(null); setChapters([]); setSelectedPath('');
    if (visible) void load();
    return () => { requestGeneration.current++; };
  }, [projectId, visible]);

  const currentSnapshot = snapshot?.value.projectId === projectId ? snapshot : null;
  const currentPreview = preview?.projectId === projectId && preview.path === selectedPath ? preview : null;
  const readPreview = async () => {
    if (pending.current || !scope.current.visible || !currentSnapshot || !selectedPath || !chapters.some(chapter => chapter.path === selectedPath)) return;
    const path = selectedPath, target = begin('preview'); clearIntent();
    try {
      const next = await window.writer.previewChapterConfirmation(target.projectId, path);
      if (!current(target)) return;
      if (next.projectId !== target.projectId || next.path !== path) throw new Error('正文预览与所选章节不一致，请重新读取待确认版本。');
      setPreview(next);
    } catch (e) { if (current(target)) setError(errorText(e)); }
    finally { finish(target); }
  };
  const confirm = async () => {
    if (pending.current || !scope.current.visible || unsaved.current || !checked || !currentSnapshot || !currentPreview) return;
    const request = { projectId, path: currentPreview.path, sourceHash: currentPreview.hash, expectedHash: currentSnapshot.hash };
    const target = begin('confirm'); setChecked(false);
    try {
      const next = await window.writer.confirmChapterVersion(request);
      if (!current(target)) return;
      checkSnapshot(next, target.projectId);
      const accepted = next.value.entries.find(entry => entry.enabled && entry.sourcePath === request.path && entry.sourceHash === request.sourceHash);
      if (!accepted) {
        throw new Error('返回的确认版本与所选正文不一致，请重新读取确认记录核对。');
      }
      setSnapshot(next); clearIntent();
      setMessage(next.staleIds.includes(accepted.id)
        ? '确认记录已保存，但原件已变化，此版本确认已失效。请重新读取并核对；原稿保留。'
        : '已确认此正文版本作为本书故事事实。原件未修改，不会自动生成 AI 内容或章节摘要。');
    } catch (e) {
      if (current(target)) { setError(errorText(e)); setSnapshot(null); clearIntent(); setMessage('请重新读取确认记录核对状态，再读取待确认版本。'); }
    } finally { finish(target); }
  };
  const disable = async (entry: ChapterConfirmationEntry) => {
    if (pending.current || !scope.current.visible || !currentSnapshot || !entry.enabled || entry.projectId !== projectId) return;
    const expectedHash = currentSnapshot.hash, target = begin('disable'); clearIntent();
    try {
      const next = await window.writer.disableChapterConfirmation(target.projectId, entry.id, expectedHash);
      if (!current(target)) return;
      checkSnapshot(next, target.projectId);
      if (!next.value.entries.some(item => item.id === entry.id && !item.enabled)) throw new Error('返回的停用记录不一致，请重新读取确认记录核对。');
      setSnapshot(next); setMessage('已停用此确认，历史记录保留。需要确认正文时，请重新读取并核对当前版本。');
    } catch (e) {
      if (current(target)) { setError(errorText(e)); setSnapshot(null); setMessage('请重新读取确认记录核对停用状态。'); }
    } finally { finish(target); }
  };
  const staleIds = new Set(currentSnapshot?.staleIds ?? []);
  const previewText = currentPreview?.text.slice(0, PREVIEW_LIMIT) ?? '';
  const truncated = !!currentPreview && currentPreview.text.length > PREVIEW_LIMIT;
  const phaseText = phase === 'metadata' ? '正在读取本书章节与确认记录…' : phase === 'preview' ? '正在读取待确认正文版本…'
    : phase === 'confirm' ? '正在确认正文版本…' : phase === 'disable' ? '正在停用确认…' : '正在等待上一项操作结束…';

  return <section className="confirmation-page ai-page" aria-label="正文版本确认">
    <header className="ai-heading"><div><small>{title}</small><h1>正文版本确认</h1><p>核对已保存的完整正文，明确确认哪一版可以作为本书故事事实。</p></div></header>
    <div className="confirmation-intro"><p>普通保存和 AI 候选另存不会自动确认。确认记录绑定本书、原件路径和内容版本；原件变化后，旧确认失效。</p><p>这里只记录作者确认，不修改 DOCX/TXT 原件，不自动调用模型或生成摘要。</p></div>
    {hasUnsaved && <p className="confirmation-warning">当前正文有未保存修改，磁盘版本可能不是编辑中的草稿。请先回到写作空间保存，再重新读取并核对待确认版本；现在不能确认。</p>}
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status" className="confirmation-message">{message}</p>}
    {processing && <p role="status" className="confirmation-loading">{phaseText}</p>}
    <form className="ai-panel confirmation-form" onSubmit={e => { e.preventDefault(); void confirm(); }}>
      <div className="confirmation-tools"><label>正文章节<select aria-label="确认正文章节" value={selectedPath} disabled={processing || !currentSnapshot} onChange={e => {
        requestGeneration.current++; setSelectedPath(e.target.value); clearIntent(); setError(''); setMessage('');
      }}><option value="">请选择要核对的已保存章节</option>{chapters.map(chapter => <option key={chapter.path} value={chapter.path}>{chapter.name} · {chapter.path}</option>)}</select></label>
        <button type="button" disabled={processing || !currentSnapshot || !selectedPath} onClick={() => void readPreview()}>读取待确认版本</button>
        <button type="button" disabled={processing} onClick={() => void load()}>重新读取确认记录</button>
      </div>
      {currentSnapshot && !chapters.length && <p className="confirmation-note">本书尚无可确认的 DOCX/TXT 章节。</p>}
      {!currentSnapshot && !processing && <p className="confirmation-note">请重新读取本书章节与确认记录后，选择待核对正文。</p>}
      {currentPreview && <article className="confirmation-preview" aria-label="待确认正文预览">
        <h2>待确认正文版本</h2><dl className="confirmation-metadata"><div><dt>原件路径</dt><dd>{currentPreview.path}</dd></div><div><dt>版本 SHA-256</dt><dd className="confirmation-hash">{currentPreview.hash}</dd></div><div><dt>正文统计</dt><dd>{currentPreview.paragraphCount} 非空段落 · {currentPreview.characters} 字符</dd></div></dl>
        {!!currentPreview.warnings.length && <div className="confirmation-warnings"><strong>原件读取说明</strong><ul>{currentPreview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        {truncated ? <p className="confirmation-warning">预览已截断：这里只显示前 {PREVIEW_LIMIT} 个字符。确认针对整个文件，请先阅读全文并核对。</p> : <p className="confirmation-note">确认针对整个文件。请核对完整正文；复杂 Word/WPS 格式还需查看原件与读取说明。</p>}
        <pre aria-label="待确认正文内容">{previewText || '正文没有可显示的文字。'}</pre>
      </article>}
      <label className="confirmation-check"><input type="checkbox" aria-label={confirmationLabel} checked={checked} disabled={processing || !currentPreview || hasUnsaved} onChange={e => setChecked(e.target.checked)} /><span>{confirmationLabel}</span></label>
      <div className="actions"><button type="submit" className="primary" disabled={processing || hasUnsaved || !selectedPath || !currentPreview || !currentSnapshot || !checked}>确认此正文版本</button></div>
    </form>
    <section className="ai-panel confirmation-history" aria-label="本书正文确认历史"><h2>本书正文确认历史</h2><p className="confirmation-note">有效确认参与正式内容检索。停用及原件变化的旧版本保留供核对；更新确认需重新读取正文并勾选核对。</p>
      {currentSnapshot && !currentSnapshot.value.entries.length && <p className="confirmation-note">尚无正文确认记录。</p>}
      {currentSnapshot && <ol className="confirmation-entries">{currentSnapshot.value.entries.map(entry => {
        const stale = staleIds.has(entry.id), status = !entry.enabled ? '已停用' : stale ? '原件变化失效' : '有效确认';
        return <li className="confirmation-entry" data-id={entry.id} key={entry.id}><header><strong>{entry.sourcePath}</strong><span className={`confirmation-state ${!entry.enabled ? 'disabled' : stale ? 'stale' : 'valid'}`}>{status}</span></header>
          <dl className="confirmation-metadata"><div><dt>确认时间</dt><dd>{displayTime(entry.confirmedAt)}</dd></div><div><dt>版本 SHA-256</dt><dd className="confirmation-hash">{entry.sourceHash}</dd></div></dl>
          {entry.enabled && <div className="actions"><button type="button" aria-label={`停用确认 ${entry.id}`} disabled={processing} onClick={() => void disable(entry)}>停用此确认</button></div>}
        </li>;
      })}</ol>}
    </section>
  </section>;
}
