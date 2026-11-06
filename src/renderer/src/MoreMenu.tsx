import { useEffect, useRef, type ReactNode } from 'react';

/** Mouse hover augments the native click/keyboard details interaction. */
export function MoreMenu({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverOpened = useRef(false);
  const cancelClose = () => { clearTimeout(timer.current); timer.current = undefined; };
  const close = (restoreFocus = false) => {
    cancelClose(); hoverOpened.current = false;
    if (!root.current) return;
    root.current.open = false;
    if (restoreFocus) root.current.querySelector('summary')?.focus();
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return <details ref={root} className="topbar-more"
    onPointerEnter={event => {
      cancelClose();
      if (event.pointerType !== 'mouse' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      if (!event.currentTarget.open) { event.currentTarget.open = true; hoverOpened.current = true; }
    }}
    onPointerLeave={event => {
      if (event.pointerType !== 'mouse') return;
      cancelClose();
      timer.current = setTimeout(() => {
        const node = root.current;
        const summary = node?.querySelector('summary');
        if (node && (!node.contains(document.activeElement) || (hoverOpened.current && document.activeElement === summary))) close();
      }, 220);
    }}
    onKeyDown={event => {
      if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); close(true); }
    }}
    onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close(); }}
    onClick={event => { if (event.target instanceof Element && event.target.closest('button')) close(true); }}>
    <summary onClick={event => {
      // Hover already opened it: the following mouse click should pin, not immediately close.
      if (event.detail > 0 && hoverOpened.current && root.current?.open) event.preventDefault();
      hoverOpened.current = false;
      cancelClose();
    }}>更多功能<svg className="more-chevron" aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></summary>
    <div className="topbar-more-panel" aria-label="更多功能">{children}</div>
  </details>;
}
