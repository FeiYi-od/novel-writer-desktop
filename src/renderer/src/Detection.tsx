import { useEffect, useRef, useState } from 'react';
import type { AIConnectionEdit, AIConnectionSnapshot, Chapter, DetectionBatchState, DetectionConnectionTest, DetectionReport, DetectionUsageSnapshot, Manuscript } from '../../shared/contracts';
const initial = (): AIConnectionEdit => ({ name: '腾讯朱雀文本检测', baseUrl: 'https://ai-gateway.edgeone.link', model: 'zhuque-text', adapter: 'generic', thinking: 'default', contextWindow: 32768, maxOutputTokens: 4096, tokenParameter: 'max_tokens', timeoutSeconds: 60, apiKey: '' });
const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
const count = (value: number) => value.toLocaleString('zh-CN');
const usedPercentage = (usage: DetectionUsageSnapshot) => usage.monthlyLimit > 0 ? Math.min(100, usage.estimatedUsed / usage.monthlyLimit * 100) : 0;
export function Detection({ projectId, manuscript, blocked, visible = true, onDirty, onOpenSettings }: { projectId: string; manuscript: Manuscript | null; blocked: boolean; visible?: boolean; onDirty: (dirty: boolean) => void; onOpenSettings?: () => void }) {
  const [settings, setSettings] = useState<AIConnectionSnapshot>({ connections: [], hash: '' }); const [edit, setEdit] = useState(initial); const [dirty, setDirty] = useState(false);
  const [reports, setReports] = useState<DetectionReport[]>([]); const [selected, setSelected] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [usage, setUsage] = useState<DetectionUsageSnapshot | null>(null); const [tested, setTested] = useState<DetectionConnectionTest | null>(null);
  const [quotaLimit, setQuotaLimit] = useState(''); const [quotaUsed, setQuotaUsed] = useState('');
  const [chapters, setChapters] = useState<Chapter[]>([]); const [picked, setPicked] = useState<string[]>([]); const [batch, setBatch] = useState<DetectionBatchState | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const [config, history, files] = await Promise.all([window.writer.detectorConnections(), window.writer.detectionReports(projectId), window.writer.chapters(projectId)]);
        if (cancelled) return;
        setSettings(config); if (config.connections[0]) setEdit({ ...config.connections[0], apiKey: '' }); setReports(history); setChapters(files);
        const connectionId = config.connections[0]?.id;
        if (connectionId) { const next = await window.writer.detectorUsage(connectionId); if (!cancelled) { setUsage(next); setQuotaLimit(String(next.monthlyLimit)); } }
        const running = await window.writer.detectionBatch(projectId);
        if (!cancelled && running) { setBatch(running); if (running.running && connectionId) startPolling(connectionId); }
      } catch (e) { if (!cancelled) setError(String(e)); }
    })();
    return () => { cancelled = true; stopPolling(); };
  }, [projectId, visible]);
  useEffect(() => { onDirty(dirty || busy || !!batch?.running); return () => onDirty(false); }, [dirty, busy, batch?.running, onDirty]);
  const change = (patch: Partial<AIConnectionEdit>) => { setEdit(current => ({ ...current, ...patch })); setDirty(true); };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const refreshUsage = async (connectionId: string) => { const next = await window.writer.detectorUsage(connectionId); if (alive.current) { setUsage(next); setQuotaLimit(String(next.monthlyLimit)); } return next; };
  const stopPolling = () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
  const startPolling = (connectionId: string) => {
    stopPolling();
    poll.current = setInterval(() => { void (async () => {
      try {
        const next = await window.writer.detectionBatch(projectId);
        if (!alive.current) { stopPolling(); return; }
        if (!next) return;
        setBatch(next);
        if (!next.running) {
          stopPolling(); setReports(await window.writer.detectionReports(projectId)); await refreshUsage(connectionId).catch(() => {});
          setMessage(next.stopped ? `批量检测已停止：成功 ${next.created}/${next.total}，失败 ${next.failures.length}` : next.failures.length ? `批量检测完成：成功 ${next.created}/${next.total}，失败 ${next.failures.length}` : `批量检测完成：${next.created} 章已生成新报告`);
        }
      } catch (e) { stopPolling(); if (alive.current) setError(String(e)); }
    })(); }, 800);
  };
  const startBatch = () => {
    setError(''); setMessage('');
    void (async () => {
      try {
        if (!edit.id) throw new Error('请先保存朱雀连接');
        const items = chapters.filter(chapter => picked.includes(chapter.path)).map(chapter => ({ path: chapter.path }));
        if (!items.length) throw new Error('请至少勾选一个章节');
        if (items.length > 50) throw new Error('一次最多批量检测 50 个章节，请分批进行');
        const running = window.writer.detectBatch(projectId, { connectionId: edit.id, items });
        startPolling(edit.id);
        const finished = await running;
        if (alive.current) setBatch(finished);
      } catch (e) { stopPolling(); if (alive.current) setError(String(e)); }
    })();
  };
  const cancelBatch = () => run(async () => { await window.writer.cancelDetectionBatch(projectId); setMessage('已请求停止批量检测，当前章节结束后不再开始新章节'); });
  const saveQuota = (accountUsed: number | null | undefined) => run(async () => {
    if (!usage || !edit.id) throw new Error('请先保存朱雀连接并读取用量');
    const limit = Number(quotaLimit);
    if (!Number.isInteger(limit) || limit < 0) throw new Error('月度赠送额度必须是不小于 0 的整数');
    let used = accountUsed;
    if (used === undefined) { const parsed = Number(quotaUsed); if (!Number.isInteger(parsed) || parsed < 0) throw new Error('账户已用 Token 必须是不小于 0 的整数'); used = parsed; }
    const next = await window.writer.saveDetectorQuota({ connectionId: edit.id, credentialFingerprint: usage.credentialFingerprint, expectedHash: usage.hash, month: usage.month, monthlyLimit: limit, ...(used === undefined ? {} : { accountUsed: used }) });
    if (alive.current) { setUsage(next); setQuotaLimit(String(next.monthlyLimit)); setQuotaUsed(''); setDirty(false); }
    setMessage(used === null ? '已清除账户校准，只保留本机统计' : '已按控制台数据校准账户已用，此后按本机扣减累加');
  });
  const report = reports.find(r => r.id === selected) ?? reports[0];
  const level = usage?.usageLevel ?? 'normal';
  return <section className="ai-page"><header className="ai-heading"><div><small>TENCENT ZHUQUE</small><h1>朱雀 AI 文本检测</h1><p>检测已保存章节，结果按小说与正文版本保留。</p></div></header>{error && <div className="error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    {usage && <section className="usage-overview" aria-label="朱雀用量概览">
      <div className="usage-overview-header"><div><h2>本机朱雀用量</h2><p>设备本机统计，不是腾讯官方余额。同一账户在其他连接或其他电脑上的消耗不会自动合并，可手工校准。</p></div><button disabled={busy} onClick={() => void run(async () => { await refreshUsage(edit.id!); setMessage('已重新读取本机用量记录'); })}>刷新用量</button></div>
      <div className="usage-stats">
        <div className="usage-stat"><span className="usage-stat-label">近 24 小时请求</span><strong>{count(usage.requests24h)}</strong><small>含章节检测与显式连接测试</small></div>
        <div className="usage-stat usage-stat-error"><span className="usage-stat-icon" aria-hidden="true">!</span><span className="usage-stat-label">近 24 小时错误</span><strong>{count(usage.errors24h)}</strong><small>认证、限流、超时与格式失败都计入</small></div>
        <div className="usage-stat usage-stat-token"><span className="usage-stat-icon" aria-hidden="true">◔</span><span className="usage-stat-label">近 24 小时 Makers 扣减</span><strong>{count(usage.makersTokens24h)}</strong><small>{usage.unknownUsage24h > 0 ? `${usage.unknownUsage24h} 次未返回扣减，按未知记录` : '模型自身用量不计入赠送额度'}</small></div>
      </div>
      <div className={`usage-quota ${level === 'normal' ? '' : level === 'near-limit' ? 'warning' : 'exhausted'}`}>
        <div className="usage-quota-heading"><div><h3>{usage.month} 月度额度（北京时间）</h3><p>本机记录 {count(usage.totalEvents)} 次请求；官方控制台数据与本机估算可能不一致。</p></div><div className="usage-quota-total"><strong>{usedPercentage(usage).toFixed(2)}%</strong>已用估算</div></div>
        <progress aria-label="朱雀月度额度使用估算" max={Math.max(1, usage.monthlyLimit)} value={Math.min(usage.estimatedUsed, Math.max(1, usage.monthlyLimit))} />
        <div className="usage-progress-heading"><span>已用 <strong>{count(usage.estimatedUsed)}</strong> / {count(usage.monthlyLimit)} Token</span><span>剩余约 {count(usage.remainingEstimate)} Token</span></div>
        <div className="usage-quota-details"><span>本机累计<b>{count(usage.localTokens)}</b></span><span>账户已用（校准）<b>{usage.accountUsed === null ? '未校准' : count(usage.accountUsed)}</b></span><span>校准时间<b>{usage.calibratedAt ? new Date(usage.calibratedAt).toLocaleString() : '未校准'}</b></span><span>本月未知扣减<b>{usage.unknownUsageMonth} 次</b></span></div>
        {level !== 'normal' && <p className={`usage-warning ${level === 'exceeded' ? 'exhausted' : ''}`}>{level === 'exceeded' ? '本机估算已达到月度额度。这是本机估算，不是官方封禁；请到 Makers 控制台核对后再决定是否继续检测。' : '本机估算已使用八成以上额度。官方余额请以 Makers 控制台为准。'}</p>}
        {usage.unknownUsageMonth > 0 && <p className="usage-warning">本月有 {usage.unknownUsageMonth} 次请求未返回扣减用量，真实消耗可能高于本机估算。</p>}
        <details className="usage-quota-settings"><summary>手工校准账户已用与月度额度</summary>
          <form className="usage-quota-form" onSubmit={event => { event.preventDefault(); void saveQuota(undefined); }}>
            <div className="ai-fields"><label>月度赠送额度（Token）<input aria-label="朱雀月度额度" disabled={busy} inputMode="numeric" value={quotaLimit} onChange={e => { setQuotaLimit(e.target.value); setDirty(true); }} /></label>
              <label>控制台显示的账户已用（Token）<input aria-label="朱雀账户已用" disabled={busy} inputMode="numeric" value={quotaUsed} placeholder="留空表示不重新校准" onChange={e => { setQuotaUsed(e.target.value); setDirty(true); }} /></label></div>
            <small>校准后按“账户已用 + 之后本机已知扣减”估算；只改额度不会改动既有校准基准。官方重置额度所在时区未确认，跨月后校准失效。</small>
            <div className="detection-connection-actions"><button className="primary" disabled={busy} type="submit">保存额度与校准</button><button disabled={busy || usage.accountUsed === null} type="button" onClick={() => void saveQuota(null)}>清除账户校准</button></div>
          </form>
        </details>
        <p className="usage-scope">官方未提供公开余额查询接口，本应用不显示“实时余额”，也不因本机估算自动封禁请求。</p>
      </div>
    </section>}
    <div className="ai-columns"><aside className="ai-panel ai-form"><h2>检测连接</h2>
      <p>朱雀密钥与网关地址已统一到顶部“模型设置 → 朱雀检测”，那里可以保存、更换、清除密钥并做连接测试。</p>
      <p className="usage-scope">当前连接：{settings.connections[0] ? `${settings.connections[0].name} · ${settings.connections[0].hasKey ? '密钥已保存' : '缺少密钥'}` : '尚未配置'}</p>
      <div className="detection-connection-actions"><button disabled={busy} onClick={() => onOpenSettings?.()}>打开模型设置里的朱雀配置</button></div>
      <p>使用腾讯官方 EdgeOne Makers 文本检测接口。请求可能消耗额度。</p><hr /><p>本次发送：{manuscript?.path ?? '请先打开一个章节'}。仅发送该章节已保存的纯文本，不附加角色或世界观。</p>
      <button className="primary" disabled={busy || dirty || blocked || !edit.id || !manuscript?.managed} onClick={() => void run(async () => { if (!manuscript || !edit.id) return; const connectionId = edit.id; try { const next = await window.writer.detectText(projectId, manuscript.path, manuscript.hash, connectionId); setReports(current => [next, ...current]); setSelected(next.id); setMessage('朱雀检测完成'); } finally { await refreshUsage(connectionId).catch(() => {}); } })}>{busy ? '处理中…' : '发送章节并检测 AI 率'}</button>
      {blocked && <p className="notice">正文或资料尚未保存，请先保存后检测。</p>}
      <details className="detection-batch" onToggle={event => { if ((event.target as HTMLDetailsElement).open) { void window.writer.chapters(projectId).then(files => { if (alive.current) setChapters(files); }).catch(() => {}); } }}><summary>批量检测（按顺序逐章，逐章计费）</summary>
        <div className="detection-batch-actions"><button type="button" disabled={busy || !!batch?.running} onClick={() => { setPicked(chapters.slice(0, 50).map(chapter => chapter.path)); setMessage(chapters.length > 50 ? '已勾选前 50 章，单次上限 50 章' : ''); }}>全选</button><button type="button" disabled={busy || !!batch?.running} onClick={() => setPicked([])}>清空</button><span>已选 {picked.length} / {chapters.length} 章</span></div>
        <div className="detection-batch-list">{chapters.map(chapter => <label key={chapter.path}><input type="checkbox" disabled={busy || !!batch?.running} checked={picked.includes(chapter.path)} onChange={e => setPicked(current => e.target.checked ? [...current, chapter.path] : current.filter(path => path !== chapter.path))} />{chapter.name}</label>)}{chapters.length === 0 && <p className="usage-scope">本书还没有已保存章节。</p>}</div>
        <div className="detection-connection-actions"><button className="primary" type="button" disabled={busy || !edit.id || picked.length === 0 || !!batch?.running} onClick={startBatch}>批量检测所选章节</button><button type="button" disabled={!batch?.running} onClick={cancelBatch}>停止批量检测</button></div>
        {batch && <div className="detection-batch-progress"><p>进度 {batch.completed}/{batch.total} · 成功 {batch.created} · 失败 {batch.failures.length}{batch.stopped ? ' · 已停止' : batch.running ? ' · 进行中' : ' · 已结束'}</p>{batch.running && batch.current && <p className="usage-scope">正在检测：{batch.current}</p>}{batch.failures.slice(0, 5).map(failure => <p key={failure.path} className="usage-warning">{failure.path}：{failure.message}</p>)}</div>}
        <p className="usage-scope">批量检测逐章发送，每章一次计费请求；启动前先核对全部章节版本，运行中可停止，已生成的报告保留。不自动重试失败章节。</p>
      </details>
      <p>检测不修改正文。报告仅提示文本特征，可能误判；占比与置信度含义不同。</p>
    </aside><article className="ai-panel ai-result"><h2>本书检测报告</h2>{report ? <><select aria-label="朱雀检测历史" value={report.id} onChange={e => setSelected(e.target.value)}>{reports.map(r => <option key={r.id} value={r.id}>{r.chapterPath} · {new Date(r.createdAt).toLocaleString()}</option>)}</select>
      {(report.chapterPath !== manuscript?.path || report.sourceHash !== manuscript?.hash || blocked) && <p className="notice">此报告对应旧版本或其他章节；当前正文需重新检测。</p>}
      <div className="detection-metrics"><div><strong>{percentage(report.aiRatio)}</strong>AI 内容占比</div><div><strong>{percentage(report.suspectedRatio)}</strong>疑似 AI 占比</div><div><strong>{percentage(report.humanRatio)}</strong>人工内容占比</div></div>
      <p>整体置信度：{report.confidence === undefined ? '服务未提供' : percentage(report.confidence)}</p>
      {(report.makersTokens !== undefined || report.modelTokens !== undefined || report.usageWarning) && <div className="detection-report-usage"><h3>本次检测用量</h3><p>Makers 实际扣减：<b>{report.makersTokens === undefined ? '未知' : `${count(report.makersTokens)} Token`}</b></p><p>模型自身用量：<b>{report.modelTokens === undefined ? '服务未返回' : `${count(report.modelTokens)} Token`}</b></p>{report.usageWarning && <p className="usage-warning">{report.usageWarning}</p>}</div>}
      {report.segments.map((segment, index) => <div className="detection-segment" key={index}><small>{['人工', 'AI', '疑似 AI'][segment.label]} · 置信度 {percentage(segment.confidence)}</small><p>{segment.text}</p></div>)}<details><summary>检测来源与版本</summary><p>腾讯朱雀 zhuque-text · {report.createdAt}</p><p>{report.endpoint}</p><p>原文哈希：{report.sourceHash}</p><p>服务未返回检测模型版本号，已记录检测时间与端点。</p></details></> : <p>尚无检测报告。填写自己的 Makers API Key 后可发起检测。</p>}</article></div>
  </section>;
}
