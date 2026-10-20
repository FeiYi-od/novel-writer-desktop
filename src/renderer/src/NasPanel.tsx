import { useState } from 'react';
import { parseStorageTargets, STORAGE_PROVIDERS } from '../../core/storage-targets';

type Result = { host: string; port: number; label?: string; ok: boolean; ms: number; reason?: string };
/** NAS reachability check: hosts and ports only — this panel never asks for or stores credentials. */
export function NasPanel({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const [targets, setTargets] = useState('');
  const [providerId, setProviderId] = useState<string>('generic');
  const [backup, setBackup] = useState<{ folder: string; files: number; bytes: number; verified: boolean; checked: number } | null>(null);
  const [drill, setDrill] = useState<{ ok: boolean; at: string; steps: { name: string; ok: boolean; detail: string }[] } | null>(null);
  const [exportNote, setExportNote] = useState('');
  const [progress, setProgress] = useState<{ chapters: { path: string; characters: number; paragraphs: number; updatedAt: string }[]; totalCharacters: number; totalParagraphs: number; stale: string[] } | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; checked: number; issues: { level: 'warn' | 'error'; code: string; message: string; path?: string }[] } | null>(null);
  const [history, setHistory] = useState<{ at: string; ok: boolean; steps: { name: string; ok: boolean; detail: string }[] }[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [location, setLocation] = useState<{ target: string; kind: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  let targetError = ''; let targetCount = 0;
  try { targetCount = parseStorageTargets(targets).length; } catch (e) { targetError = (e as Error).message; }
  const provider = STORAGE_PROVIDERS.find(item => item.id === providerId) ?? STORAGE_PROVIDERS[0];
  return <div className="modal-overlay"><section className="book-modal nas-modal" role="dialog" aria-modal="true" aria-label="NAS 连接检查">
    <header><div><h2>NAS 与网盘目录</h2><p>通过 Windows 文件夹打开小说；文件同步由对应的同步客户端或映射挂载工具负责。这里不收集账号密码，也不预填任何设备地址。</p></div></header>
    <section data-testid="storage-compatibility">
      <h3>选择设备或网盘</h3>
      <label>存储方式<select aria-label="存储方式" disabled={busy} value={providerId} onChange={e => setProviderId(e.target.value)}>{STORAGE_PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <p data-testid="storage-provider-guide">{provider.guide}</p>
      <p className="notice">当前支持文件夹读写、外部变更检查、备份与恢复；未接入网盘账号直连 API，应用无法确认云端同步进度。两台设备轮流写作：本机保存 → 等待客户端同步完成 → 另一台再打开。</p>
      <p className="notice">人物卡、世界观等固定“创作资料”目录也需要单独同步；仅同步正文文件夹不会自动同步这些资料。整书备份与 ZIP 导出包含本书资料，可用于完整迁移。</p>
    </section>
    {error && <div role="alert" className="error">{error}</div>}
    {projectId && <section className="nas-progress">
      <h3>写作进度</h3>
      <p>按章统计字数与段落，并标出超过 14 天没动过的章节（按文件修改时间）。只读。</p>
      <div className="actions"><button data-testid="book-progress" disabled={busy} onClick={() => void run(async () => { setProgress(await window.writer.bookProgress(projectId)); })}>统计进度</button></div>
      {progress && <div data-testid="book-progress-result">
        <p role="status">{progress.chapters.length} 章 · {progress.totalCharacters} 字 · {progress.totalParagraphs} 段{progress.stale.length ? `；${progress.stale.length} 章超过 14 天没动` : '；14 天内都动过'}</p>
        {progress.chapters.length > 0 && <table className="nas-table"><thead><tr><th>章节</th><th>字数</th><th>段落</th><th>最后修改</th></tr></thead><tbody>
          {progress.chapters.slice(0, 10).map(chapter => <tr key={chapter.path}>
            <td>{chapter.path}</td><td>{chapter.characters}</td><td>{chapter.paragraphs}</td>
            <td>{new Date(chapter.updatedAt).toLocaleDateString()}{progress.stale.includes(chapter.path) ? ' · 久未更新' : ''}</td>
          </tr>)}
        </tbody></table>}
        {progress.chapters.length > 10 && <p>仅显示前 10 章（共 {progress.chapters.length} 章）。</p>}
      </div>}
    </section>}
    {projectId && <section className="nas-health">
      <h3>本书健康检查</h3>
      <p>只读检查：章节文件是否存在且非空、有没有被外部软件改过、有没有同步冲突副本。不修复、不移动、不删除任何文件。</p>
      <div className="actions"><button data-testid="book-health" disabled={busy} onClick={() => void run(async () => { setHealth(await window.writer.bookHealth(projectId)); })}>开始检查</button></div>
      {health && <div data-testid="book-health-result">
        <p role="status">{health.issues.length ? `检查了 ${health.checked} 章，发现 ${health.issues.length} 个问题` : `检查了 ${health.checked} 章，没有发现问题`}</p>
        {health.issues.length > 0 && <ul>{health.issues.map(issue => <li key={`${issue.code}-${issue.path ?? issue.message}`} className={`level-${issue.level}`}>{issue.level === 'error' ? '错误' : '注意'}：{issue.message}{issue.path ? `（${issue.path}）` : ''}</li>)}</ul>}
      </div>}
    </section>}
    <h3>可选：TCP 连接检查</h3>
    <p>只检查主机端口可达，不表示文件共享已登录或文件已同步。每行一个目标；省略端口时使用 443；IPv6 指定端口须写为 [IPv6]:端口。最多 8 个目标。</p>
    <label>目标（域名、IPv4 或 IPv6）<textarea aria-label="NAS 目标" rows={4} maxLength={4000} disabled={busy} placeholder="填写你自己的主机地址；可留空" value={targets} onChange={e => { setTargets(e.target.value); setResults(null); }} /></label>
    {targetError && <p role="alert" className="error" data-testid="nas-target-error">{targetError}</p>}
    <div className="actions">
      <button data-testid="nas-probe" disabled={busy || !!targetError || targetCount === 0} onClick={() => void run(async () => { setResults(await window.writer.probeNas(parseStorageTargets(targets))); })}>开始检查</button>
    </div>
    {results && <table className="nas-table"><thead><tr><th>目标</th><th>结果</th><th>耗时</th></tr></thead><tbody>
      {results.map(result => <tr key={`${result.host}:${result.port}`}>
        <td>{result.label ?? `${result.host}:${result.port}`}</td>
        <td>{result.ok ? '可达' : `不可达（${result.reason ?? '未知原因'}）`}</td>
        <td>{result.ms} ms</td>
      </tr>)}</tbody></table>}
    <label>检查文件夹位置（判断是本地盘、映射盘还是 UNC）<input aria-label="检查文件夹" disabled={busy} placeholder="H:\小说编辑器 或 \\NAS\共享\小说" onChange={e => setLocation({ target: e.target.value, kind: '…' })} /></label>
    {location && <div className="actions"><button disabled={busy || !location.target.trim()} onClick={() => void run(async () => { setLocation({ target: location.target, kind: await window.writer.nasLocation(location.target) }); })}>判断位置</button>
      <span className="notice" role="status">{location.kind === '…' ? '待判断' : `位置类型：${{ local: '本地盘', unc: '网络路径（UNC）', network: '映射的网络盘', unknown: '无法确认' }[location.kind] ?? location.kind}`}</span></div>}
    {projectId && <section className="nas-backup">
      <h3>备份本书</h3>
      <p>把整本书和固定目录中的本书资料复制到你选择的本机、NAS 或网盘同步目录，附 SHA-256 清单；同名目录自动加序号，<b>不会覆盖已有备份</b>。</p>
      <div className="actions"><button data-testid="nas-backup" disabled={busy} onClick={() => void run(async () => { setBackup(await window.writer.backupBookTo(projectId)); })}>备份到文件夹…</button>
        <button data-testid="nas-restore" disabled={busy} onClick={() => void run(async () => {
          const restored = await window.writer.restoreBackupFrom();
          if (restored) setBackup({ folder: restored.folder, files: restored.files, bytes: restored.bytes, verified: true, checked: restored.files });
        })}>从备份恢复…</button>
        <button data-testid="book-export" disabled={busy} onClick={() => void run(async () => {
          const result = await window.writer.exportBookZip(projectId);
          if (result) setExportNote(`已导出 ${result.files} 个文件到 ${result.file}（${Math.round(result.bytes / 1024)} KB），目标已存在时不会覆盖`);
        })}>导出整本书 ZIP…</button></div>
      {exportNote && <p className="notice" role="status" data-testid="book-export-result">{exportNote}</p>}
      <p className="notice" role="status">恢复会先校验备份，再复制到一个<b>新目录</b>；不会覆盖现在的小说。</p>
      {backup && <div className="notice" role="status" data-testid="nas-backup-result">已备份 {backup.files} 个文件（{Math.round(backup.bytes / 1024)} KB）到 {backup.folder}，校验 {backup.verified ? '通过' : '失败'}（{backup.checked} 项）。</div>}
    </section>}
    <section className="nas-drill">
      <h3>断网演练自检</h3>
      <p>在临时目录里复现「同步客户端改回旧版本」与「映射盘掉线」，确认不会丢稿、不会覆盖远端；不会碰你正在写的小说。</p>
      <div className="actions"><button data-testid="nas-drill" disabled={busy} onClick={() => void run(async () => { setDrill(await window.writer.runOfflineDrill()); setHistory(await window.writer.drillHistory()); })}>开始自检</button></div>
      {drill && <table className="nas-table" data-testid="nas-drill-result"><thead><tr><th>场景</th><th>结果</th><th>说明</th></tr></thead><tbody>
        {drill.steps.map(step => <tr key={step.name}><td>{step.name}</td><td>{step.ok ? '通过' : '未通过'}</td><td>{step.detail}</td></tr>)}
      </tbody></table>}
      {history.length > 0 && <details data-testid="nas-drill-history"><summary>历史自检（最近 {Math.min(history.length, 5)} 次）</summary>
        <ul>{history.slice(0, 5).map(item => <li key={item.at}>{new Date(item.at).toLocaleString()} · {item.ok ? '全部通过' : '有未通过项'} · {item.steps.filter(step => step.ok).length}/{item.steps.length}</li>)}</ul>
      </details>}
    </section>
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
