import { useEffect, useRef, useState } from 'react';
import type { AIConnectionEdit, AIConnectionSnapshot, DetectionConnectionTest, DetectionUsageSnapshot } from '../../shared/contracts';
import { useSaveBeforeExit } from './save-before-exit';

const initial = (): AIConnectionEdit => ({ name: '腾讯朱雀文本检测', baseUrl: 'https://ai-gateway.edgeone.link', model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: '' });
const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
const count = (value: number) => value.toLocaleString('zh-CN');
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, '');

/** Zhuque detector credentials live with the other model connections so there is one place for every key. */
export function DetectorSettings({ onDirty }: { onDirty: (value: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<AIConnectionSnapshot>({ connections: [], hash: '' });
  const [edit, setEdit] = useState(initial); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [tested, setTested] = useState<DetectionConnectionTest | null>(null); const [usage, setUsage] = useState<DetectionUsageSnapshot | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await window.writer.detectorConnections();
        if (cancelled) return;
        setSnapshot(next); if (next.connections[0]) setEdit({ ...next.connections[0], apiKey: '' });
        const id = next.connections[0]?.id;
        if (id) { const snapshotUsage = await window.writer.detectorUsage(id); if (!cancelled) setUsage(snapshotUsage); }
      } catch (e) { if (!cancelled) setError(errorText(e)); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  const change = (patch: Partial<AIConnectionEdit>) => { setEdit(current => ({ ...current, ...patch })); setDirty(true); setMessage(''); };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const save = async () => {
    const next = await window.writer.saveDetectorConnection(edit, snapshot.hash);
    setSnapshot(next); if (next.connections[0]) setEdit({ ...next.connections[0], apiKey: '' });
    setDirty(false); setMessage('朱雀连接已保存（密钥经系统加密，仅本机可用）');
    const id = next.connections[0]?.id; if (id) setUsage(await window.writer.detectorUsage(id));
  };
  useSaveBeforeExit('朱雀检测连接', () => ({ dirty, busy, save }));
  const connection = snapshot.connections[0];
  return <div><div aria-live="polite">{error && <div className="error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}</div><div className="ai-columns"><aside className="ai-panel ai-form"><h2>朱雀检测连接</h2>
    <p>腾讯 EdgeOne Makers 文本检测的独立连接，与写作模型分开保存；密钥同样经系统加密，只在检测页使用。</p>
    <label>连接名称<input aria-label="朱雀连接名称" disabled={busy} maxLength={100} value={edit.name} onChange={e => change({ name: e.target.value })} /></label>
    <label>朱雀网关地址<input aria-label="朱雀网关地址" disabled={busy} value={edit.baseUrl} onChange={e => change({ baseUrl: e.target.value })} /></label>
    <label>Makers API Key<input aria-label="朱雀 API Key" type="password" autoComplete="off" disabled={busy} value={edit.apiKey ?? ''} placeholder={connection?.hasKey ? '已保存，留空保留' : '填写 EdgeOne Makers API Key'} onChange={e => change({ apiKey: e.target.value })} /></label>
    <label className="ai-check"><input type="checkbox" aria-label="清除已存朱雀密钥" disabled={busy} checked={!!edit.clearKey} onChange={e => change({ clearKey: e.target.checked })} />清除已存检测密钥</label>
    <div className="detection-connection-actions">
      <button className="primary" disabled={busy || !edit.name.trim() || !edit.baseUrl.trim()} onClick={() => void run(save)}>保存朱雀连接</button>
      <button disabled={busy || dirty || !connection?.id || !connection.hasKey} onClick={() => void run(async () => {
        if (!connection) return;
        const result = await window.writer.testDetectorConnection(connection.id);
        setTested(result); setUsage(result.usage); setMessage('朱雀连接测试完成，结果按本机用量记录');
      })}>{busy ? '处理中…' : '测试连接（消耗额度）'}</button>
    </div>
    {dirty && <p className="notice">当前修改尚未保存；保存并退出时会先保存这份连接。</p>}
    {tested && <div className="detection-test-result"><p><b>测试时间</b> {new Date(tested.checkedAt).toLocaleString()}</p>
      <p><b>固定虚构短文</b> 人工 {percentage(tested.humanRatio)} · AI {percentage(tested.aiRatio)} · 疑似 {percentage(tested.suspectedRatio)}</p>
      <p><b>本次扣减</b> {tested.makersTokens === undefined ? '服务未返回，记为未知' : `${count(tested.makersTokens)} Token`}（模型自身用量 {tested.modelTokens === undefined ? '未返回' : count(tested.modelTokens)}）</p>
      {tested.usageWarning && <p className="usage-warning">{tested.usageWarning}</p>}<p className="usage-scope">{tested.endpoint}</p></div>}
    <p className="usage-scope">“测试连接”只发送一句固定虚构短文，不接触你的正文；章节检测请到顶部“朱雀检测”页面。</p>
  </aside><article className="ai-panel ai-form"><h2>本机用量摘要</h2>
    {usage ? <><p>近 24 小时：请求 {count(usage.requests24h)} · 错误 {count(usage.errors24h)} · Makers 扣减 {count(usage.makersTokens24h)} Token</p>
      <p>本月（{usage.month}）：已用估算 {count(usage.estimatedUsed)} / {count(usage.monthlyLimit)} · 剩余约 {count(usage.remainingEstimate)}</p>
      <p className="usage-scope">完整用量、手工校准与批量检测在顶部“朱雀检测”页面；这里是设备本机统计，不是官方余额。</p></> : <p>保存朱雀连接后显示本机用量摘要。</p>}
    <h2>连接状态</h2><p>{connection ? `${connection.name} · ${connection.hasKey ? '密钥已保存（加密）' : '尚未保存密钥'}` : '尚未配置朱雀检测连接'}</p>
    <p className="usage-scope">换地址或更换密钥后，本机用量账本会切到新的凭据指纹，旧账本保留但不再累加。</p>
  </article></div></div>;
}
