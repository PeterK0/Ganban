// macOS: the windows use titleBarStyle "Overlay", so the traffic lights sit over
// the app's own top bar. This hook says how much of the bar's left end to keep
// clear for them: none in full screen (macOS hides them there), none off macOS.
// Preview it in a browser with ?macTitlebar=1 or
// localStorage['ganban-force-mac-titlebar'] = '1'.

import { useEffect, useState } from 'react';
import { isMobilePlatform, isTauri } from './daemon';
import { titleBarInset } from './navHistory.pure';

const FORCE_KEY = 'ganban-force-mac-titlebar';

function forced(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('macTitlebar') === '1' || localStorage.getItem(FORCE_KEY) === '1';
  } catch {
    return false;
  }
}

export const isMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** Left padding (px) the top bar keeps free for the traffic lights. */
export function useTitleBarInset(): number {
  const [fullscreen, setFullscreen] = useState(false);
  const tauri = isTauri();
  const mobile = isMobilePlatform();
  const mac = isMac();
  const force = forced();
  const native = tauri && !mobile && mac;
  useEffect(() => {
    if (native) {
      let un: (() => void) | undefined;
      let dead = false;
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const w = getCurrentWindow();
        const check = () => void w.isFullscreen().then((fs) => !dead && setFullscreen(fs)).catch(() => {});
        check();
        // Entering or leaving full screen resizes the window.
        const off = await w.onResized(check);
        if (dead) off();
        else un = off;
      })().catch(() => {});
      return () => {
        dead = true;
        un?.();
      };
    }
    if (!force) return;
    const check = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', check);
    return () => document.removeEventListener('fullscreenchange', check);
  }, [native, force]);
  return titleBarInset({ tauri, mobile, mac, fullscreen, forced: force });
}
