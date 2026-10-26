import { useEffect, useRef, useState } from 'react';
import { useSaveBeforeExit } from './save-before-exit';
import type { MacroImportResult } from '../../shared/macros';
import './macro.css';

type Operation = { ticket: number; projectId: string; kind: 'read' | 'import' | 'preview' | 'copy'; requestId?: string; cancelled: boolean };
const errorText = (error: unknown) => String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const importFormats = { single: '单条脚本', array: '脚本数组', scripts: 'scripts 包装' } as const;
function verifyImport(value: MacroImportResult, projectId: string) {
  if (value.schemaVersion !== 1 || value.projectId !== projectId || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 256
    || !['single', 'array', 'scripts'].includes(value.format) || !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
    || typeof value.sourceFile !== 'string' || !value.sourceFile || value.sourceFile.length > 32767 || value.sourceFile.includes('\0')
    || !Array.isArray(value.unsupportedFields) || value.unsupportedFields.length > 64
    || value.unsupportedFields.some(field => typeof field !== 'string' || field.length > 128)
    || !Number.isSafeInteger(value.unsupportedFieldCount) || value.unsupportedFieldCount < value.unsupportedFields.length)
    throw new Error('导入结果的小说、原件或兼容报告不匹配，未在本页应用');
}

/** This window only previews data. Worker results belong to the frozen book and request. */
export function MacroPanel({ projectId, sampleText, blocked, onClose }: { projectId: string; sampleText: string; blocked: boolean; onClose: () => void }) {
  const [scripts, setScripts] = useState<number | null>(null);
  const [text, setText] = useState((sampleText || '{{char}}说(小声)：{{user}}看见你了。').slice(0, 20000));
  const [sampleTruncated] = useState(sampleText.length > 20000);
  const [character, setCharacter] = useState('');
  const [result, setResult] = useState<{ expanded: string; applied: string } | null>(null);
  const [importResult, setImportResult] = useState<MacroImportResult | null>(null);
  const [phase, setPhase] = useState<Operation['kind'] | null>('read');
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const mounted = useRef(false), running = useRef(true), sequence = useRef(0);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const active = useRef<Operation | null>(null);
  const panel = useRef<HTMLElement>(null), messages = useRef<HTMLDivElement>(null);
  const busy = phase !== null;
  const valid = (operation: Operation) => mounted.current && currentProject.current === operation.projectId && active.current === operation && sequence.current === operation.ticket;
  useSaveBeforeExit('宏与正则预览', () => ({ dirty: false, busy: running.current }));
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (running.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, []);
  useEffect(() => {
    const previous = document.activeElement; panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (busy) panel.current?.focus({ preventScroll: true }); }, [busy]);
  useEffect(() => { if (error || message || importResult) messages.current?.scrollIntoView({ block: 'nearest' }); }, [error, message, importResult]);
  useEffect(() => {
    mounted.current = true; running.current = true;
    const operation: Operation = { ticket: ++sequence.current, projectId, kind: 'read', cancelled: false };
    active.current = operation; setPhase('read'); setScripts(null); setResult(null); setImportResult(null); setError(''); setMessage('');
    void window.writer.readMacroScripts(projectId).then(list => {
      if (valid(operation)) setScripts(list.length);
    }).catch(e => { if (valid(operation)) setError(errorText(e)); }).finally(() => {
      if (valid(operation)) { active.current = null; running.current = false; setPhase(null); }
    });
    return () => {
      const pending = active.current;
      mounted.current = false; sequence.current++; active.current = null; running.current = false;
      if (pending?.kind === 'preview' && pending.requestId) void window.writer.cancelMacroPreview(pending.projectId, pending.requestId).catch(() => {});
    };
  }, [projectId]);
  const begin = (kind: 'import' | 'preview' | 'copy') => {
    if (running.current || blocked) return null;
    const operation: Operation = { ticket: ++sequence.current, projectId, kind, requestId: kind === 'preview' ? crypto.randomUUID() : undefined, cancelled: false };
    active.current = operation; running.current = true; setPhase(kind); setCancelling(false);
    if (kind !== 'copy') setResult(null);
    if (kind === 'import') setImportResult(null);
    setError(''); setMessage('');
    return operation;
  };
  const finish = (operation: Operation) => {
    if (valid(operation)) { active.current = null; running.current = false; setPhase(null); setCancelling(false); }
  };
  const importScripts = async () => {
    const operation = begin('import'); if (!operation) return;
    try {
      const imported = await window.writer.importMacroScripts(operation.projectId);
      if (!valid(operation)) return;
      if (imported) { verifyImport(imported, operation.projectId); setScripts(imported.count); setImportResult(imported); setMessage(`已导入 ${imported.count} 条正则脚本`); }
      else setMessage('已取消导入，原脚本保持不变。');
    } catch (e) { if (valid(operation)) setError(errorText(e)); }
    finally { finish(operation); }
  };
  const copySource = async () => {
    const source = importResult;
    if (!source || source.projectId !== projectId) return;
    const operation = begin('copy'); if (!operation) return;
    try {
      await window.writer.copyText(source.sourceFile);
      if (valid(operation)) setMessage('原始JSON路径已复制');
    } catch (e) { if (valid(operation)) setError(errorText(e)); }
    finally { finish(operation); }
  };
  const preview = async () => {
    const frozenText = text, frozenCharacter = character;
    const operation = begin('preview'); if (!operation) return;
    try {
      const value = await window.writer.previewMacros(operation.projectId, frozenText, { characterName: frozenCharacter }, operation.requestId!);
      if (!valid(operation)) return;
      if (operation.cancelled) { setError(''); setMessage('预览已取消，未应用任何结果。'); return; }
      if (value.schemaVersion !== 1 || value.projectId !== operation.projectId || value.requestId !== operation.requestId
        || !/^[a-f0-9]{64}$/u.test(value.sourceHash)) throw new Error('预览结果的小说或请求版本不匹配，请重新预览');
      setScripts(value.scripts); setResult({ expanded: value.expanded, applied: value.applied });
    } catch (e) {
      if (!valid(operation)) return;
      if (operation.cancelled) { setError(''); setMessage('预览已取消，未应用任何结果。'); } else setError(errorText(e));
    } finally { finish(operation); }
  };
  const cancel = async () => {
    const operation = active.current;
    if (!operation || operation.kind !== 'preview' || !operation.requestId || operation.cancelled) return;
    operation.cancelled = true; setCancelling(true); setResult(null);
    try { await window.writer.cancelMacroPreview(operation.projectId, operation.requestId); }
    catch (e) { if (valid(operation)) setError(`取消请求未完成：${errorText(e)}。正在等待预览结束。`); }
  };
  const close = () => { if (!running.current) onClose(); };
  return <div className="modal-overlay"><section ref={panel} tabIndex={-1} className="book-modal macro-modal" role="dialog" aria-modal="true" aria-label="宏与正则" aria-busy={busy} data-testid="macro-panel" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2>宏与正则</h2><p>按 SillyTavern 的规则展开 <code>{'{{char}}'}</code>、<code>{'{{user}}'}</code>、<code>{'{{random::…}}'}</code> 等宏，再按顺序套用导入的正则脚本。这里只预览，不改写正文。</p></div></header>
    <div ref={messages}>{error && <div role="alert" className="error" data-testid="macro-error">{error}</div>}{message && <p role="status" data-testid="macro-message">{message}</p>}</div>
    <div className="actions"><button data-testid="macro-import" disabled={busy || blocked} onClick={() => void importScripts()}>导入正则脚本…</button><span className="notice" role="status">当前 {scripts ?? '…'} 条脚本</span></div>
    {importResult && <section className="macro-import-report" data-testid="macro-import-result" aria-label="正则导入兼容报告">
      <h3>已识别：{importFormats[importResult.format]} · {importResult.count} 条</h3>
      <p>完整原始JSON已另存，保留原字节和扩展字段。原件副本不代表完整酒馆插件运行。</p>
      <code data-testid="macro-import-source">{importResult.sourceFile}</code>
      <button type="button" data-testid="macro-import-copy-source" disabled={busy || blocked} onClick={() => void copySource()}>复制原始JSON路径</button>
      <small>SHA-256 {importResult.sourceSha256}</small>
      {importResult.unsupportedFieldCount > 0 && <details data-testid="macro-import-unsupported"><summary>{importResult.unsupportedFieldCount} 个字段仅保留，不参与手工预览</summary>
        <p>当前预览只展开支持的宏并顺序替换，不执行这些触发条件或扩展逻辑。</p>
        <ul>{importResult.unsupportedFields.map((field, index) => <li key={`${index}:${field}`}><code>{field}</code></li>)}</ul>
        <p>字段名最多显示64项，每项最多128字符；完整字段见原始JSON。</p>
      </details>}
    </section>}
    <label>角色名（用于 {'{{char}}'}）<input aria-label="宏角色名" maxLength={512} disabled={busy || blocked} value={character} onChange={e => { setCharacter(e.target.value); setResult(null); }} placeholder="例如：林夏" /></label>
    <label>测试文本<textarea aria-label="宏测试文本" rows={4} maxLength={20000} disabled={busy || blocked} value={text} onChange={e => { setText(e.target.value); setResult(null); }} /></label>
    {sampleTruncated && <p className="macro-help" data-testid="macro-sample-truncated">已取前20000字符用于预览，正文未变。</p>}
    <p className="macro-help">正则计算最长3秒，可随时取消；超时、取消或来源变化时不返回部分结果。测试文本最多20,000字符，结果最多200,000字符。</p>
    <div className="actions"><button data-testid="macro-preview" disabled={busy || blocked || !text.trim()} onClick={() => void preview()}>{phase === 'preview' ? '正在预览…' : '预览'}</button>{phase === 'preview' && <button data-testid="macro-cancel" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : '取消预览'}</button>}</div>
    {result && <section className="macro-result"><article><h3>宏展开后</h3><pre>{result.expanded}</pre></article><article><h3>套用正则后</h3><pre>{result.applied}</pre></article></section>}
    <footer><button data-testid="macro-close" disabled={busy} onClick={close}>关闭</button></footer>
  </section></div>;
}
