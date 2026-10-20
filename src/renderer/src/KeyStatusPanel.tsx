import { useEffect, useState } from 'react';

type KeyReport = { file: string; backup: string; connections: { id: string; name: string; state: 'ok' | 'missing' | 'unreadable' }[]; backupUsable: boolean };
const label = (state: string) => state === 'ok' ? '密钥可用' : state === 'missing' ? '未填写密钥' : '无法解密，需要重新填写';
/** Shows whether each saved connection's key can still be decrypted on this machine, and can restore
 * the previous connections file if a force-quit left it unreadable. */
export function KeyStatusPanel({ onClose, onRecovered }: { onClose: () => void; onRecovered?: () => void }) {
  const [report, setReport] = useState<KeyReport | null>(null);
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = async () => { setReport(await window.writer.keyStatus()); };
  useEffect(() => { let live = true; void load().catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  return <div className="modal-overlay"><section className="book-modal key-modal" role="dialog" aria-modal="true" aria-label="密钥状态">
    <header><div><h2>密钥状态</h2><p>每次保存都会把上一份连接文件留作备份。这里显示每个连接的密钥能否在本机解密；强制退出或系统凭据变化后会出现「无法解密」。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    {!report && <p>正在读取…</p>}
    {report && <table className="key-table"><thead><tr><th>连接</th><th>密钥状态</th></tr></thead><tbody>
      {report.connections.map(item => <tr key={item.id}><td>{item.name}</td><td>{label(item.state)}</td></tr>)}
    </tbody></table>}
    {report && !report.connections.length && <p>还没有保存任何模型连接。</p>}
    <div className="actions">
      <button data-testid="keys-refresh" disabled={busy} onClick={() => void run(load)}>刷新</button>
      <button data-testid="keys-recover" disabled={busy || !report?.backupUsable} onClick={() => void run(async () => {
        await window.writer.recoverKeys();
        setMessage('已从备份恢复连接文件');
        onRecovered?.();
        await load();
      })}>从备份恢复连接</button>
    </div>
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
