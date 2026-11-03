// "The host has a newer Ganban than the one you're looking at." Shown only to
// WEB clients (their bundle comes from the host); checks at boot and whenever
// the page becomes visible again after ≥ 10 min away — a Home Screen app that
// was left open overnight. One tap reloads past the cache.
import { useEffect, useState } from 'react';
import { isWebClient } from '../lib/daemon';
import { isStale } from '../lib/build';

export default function StaleBuildBanner() {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isWebClient()) return;
    const origin = window.location.origin;
    let last = 0;
    const check = async () => {
      last = Date.now();
      if (await isStale(origin)) setStale(true);
    };
    void check();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 10 * 60_000) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!stale || dismissed) return null;
  return (
    <div
      className="fixed left-0 right-0 z-[90] flex items-center justify-center gap-3 px-4 py-2 text-sm bg-crust text-text border-b border-gilt-a shadow-lg"
      style={{ top: 'env(safe-area-inset-top)' }}
      role="status"
    >
      <span>A newer Ganban is on the host.</span>
      <button
        onClick={() => window.location.reload()}
        className="g-btn g-btn-gilt g-btn-sm"
      >
        Reload
      </button>
      <button onClick={() => setDismissed(true)} className="g-iconbtn" style={{ width: 32, height: 32 }} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
