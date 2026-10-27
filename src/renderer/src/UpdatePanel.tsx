import { useEffect, useRef, useState } from 'react';

export interface UpdateResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

interface Props {
  currentVersion: string;
  onCheck: (token: string) => Promise<UpdateResult>;
  onOpenPage: () => Promise<void>;
  onClose: () => void;
}

/** Checking is explicit; credentials remain in memory for the duration of the request only. */
export function UpdatePanel({ currentVersion, onCheck, onOpenPage, onClose }: Props) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<UpdateResult | null>(null);
  const mounted = useRef(false);
  const running = useRef(false);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      mounted.current = false;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const close = () => {
    // Unmount immediately; any pending check's result is ignored after close.
    setToken('');
    onClose();
  };
  const check = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    const credential = token.trim();
    setToken('');
    try {
      const response = await onCheck(credential);
      if (!mounted.current) return;
      if (!response || typeof response.currentVersion !== 'string' || typeof response.latestVersion !== 'string'
        || typeof response.updateAvailable !== 'boolean' || typeof response.releaseUrl !== 'string'
        || response.currentVersion !== currentVersion || !response.latestVersion || response.latestVersion.length > 128) {
        throw new Error('检查结果无法确认，请重新检查。');
      }
      setResult(response);
    } catch (cause) {
      if (mounted.current) {
        let message = String(cause instanceof Error ? cause.message : cause)
          .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        if (credential) message = message.split(credential).join('[已隐藏]');
        setError(message || '检查失败，请检查网络或仓库授权。');
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const openPage = async () => {
    try { await onOpenPage(); }
    catch (cause) {
      if (mounted.current) setError(String(cause instanceof Error ? cause.message : cause)
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || '无法打开发布页面。');
    }
  };

  return <div className="modal-overlay"><section ref={panel} tabIndex={-1} role="dialog" aria-modal="true"
    aria-labelledby="update-panel-title" aria-busy={busy} className="book-modal" data-testid="update-panel"
    style={{ width: 600, height: 'auto', maxHeight: '90vh', overflow: 'auto' }}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
      }
    }}>
    <header><div><h2 id="update-panel-title">检查更新</h2></div><button type="button" onClick={close}>关闭</button></header>
    <div style={{ padding: '20px 28px', fontSize: 13, lineHeight: 1.8 }}>
      <p>当前版本：<strong data-testid="update-current-version">{currentVersion || '读取中…'}</strong></p>
      <p>检查时会联网查询 GitHub 发布版本。仓库公开时可直接检查；私有仓库需要单独授权，浏览器中已登录 GitHub 不会自动授权程序。</p>
      <label htmlFor="update-token">GitHub 访问令牌（可选）</label>
      <input id="update-token" data-testid="update-token" type="password" autoComplete="off" spellCheck={false}
        value={token} disabled={busy} onChange={event => setToken(event.target.value)}
        style={{ display: 'block', width: '100%', boxSizing: 'border-box', margin: '8px 0', padding: 10, border: '1px solid #dce2d1', borderRadius: 7 }} />
      <p>令牌仅用于本次检查，不会保存。可使用仅对本仓库授予 Contents 读取权限的令牌；也可以直接在浏览器打开发布页。</p>
      {busy && <p role="status">正在检查更新…</p>}
      {error && <div role="alert" className="error" data-testid="update-error">{error}</div>}
      {result && <div role="status" data-testid="update-result">
        {result.updateAvailable ? <>发现新版本：<strong>{result.latestVersion}</strong>。请打开发布页查看并下载。</> : <>当前已是最新可用版本（{result.latestVersion}）。</>}
      </div>}
    </div>
    <footer style={{ gap: 10, flexWrap: 'wrap' }}>
      <button type="button" data-testid="update-check" className="primary" disabled={busy || !currentVersion} onClick={() => void check()}>检查更新</button>
      <button type="button" data-testid="update-open-page" onClick={() => void openPage()}>在浏览器打开发布页</button>
    </footer>
  </section></div>;
}
