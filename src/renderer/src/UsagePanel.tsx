import { useEffect, useRef, useState } from 'react';
import { formatUsage } from '../../core/usage';

interface UsageRow { connectionId: string; connectionName: string; model: string; prompt: number; completion: number; calls: number; updatedAt: string }
/** Token usage per connection/model, read from the main-process ledger. */
export function UsagePanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { let live = true; void window.writer.readUsage().then(next => { if (live) setRows(next); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, []);
  const total = (rows ?? []).reduce((sum, row) => ({ prompt: sum.prompt + row.prompt, completion: sum.completion + row.completion, calls: sum.calls + row.calls }), { prompt: 0, completion: 0, calls: 0 });
  return <div className="modal-overlay"><section ref={panel} tabIndex={-1} className="book-modal usage-modal" role="dialog" aria-modal="true" aria-label="用量统计" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2>用量统计</h2><p>按连接与模型记录调用次数和 tokens（由供应商在响应里返回；没有返回时只记调用次数）。数据保存在本机用户目录，不随小说移动。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}
    {!rows && <p>正在读取…</p>}
    {rows && <p className="notice" role="status" aria-label="用量合计">{formatUsage(total)}</p>}
    {rows?.length ? <table className="usage-table"><thead><tr><th>连接</th><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>最近</th></tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.connectionId}-${row.model}`}>
        <td>{row.connectionName}</td><td>{row.model}</td><td>{row.calls}</td><td>{row.prompt}</td><td>{row.completion}</td>
        <td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—'}</td>
      </tr>)}</tbody></table> : rows && <p>还没有用量记录。发起一次写作或试写后会开始统计。</p>}
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
