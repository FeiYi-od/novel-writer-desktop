import { useState } from 'react';
import type { AIConnection, StyleTrialView } from '../../shared/contracts';

/** Same brief, several styles, sequential calls; results are compared with plain metrics. */
export function StyleTrialPanel({ projectId, connections, styles, blocked, onClose }: {
  projectId: string; connections: AIConnection[]; styles: { id: string; name: string }[]; blocked: boolean; onClose: () => void;
}) {
  const [connection, setConnection] = useState(connections[0]?.id ?? '');
  const [brief, setBrief] = useState('');
  const [picked, setPicked] = useState<string[]>(styles.slice(0, 2).map(style => style.id));
  const [result, setResult] = useState<StyleTrialView | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await window.writer.compareStyles({ projectId, connectionId: connection, brief, styleIds: picked })); }
    catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { setBusy(false); }
  };
  const label = (id: string | null | undefined) => styles.find(style => style.id === id)?.name ?? id ?? '—';
  return <div className="modal-overlay"><section className="book-modal style-trial-modal" role="dialog" aria-modal="true" aria-label="文风试写比较">
    <header><div><h2>文风试写比较</h2><p>同一段剧情分别用不同文风各写一版，按顺序调用，一版失败不影响其他版本。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}
    <div className="trial-form">
      <label>模型<select aria-label="试写模型" disabled={busy || blocked} value={connection} onChange={e => setConnection(e.target.value)}><option value="">选择模型</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label>
      <label>剧情要求<textarea aria-label="剧情要求" maxLength={4000} disabled={busy || blocked} value={brief} onChange={e => setBrief(e.target.value)} placeholder="例如：林夏在雨夜抵达北门，第一次使用月钥。" /></label>
      <fieldset className="trial-styles"><legend>比较的文风（最多 6 个）</legend>{styles.map(style => <label key={style.id} className="ai-check"><input type="checkbox" aria-label={`试写文风 ${style.name}`} disabled={busy || blocked} checked={picked.includes(style.id)} onChange={e => setPicked(current => e.target.checked ? [...current, style.id] : current.filter(id => id !== style.id))} />{style.name}</label>)}</fieldset>
      <button className="primary" disabled={busy || blocked || !connection || !brief.trim() || !picked.length} onClick={() => void run()}>{busy ? '正在逐版试写…' : '开始比较'}</button>
    </div>
    {result && <div className="trial-result">
      <p className="notice" role="status">完成 {result.variants.length - result.failures}/{result.variants.length} 版；最不同：{label(result.comparison.mostDistinct)}{result.comparison.mostSimilar ? `；最接近：${label(result.comparison.mostSimilar[0])} 与 ${label(result.comparison.mostSimilar[1])}` : ''}</p>
      <table className="trial-table"><thead><tr><th>文风</th><th>字数</th><th>句数</th><th>平均句长</th><th>对白占比</th><th>与他人重合</th></tr></thead>
        <tbody>{result.comparison.rows.map(row => <tr key={row.styleId}><td>{row.styleName}</td><td>{row.chars}</td><td>{row.sentences}</td><td>{row.averageSentence}</td><td>{Math.round(row.dialogueRatio * 100)}%</td><td>{Math.round(row.overlapWithOthers * 100)}%</td></tr>)}</tbody></table>
      <div className="trial-variants">{result.variants.map(variant => <article key={variant.styleId}><h3>{variant.styleName}</h3>{variant.error ? <p className="usage-warning">失败：{variant.error}</p> : <pre>{variant.text}</pre>}</article>)}</div>
    </div>}
    <footer><button disabled={busy} onClick={onClose}>关闭</button></footer>
  </section></div>;
}
