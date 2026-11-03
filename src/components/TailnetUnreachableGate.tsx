// Blocking gate shown when an invite link points at a tailnet (100.x / ts.net)
// address but no Tailscale machine-share was attached. Such a link is
// unreachable to anyone not already on the host's tailnet, so silently
// presenting a copyable QR/link is the failure we want to prevent. Instead of
// an advisory the owner can ignore, the link is held behind an explicit
// choice — and the choice now includes the one that needs no API at all:
// paste a machine-share link made by hand in the Tailscale admin console.
// (The auto-share depends on a personal API token that Tailscale caps at 90
// days; the day it expires must not be the day nobody can be invited.)
//
// Scope is deliberately the tailnet case only — a LAN link at least works on
// the same network, and the join side already explains LAN/tailnet
// reachability (diagnoseUnreachable in invite.pure.ts).

import { useState } from "react";
import { parseTailscaleShareLink } from "../lib/invite.pure";

export function TailnetUnreachableGate({
  url,
  shareError,
  onClose,
  onReveal,
  onManualShare,
}: {
  /** The tailnet host URL baked into the link (e.g. http://100.x.y.z:8765). */
  url: string;
  /** Why a share couldn't attach, if the host tried and failed (else null). */
  shareError?: string | null;
  /** Dismiss the whole invite panel. */
  onClose: () => void;
  /** Reveal the link/QR anyway (recipient is already on the owner's tailnet). */
  onReveal: () => void;
  /** The owner pasted a machine-share link they generated themselves — attach
   * it and render the normal two-step invite. */
  onManualShare?: (ts: string) => void;
}) {
  const [manual, setManual] = useState("");
  const parsed = parseTailscaleShareLink(manual);
  const expired = !!shareError && /expire|401/i.test(shareError);

  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2">
      <div className="text-xs font-semibold text-warning">⚠ This link can't reach anyone off your tailnet</div>
      <p className="text-[11px] text-subtext-0">
        {shareError
          ? `A Tailscale machine-share couldn't be attached: ${shareError}.`
          : "No Tailscale machine-share was attached — auto-share isn't set up on this host."}{" "}
        So <span className="font-mono text-subtext-1 break-all">{url}</span> only works for a device already on your tailnet.
      </p>

      {onManualShare && (
        <div className="rounded-lg border border-surface-2 bg-surface-0/60 p-2.5 space-y-1.5">
          <div className="text-[11px] font-medium text-text">Attach a machine-share you make yourself — no API token needed</div>
          <p className="text-[11px] text-subtext-0">
            In the Tailscale admin console: <span className="text-subtext-1">Machines → this host → ⋯ → Share… → Generate invite link</span>.
            It shares <em>only this machine</em> with the person (they stay on their own tailnet). Paste it here:
          </p>
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="https://login.tailscale.com/admin/invite/…"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface-1 border border-surface-2 text-text text-xs font-mono"
            />
            <button
              onClick={() => parsed && onManualShare(parsed)}
              disabled={!parsed}
              className="g-btn g-btn-pri g-btn-sm shrink-0"
            >
              Attach
            </button>
          </div>
          {manual.trim() && !parsed && (
            <p className="text-[11px] text-error">That isn't a Tailscale invite link (they start with https://login.tailscale.com/…/invite/).</p>
          )}
        </div>
      )}

      <p className="text-[11px] text-subtext-0">
        {expired
          ? <>Or renew the auto-share token: <span className="text-text">Settings → Sync → Tailscale</span> — generate a fresh access token at login.tailscale.com → Settings → Keys (pick 90 days; Check there shows when it runs out), paste it, then generate the invite again.</>
          : <>Or set up auto-share in <span className="text-text">Settings → Sync → Tailscale</span> with a personal API access token, then generate the invite again — it attaches a share for you (tokens last at most 90 days; Check shows the date).</>}
      </p>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <button onClick={onClose} className="g-btn g-btn-ghost g-btn-sm">
          Close
        </button>
        <button onClick={onReveal} className="g-btn g-btn-ghost g-btn-sm">
          Show link anyway — they're already on my tailnet
        </button>
      </div>
    </div>
  );
}
