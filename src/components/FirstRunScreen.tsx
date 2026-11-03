import { useState } from 'react';
import { enrollDevice, parseInviteLink, probeHost, diagnoseUnreachable, openExternal } from '../lib/daemon';
import { addRemoteWorkspace, setActiveWorkspace } from '../lib/workspaces';

/**
 * The launch-time chooser on a genuinely fresh install (Epoch G): use this
 * machine as its own workspace (the default — the embedded, always-demoable
 * path), or join an existing host as a member. The join MECHANISM predates
 * this screen (Settings → Sync); this is the onboarding surface so a member
 * installing the desktop app never has to know that.
 */
export default function FirstRunScreen({ onUseLocal }: { onUseLocal: () => void }) {
  const [joining, setJoining] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  const connect = async () => {
    const payload = parseInviteLink(link);
    if (!payload) {
      setError("That doesn't look like an invite link — ask the host's owner for one (on the host: Sync → Pair → Copy invite link).");
      return;
    }
    setBusy(true);
    setError(null);
    setAcceptUrl(null);
    try {
      // Preflight so an unreachable tailnet host explains itself instead of
      // timing out (see diagnoseUnreachable). If the invite brought a Tailscale
      // share, offer to accept it in-flow rather than just explaining.
      if (!(await probeHost(payload.u))) {
        if (payload.ts) setAcceptUrl(payload.ts);
        else setError(diagnoseUnreachable(payload.u));
        setBusy(false);
        return;
      }
      const res = await enrollDevice(payload.u, payload.t, 'Ganban desktop');
      const id = addRemoteWorkspace({ url: payload.u, token: res.device_token });
      setActiveWorkspace(id);
      localStorage.setItem('ganban-first-run-done', '1');
      window.location.reload(); // boots into the joined workspace as the enrolled member
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="g-form fixed inset-0 z-50 bg-mantle text-text flex items-center justify-center p-6 overflow-y-auto">
      <div className="g-card g-corners w-full max-w-[560px] px-8 py-9 space-y-6">
        <div className="text-center space-y-2">
          <img src="/logo.svg" alt="" className="w-14 h-14 mx-auto" />
          <h1 className="g-subtitle">Welcome to Ganban</h1>
          <p className="text-sm text-subtext-0">How should this machine run?</p>
        </div>

        {!joining ? (
          <div className="space-y-3">
            <button
              onClick={onUseLocal}
              className="w-full text-left p-4 bg-mantle border border-gilt-a rounded hover:bg-gilt-b"
            >
              <div className="flex items-center gap-2 font-semibold text-gold"><span className="g-gem" aria-hidden="true" />Use this machine</div>
              <div className="text-sm text-subtext-0 mt-1">
                Everything runs here — projects, database, AI. No setup, no account, works offline.
                You can host teammates from it later.
              </div>
            </button>
            <button
              onClick={() => setJoining(true)}
              className="w-full text-left p-4 bg-mantle border border-surface-0 rounded hover:border-surface-1"
            >
              <div className="font-semibold text-text">Join a server</div>
              <div className="text-sm text-subtext-0 mt-1">
                Connect to a teammate's always-on Ganban host over the tailnet and work in the shared
                workspace. You'll need an invite link from its owner.
              </div>
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="g-h2">Join a server</h2>
            <p className="text-sm text-subtext-0">
              Paste an <span className="text-subtext-1">invite link</span> from the host's owner — or, if you already use Ganban on
              your phone, a <span className="text-subtext-1">pairing link</span> from it (Account → Your devices → Pair another
              device → Copy link; send it here via Notes, Messages or AirDrop). A pairing link signs this Mac in as <em>you</em>.
            </p>
            <input
              autoFocus
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void connect();
              }}
              placeholder="Paste the invite or pairing link"
              className="g-field"
            />
            {acceptUrl && (
              <div className="text-sm bg-mantle border border-gilt-a rounded px-3 py-3 space-y-2">
                <div className="font-medium text-text">Step 1 — accept the shared machine</div>
                <p className="text-subtext-0 text-xs">
                  The host isn't reachable yet. The invite includes a one-click Tailscale share — accept it (in
                  your browser, with your own Tailscale account), then come back and connect. One-time.
                </p>
                <button
                  onClick={() => void openExternal(acceptUrl)}
                  className="g-btn g-btn-ghost g-btn-sm"
                >
                  Accept the shared machine ↗
                </button>
              </div>
            )}
            {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded px-3 py-2">{error}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => void connect()}
                disabled={busy || !link.trim()}
                className="g-btn g-btn-pri"
              >
                {busy ? 'Connecting…' : acceptUrl ? "I've accepted it — connect" : 'Connect'}
              </button>
              <button onClick={() => setJoining(false)} className="g-btn g-btn-ghost">
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
