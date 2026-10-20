import { useEffect, useState } from 'react';
import type { Manuscript, RecoveryDraft, RecoveryEntry } from '../../shared/contracts';
import { copyableText } from '../../core/typography';

interface RawDraft { id: string; fileName: string; kind: 'docx' | 'txt'; bytes: number; at: string; sourcePath: string }
export function Recovery({ projectId, blocked, onRestored }: { projectId: string; blocked: boolean; onRestored: (next: Manuscript) => Promise<void> }) {
  const [entries, setEntries] = useState<RecoveryEntry[]>([]); const [draft, setDraft] = useState<RecoveryDraft | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [raw, setRaw] = useState<RawDraft[]>([]); const [rawPreview, setRawPreview] = useState<{ id: string; text: string; warnings: string[] } | null>(null); const [rawNote, setRawNote] = useState(''); const [rawFilter, setRawFilter] = useState('');
  const [versions, setVersions] = useState<RawDraft[]>([]); const [versionPreview, setVersionPreview] = useState<{ id: string; text: string; warnings: string[] } | null>(null);
  const filteredRaw = rawFilter.trim() ? raw.filter(item => item.sourcePath.toLowerCase().includes(rawFilter.trim().toLowerCase())) : raw;
  useEffect(() => { let disposed = false; void window.writer.recoveryDrafts(projectId).then(next => { if (!disposed) setEntries(next); }).catch(e => setError(String(e))); void window.writer.rawRecoveryDrafts(projectId).then(next => { if (!disposed) setRaw(next); }).catch(() => {});
    void window.writer.previousVersions(projectId).then(next => { if (!disposed) setVersions(next); }).catch(() => {}); return () => { disposed = true; }; }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <section className="ai-page"><header className="ai-heading"><div><small>LOCAL DRAFT RECOVERY</small><h1>本书草稿恢复</h1><p>预览本机暂存的正文，恢复时生成新的 DOCX，保留原文件。</p></div><button disabled={busy} onClick={() => void run(async () => { setEntries(await window.writer.recoveryDrafts(projectId)); setRaw(await window.writer.rawRecoveryDrafts(projectId)); })}>刷新恢复草稿</button></header>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="ai-columns"><aside className="ai-panel"><h2>本书最近草稿</h2>{entries.map(entry => <button disabled={busy} key={entry.id} onClick={() => void run(async () => { setDraft(await window.writer.readRecoveryDraft(projectId, entry.id)); })}>{entry.sourcePath}<small>{entry.status === 'pending' ? '未确认写入原文件' : '当时已保存'} · {entry.characters} 字 · {new Date(entry.updatedAt).toLocaleString()}</small></button>)}{!entries.length && <p>尚无可恢复的本机正文暂存。编辑后约 2 秒生成暂存，不包括旧版无来源信息的备份。</p>}
      <h2>保存失败时的自动备份</h2>
      <p>保存被拒（断网、文件被外部改动）时，应用会先把当时的文字存成一份原始副本，这里可以取回。</p>
      {raw.length > 1 && <label>按章节筛选<input aria-label="筛选备份" data-testid="raw-filter" disabled={busy} value={rawFilter} onChange={e => setRawFilter(e.target.value)} placeholder="输入章节名片段" /></label>}
      {filteredRaw.map(item => <button key={item.id} data-testid="raw-draft" disabled={busy} onClick={() => void run(async () => { setRawPreview(await window.writer.readRawRecoveryDraft(projectId, item.id)); setRawNote(''); })}>{item.sourcePath}<small>{Math.round(item.bytes / 1024)} KB · {new Date(item.at).toLocaleString()}</small></button>)}
      {!raw.length && <p>没有保存失败留下的副本。</p>}
      {raw.length > 0 && !filteredRaw.length && <p>没有匹配的备份，换个关键词试试。</p>}
      <h2>历史版本（每次保存前的上一版）</h2>
      <p>应用每次成功保存都会留一份上一版副本，用来回看或取回；不会覆盖当前章节。</p>
      {versions.map(item => <button key={item.id} data-testid="previous-version" disabled={busy} onClick={() => void run(async () => { setVersionPreview(await window.writer.readPreviousVersion(projectId, item.id)); setRawNote(''); })}>{item.sourcePath}<small>{Math.round(item.bytes / 1024)} KB · {new Date(item.at).toLocaleString()}</small></button>)}
      {!versions.length && <p>还没有历史版本（保存过至少一次才会有）。</p>}
      {versions.length > 0 && <div className="actions">
        <button data-testid="version-prune-check" disabled={busy} onClick={() => void run(async () => {
          const check = await window.writer.prunePreviousVersions(projectId, true);
          setRawNote(`历史版本共 ${check.total} 份，可清理 ${check.pruned} 份（最新 50 份始终保留）`);
        })}>检查可清理的历史版本</button>
        <button data-testid="version-prune" disabled={busy} onClick={() => void run(async () => {
          const done = await window.writer.prunePreviousVersions(projectId, false);
          setVersions(await window.writer.previousVersions(projectId));
          setVersionPreview(null);
          setRawNote(`已清理 ${done.pruned} 份历史版本，保留 ${done.kept} 份`);
        })}>清理历史版本</button>
      </div>}
      {raw.length > 0 && <div className="actions">
        <button data-testid="raw-prune-check" disabled={busy} onClick={() => void run(async () => {
          const check = await window.writer.pruneRawRecoveryDrafts(projectId, true);
          setRawNote(`当前 ${check.total} 份备份，可清理 ${check.pruned} 份（最新 20 份始终保留）`);
        })}>检查可清理的旧备份</button>
        <button data-testid="raw-prune" disabled={busy} onClick={() => void run(async () => {
          const done = await window.writer.pruneRawRecoveryDrafts(projectId, false);
          setRaw(await window.writer.rawRecoveryDrafts(projectId));
          setRawPreview(null);
          setRawNote(`已清理 ${done.pruned} 份旧备份，保留 ${done.kept} 份`);
        })}>清理旧备份</button>
      </div>}
      {rawNote && <p role="status" data-testid="raw-prune-note">{rawNote}</p>}
    </aside>
    <article className="ai-panel ai-result">{draft ? <><h2>恢复预览</h2><p>{draft.sourcePath} · {new Date(draft.updatedAt).toLocaleString()}</p><pre aria-label="恢复草稿预览">{copyableText(draft.content)}</pre><button className="primary" disabled={busy || blocked} onClick={() => void run(async () => { const next = await window.writer.restoreDraft(projectId, draft.id); await onRestored(next); })}>恢复为新 DOCX</button>{blocked && <p>请先保存当前正文，或切换到未修改的章节，再恢复。</p>}<details><summary>来源记录</summary><p>项目：{draft.projectId}</p><p>编辑基准哈希：{draft.sourceHash}</p></details></> : <p>从左侧选择一份草稿，核对内容后恢复。</p>}
      {versionPreview && <><h2>历史版本预览</h2><pre aria-label="历史版本预览">{versionPreview.text.replace(/<[^>]+>/gu, '\n').split('\n').filter(Boolean).join('\n')}</pre>
        <button data-testid="version-restore" className="primary" disabled={busy || blocked} onClick={() => void run(async () => {
          const restored = await window.writer.restorePreviousVersion(projectId, versionPreview.id);
          setRawNote(`已把历史版本取回为新章节：${restored.path}`);
          setVersions(await window.writer.previousVersions(projectId));
        })}>取回历史版本为新章节</button></>}
      {rawPreview && <><h2>自动备份预览</h2><pre aria-label="自动备份预览">{rawPreview.text.replace(/<[^>]+>/gu, '\n').split('\n').filter(Boolean).join('\n')}</pre>
        <button data-testid="raw-restore" className="primary" disabled={busy || blocked} onClick={() => void run(async () => {
          const restored = await window.writer.restoreRawRecoveryDraft(projectId, rawPreview.id);
          setRawNote(`已取回为新章节：${restored.path}`);
          setRaw(await window.writer.rawRecoveryDrafts(projectId));
        })}>取回为新章节</button>
        {rawNote && <p role="status" data-testid="raw-note">{rawNote}</p>}
        {rawPreview.warnings.length > 0 && <p className="notice">预览提示：{rawPreview.warnings.slice(0, 2).join('；')}</p>}</>}
    </article></div>
  </section>;
}
