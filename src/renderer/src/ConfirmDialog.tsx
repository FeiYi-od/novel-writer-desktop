import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<Ask>(async () => false);

/** 应用内确认框：替代 window.confirm，保持与整体玻璃界面一致，支持 Esc 取消、Enter 确认。 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const ask = useCallback<Ask>(options => new Promise(resolve => setState({ options, resolve })), []);
  const finish = useCallback((value: boolean) => {
    setState(current => { current?.resolve(value); return null; });
  }, []);
  useEffect(() => {
    if (!state) return;
    acceptRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      else if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, finish]);
  return <ConfirmContext.Provider value={ask}>
    {children}
    {state && <div className="confirm-overlay modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) finish(false); }}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-label={state.options.title ?? '确认操作'} data-testid="confirm-dialog">
        <header><h2>{state.options.title ?? '确认操作'}</h2><button type="button" aria-label="关闭" onClick={() => finish(false)}>✕</button></header>
        <p className="confirm-message">{state.options.message}</p>
        {state.options.detail && <p className="confirm-detail">{state.options.detail}</p>}
        <footer>
          <button type="button" onClick={() => finish(false)}>{state.options.cancelText ?? '取消'}</button>
          <button type="button" ref={acceptRef} data-testid="confirm-accept" className={state.options.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>{state.options.confirmText ?? '确定'}</button>
        </footer>
      </section>
    </div>}
  </ConfirmContext.Provider>;
}

export function useConfirm() { return useContext(ConfirmContext); }
