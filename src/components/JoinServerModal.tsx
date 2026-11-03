import { useState } from 'react';
import { Modal } from './gilt';
import {
  enrollDevice,
  parseInviteLink,
  probeHost,
  diagnoseUnreachable,
  isTailnetUrl,
  openExternal,
} from '../lib/daemon';
import { addRemoteWorkspace, setActiveWorkspace } from '../lib/workspaces';

/**
 * The discoverable "join someone's host" surface (reachable any time from the
 * sidebar — not just the fresh-install chooser, not buried in Settings → Sync,
 * which is where the friend couldn't find it). Paste a link, we PREFLIGHT the
 * host before enrolling so an unreachable tailnet address becomes a clear
 * "accept the shared machine first" instruction instead of an 8-second mystery.
 *
 * When the invite carries a Tailscale device-share URL (`ts`, auto-share) and
 * the host is unreachable, we surface a one-click "accept the shared machine"
 * step right here — folding the network join into the same flow. The joined
 * host is ADDED as a workspace (K2 merged view): your own local projects stay
 * in the sidebar alongside it.
 */
export default function JoinServerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  // The Tailscale share to accept (set when the host is unreachable AND the
  // invite carried a `ts`) — turns the dead-end into a one-click step.
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  if (!open) return null;

  const connect = async () => {
    const payload = parseInviteLink(link);
    if (!payload) {
      setError(
        "That doesn't look like a Ganban link. Two ways to get one: an invite from the host's owner (their Members tab → Invite by link), or a pairing link from a device where you're already signed in (Account → Your devices → Pair another device).",
      );
      return;
    }
    setBusy(true);
    setError(null);
    setAcceptUrl(null);
    try {
      // Preflight: is the host even reachable from here? A tailnet address
      // that doesn't answer = the share hasn't been accepted on this device.
      setStage('Checking the host is reachable…');
      const reachable = await probeHost(payload.u);
      if (!reachable) {
        // If the invite brought a Tailscale share, offer to accept it in-flow
        // instead of just explaining the problem.
        if (payload.ts) setAcceptUrl(payload.ts);
        else setError(diagnoseUnreachable(payload.u));
        setBusy(false);
        setStage(null);
        return;
      }
      setStage('Joining…');
      const res = await enrollDevice(payload.u, payload.t, 'Ganban desktop');
      // Register this host as a workspace and make it active (K2). Adds to the
      // registry rather than flipping a global — the foundation for keeping
      // your local workspace alongside it (the merged view, next stages).
      const id = addRemoteWorkspace({ url: payload.u, token: res.device_token });
      setActiveWorkspace(id);
      window.location.reload(); // boots into the joined workspace as the enrolled member
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setStage(null);
    }
  };

  const tailnetHint = (() => {
    const p = parseInviteLink(link);
    return p && isTailnetUrl(p.u);
  })();

  return (
    <Modal onClose={onClose} title="Join a project" className="w-[min(560px,calc(100vw-32px))]">
      <div className="g-form overflow-y-auto px-6 pb-6 space-y-4">

        <p className="text-sm text-subtext-0">
          Paste a link and we'll connect this app to that host. Two kinds work:
        </p>
        <ul className="text-xs text-subtext-0 space-y-1 list-disc pl-5">
          <li><span className="text-subtext-1">An invite</span> from the project's owner — you join as a new member.</li>
          <li>
            <span className="text-subtext-1">A pairing link from a device where you're already signed in</span> — on your phone:{' '}
            <span className="text-text">Account → Your devices → Pair another device → Copy link</span> (send it here via Notes,
            Messages or AirDrop). This Mac then signs in as{' '}
            <em>you</em>: same account, same projects.
          </li>
        </ul>

        <input
          autoFocus
          value={link}
          onChange={(e) => { setLink(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }}
          placeholder="Paste the invite or pairing link…"
          className="g-field"
        />

        {tailnetHint && !error && !acceptUrl && (
          <p className="text-xs text-subtext-0">
            This is a Tailscale host. If you haven't already, accept the shared machine the owner sent you
            (a Tailscale invite link) on this device first — otherwise the join can't reach it.
          </p>
        )}

        {acceptUrl && (
          <div className="text-sm bg-mantle border border-gilt-a rounded px-3 py-3 space-y-2">
            <div className="font-medium text-text">Step 1 — accept the shared machine</div>
            <p className="text-subtext-0 text-xs">
              The owner's host isn't reachable from this device yet. Their invite includes a one-click Tailscale
              share — accept it (in your browser, with your own Tailscale account), then come back and join.
              This step is one-time.
            </p>
            <button
              onClick={() => void openExternal(acceptUrl)}
              className="g-btn g-btn-ghost g-btn-sm"
            >
              Accept the shared machine ↗
            </button>
          </div>
        )}

        {error && (
          <div className="text-sm text-warning bg-warning/10 border border-warning/30 rounded px-3 py-2">{error}</div>
        )}

        <p className="text-[11px] text-subtext-0">
          The joined host is added to your sidebar alongside your own local projects — switch between them
          anytime from the workspace menu.
        </p>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="g-btn g-btn-ghost">
            Cancel
          </button>
          <button
            onClick={() => void connect()}
            disabled={busy || !link.trim()}
            className="g-btn g-btn-pri"
          >
            {busy ? (stage ?? 'Connecting…') : acceptUrl ? "I've accepted it — join" : error ? 'Try again' : 'Join'}
          </button>
        </div>
      </div>

      {/* After the content, so focus starts on the content, not on ✕. */}
      <button onClick={onClose} className="g-iconbtn absolute top-3 right-3" aria-label="Close">✕</button>
    </Modal>
  );
}
