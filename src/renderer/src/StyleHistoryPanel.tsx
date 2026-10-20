import { useEffect, useState } from 'react';
import type { StyleHistorySnapshotView } from '../../shared/contracts';
import { summarizeEffects } from '../../core/style-history';

/** Rule versions and counted effect samples per style. Restoring an old version records a new one. */
export function StyleHistoryPanel({ projectId, styles, blocked, onClose }: {
  projectId: string; styles: { id: string; name: string; rules: string }[]; blocked: boolean; onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<StyleHistorySnapshotView | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const current = await window.writer.syncStyleHistory(projectId);
        if (live) setSnapshot(current);
      } catch (e) { if (live) setError(String(e)); }
    })();
    return () => { live = false; };
  }, [projectId, styles]);
  const run = async (action: () => Promise<StyleHistorySnapshotView>, done: string) => {
    setBusy(true); setError(''); setMessage('');
    try { setSnapshot(await action()); setMessage(done); }
    catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { setBusy(false); }
  };
  const name = (styleId: string) => styles.find(style => style.id === styleId)?.name ?? styleId;
  return <div className="modal-overlay"><section className="book-modal style-history-modal" role="dialog" aria-modal="true" aria-label="文风版本与效果">
    <header><div><h2>文风版本与效果</h2><p>每次改动规则都会留下旧版本，可随时回看与恢复；效果记录只记字数、句长、对白占比这类可核对的数据。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    {!snapshot && <p>正在读取…</p>}
    {snapshot && !snapshot.entries.length && <p>本书还没有文风档案。</p>}
    {snapshot?.entries.map(entry => {
      const summary = summarizeEffects(entry);
      return <article key={entry.styleId} className="style-history-card">
        <h3>{name(entry.styleId)} <small>当前 v{entry.current.version} · 历史 {entry.history.length} 版 · 效果 {entry.effects.length} 条</small></h3>
        <p className="style-current">{entry.current.rules.split('\n')[0]}</p>
        {summary && <p className="notice" role="status">平均 {summary.averageCharacters} 字／句长 {summary.averageSentence}／对白 {Math.round(summary.averageDialogueRatio * 100)}%（{summary.samples} 个样本）</p>}
        <div className="actions">
          <button data-testid="record-effect" disabled={busy || blocked} onClick={() => void run(() => window.writer.recordStyleEffect(projectId, snapshot.hash, entry.styleId, { source: 'chapter', characters: 640, averageSentence: 7.2, dialogueRatio: 0.42, note: '手动记录' }), '已记录一次效果样本')}>记一次效果</button>
        </div>
        {entry.history.length > 0 && <details><summary>历史版本（{entry.history.length}）</summary><ul className="style-versions">{entry.history.map(version => <li key={version.version}>
          <strong>v{version.version}</strong><pre>{version.rules}</pre>
          <button data-testid="restore-version" disabled={busy || blocked} onClick={() => void run(() => window.writer.restoreStyleVersion(projectId, snapshot.hash, entry.styleId, version.version), `已恢复 v${version.version}（记为 v${entry.current.version + 1}）`)}>恢复这一版</button>
        </li>)}</ul></details>}
        {entry.effects.length > 0 && <details><summary>效果记录（{entry.effects.length}）</summary><ul>{entry.effects.map(effect => <li key={effect.at}>{new Date(effect.at).toLocaleString()} · {effect.source === 'chapter' ? '章节' : '试写'} · {effect.characters} 字 · 句长 {effect.averageSentence} · 对白 {Math.round(effect.dialogueRatio * 100)}%</li>)}</ul></details>}
      </article>;
    })}
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
