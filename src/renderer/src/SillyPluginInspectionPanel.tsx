import { useEffect, useRef, useState } from 'react';
import type { SillyPluginInspection } from '../../shared/contracts';

/** Inspection is read-only; the selected code is never loaded into this application. */
export function SillyPluginInspectionPanel({ projectId, onClose, onBusy }: { projectId: string; onClose: () => void; onBusy: (value: boolean) => void }) {
  const [report, setReport] = useState<SillyPluginInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(true), pending = useRef(false), panel = useRef<HTMLElement>(null);
  useEffect(() => {
    live.current = true; const previous = document.activeElement; panel.current?.focus();
    return () => { live.current = false; onBusy(false); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onBusy]);
  const inspect = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); onBusy(true); setError('');
    try {
      const result = await window.writer.inspectSillyPlugin(projectId);
      if (!live.current || result === null) return;
      if (result.projectId !== projectId || result.schemaVersion !== 1 || result.executed !== false) throw new Error('检查结果归属或格式不正确');
      setReport(result);
    } catch (e) { if (live.current) setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { pending.current = false; if (live.current) { setBusy(false); onBusy(false); } }
  };
  const close = () => { if (!pending.current) onClose(); };
  return <div className="modal-overlay"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="酒馆插件兼容检查" className="book-modal world-modal" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2>酒馆插件兼容检查</h2><p>选择插件文件夹后，只读取并核对清单和文件，不运行插件。检查结果不能代表插件已经兼容。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}
    {busy && <p role="status">正在检查插件文件…</p>}
    <div className="actions"><button className="primary" disabled={busy} data-testid="plugin-inspect-select" onClick={() => void inspect()}>选择插件文件夹并检查</button></div>
    {report && <section className="world-hits" data-testid="plugin-inspect-report">
      <h3>{report.displayName}{report.version ? ` · ${report.version}` : ''}</h3>
      <p>未执行插件 · {report.files.length} 个文件 · {report.totalBytes} 字节</p>
      <p>脚本入口：{report.js ? `${report.js.path}（${report.js.exists ? '存在' : '不存在'}）` : '未声明'}；样式入口：{report.css ? `${report.css.path}（${report.css.exists ? '存在' : '不存在'}）` : '未声明'}。</p>
      <p>生命周期：{[report.hooks.activate && `启用 ${report.hooks.activate}`, report.hooks.clean && `清理 ${report.hooks.clean}`, ...report.hooks.other].filter(Boolean).join('、') || '未声明'}。</p>
      <p>依赖：{report.requires.join('、') || '无'}；可选依赖：{report.optional.join('、') || '无'}。</p>
      <p>许可证文件：{report.license.present ? report.license.files.join('、') : '未找到'}{report.license.declared ? `；声明 ${report.license.declared}` : ''}。是否符合使用要求需另行核对。</p>
      <ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      <details><summary>查看文件与 SHA-256</summary><ul>{report.files.map(file => <li key={file.path}><small>{file.path} · {file.bytes} 字节 · {file.sha256}</small></li>)}</ul></details>
    </section>}
    <footer><button disabled={busy} onClick={close}>关闭</button></footer>
  </section></div>;
}
