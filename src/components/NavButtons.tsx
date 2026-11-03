// The top bar's ‹ › (the app's back/forward history, store/navHistory), plus its
// shortcuts: Cmd+[ / Cmd+] on macOS, Alt+← / Alt+→ elsewhere, and the mouse's
// back and forward buttons. Typing in a field keeps the keys for the field.

import { useEffect } from 'react';
import { useNav } from '../store/navHistory';
import { canBack, canForward, navKey } from '../lib/navHistory.pure';
import { isMac } from '../lib/titleBar';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export default function NavButtons() {
  const back = useNav(canBack);
  const fwd = useNav(canForward);
  const mac = isMac();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = navKey(e, mac);
      if (!dir || typing(e.target)) return;
      e.preventDefault();
      void useNav.getState().step(dir);
    };
    const side = (e: MouseEvent) => e.button === 3 || e.button === 4;
    // The browser's own back/forward on these buttons would leave the app.
    const onDown = (e: MouseEvent) => side(e) && e.preventDefault();
    const onUp = (e: MouseEvent) => {
      if (!side(e)) return;
      e.preventDefault();
      void useNav.getState().step(e.button === 3 ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
    };
  }, [mac]);

  const backLabel = `Back (${mac ? '⌘[' : 'Alt+←'})`;
  const fwdLabel = `Forward (${mac ? '⌘]' : 'Alt+→'})`;
  return (
    <div className="flex items-center shrink-0 -mr-1.5">
      <button onClick={() => void useNav.getState().step(-1)} disabled={!back} className="g-iconbtn" title={backLabel} aria-label={backLabel}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <button onClick={() => void useNav.getState().step(1)} disabled={!fwd} className="g-iconbtn" title={fwdLabel} aria-label={fwdLabel}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
      </button>
    </div>
  );
}
