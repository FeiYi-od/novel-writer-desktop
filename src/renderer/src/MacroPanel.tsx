import { useEffect, useState } from 'react';

/** Macro expansion + SillyTavern regex scripts, previewed side by side before anything is applied. */
export function MacroPanel({ projectId, sampleText, blocked, onClose }: { projectId: string; sampleText: string; blocked: boolean; onClose: () => void }) {
  const [scripts, setScripts] = useState<number | null>(null);
  const [text, setText] = useState(sampleText || '{{char}}说(小声)：{{user}}看见你了。');
  const [character, setCharacter] = useState('');
  const [result, setResult] = useState<{ expanded: string; applied: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => { let live = true; void window.writer.readMacroScripts(projectId).then(list => { if (live) setScripts(list.length); }).catch(e => { if (live) setError(String(e)); }); return () => { live = false; }; }, [projectId]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (e) { setError(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); } finally { setBusy(false); } };
  return <div className="modal-overlay"><section className="book-modal macro-modal" role="dialog" aria-modal="true" aria-label="宏与正则">
    <header><div><h2>宏与正则</h2><p>按 SillyTavern 的规则展开 <code>{'{{char}}'}</code>、<code>{'{{user}}'}</code>、<code>{'{{random::…}}'}</code> 等宏，再按顺序套用导入的正则脚本。应用前先看结果。</p></div></header>
    {error && <div role="alert" className="error">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="actions">
      <button data-testid="macro-import" disabled={busy || blocked} onClick={() => void run(async () => { const imported = await window.writer.importMacroScripts(projectId); if (imported) { setScripts(imported.count); setMessage(`已导入 ${imported.count} 条正则脚本`); } })}>导入正则脚本…</button>
      <span className="notice" role="status">当前 {scripts ?? '…'} 条脚本</span>
    </div>
    <label>角色名（用于 {'{{char}}'}<input aria-label="宏角色名" disabled={busy || blocked} value={character} onChange={e => setCharacter(e.target.value)} placeholder="例如：林夏" /></label>
    <label>测试文本<textarea aria-label="宏测试文本" rows={4} maxLength={20000} disabled={busy || blocked} value={text} onChange={e => setText(e.target.value)} /></label>
    <div className="actions"><button data-testid="macro-preview" disabled={busy || blocked || !text.trim()} onClick={() => void run(async () => { const preview = await window.writer.previewMacros(projectId, text, { characterName: character }); setResult({ expanded: preview.expanded, applied: preview.applied }); })}>预览</button></div>
    {result && <section className="macro-result">
      <article><h3>宏展开后</h3><pre>{result.expanded}</pre></article>
      <article><h3>套用正则后</h3><pre>{result.applied}</pre></article>
    </section>}
    <footer><button onClick={onClose}>关闭</button></footer>
  </section></div>;
}
