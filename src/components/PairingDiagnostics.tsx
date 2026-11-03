// A collapsible "what's actually happening?" panel that sits under an invite/
// pair QR. Born from the real pain of staring at a QR with zero feedback —
// is the daemon up? did the share attach? is the address even reachable? did
// they join yet? — and resorting to sending ten addresses to a phone going
// "does it work now?". It surfaces, from signals the host already has:
//   • config & share  — daemon up + port, the exact address baked in, whether a
//                        Tailscale machine-share attached (or the precise error)
//   • reachable?       — a live /health probe of that address from this device
//   • did they join?   — polls the invite token's lifecycle (pending → joined),
//                        the actual "does it work now?" answer
import { useEffect, useRef, useState } from "react";
import { probeHost } from "../lib/daemon";
import { inviteStatus, type InviteStatus } from "../lib/host";
import { isTailnetUrl } from "../lib/invite.pure";

/** Compact relative time: "in 6 days", "in 3h", "2 min ago", "just now". */
function relTime(iso?: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  const past = ms < 0;
  let s = Math.abs(ms) / 1000;
  const unit = (n: number, u: string) => `${Math.round(n)}${u}`;
  let out: string;
  if (s < 45) out = "moments";
  else if (s < 3600) out = unit(s / 60, " min");
  else if (s < 86400) out = unit(s / 3600, "h");
  else out = unit(s / 86400, " days");
  if (out === "moments") return past ? "just now" : "in moments";
  return past ? `${out} ago` : `in ${out}`;
}

function addrKind(url: string): string {
  if (isTailnetUrl(url)) return /\.ts\.net/i.test(url) ? "tailnet (MagicDNS)" : "tailnet";
  if (/^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)) return "local network";
  return "public";
}

/** One status line: a colored dot/glyph + label + detail. */
function Row({ tone, label, detail }: { tone: "ok" | "warn" | "bad" | "wait" | "mute"; label: string; detail?: string }) {
  const glyph = { ok: "✓", warn: "⚠", bad: "✗", wait: "⏳", mute: "·" }[tone];
  const color = {
    ok: "text-success",
    warn: "text-warning",
    bad: "text-error",
    wait: "text-subtext-1",
    mute: "text-subtext-0",
  }[tone];
  return (
    <div className="flex items-start gap-2 text-[11px] leading-relaxed">
      <span className={`${color} w-3 shrink-0 text-center`}>{glyph}</span>
      <span className="text-subtext-1 shrink-0">{label}</span>
      {detail && <span className="text-subtext-0 min-w-0 break-words">{detail}</span>}
    </div>
  );
}

export function PairingDiagnostics({
  url,
  token,
  ts,
  shareError,
  daemonRunning,
  port,
}: {
  /** The host address baked into this invite (bare, e.g. http://host.ts.net:8765). */
  url: string;
  /** The one-time enrollment/invite token (used to poll join status; never shown). */
  token: string;
  /** The attached Tailscale device-share URL, if any. */
  ts?: string | null;
  /** Why a share couldn't attach, if the host tried and failed. */
  shareError?: string | null;
  /** Whether this machine's daemon is hosting (SyncView passes it; optional). */
  daemonRunning?: boolean;
  port?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [reach, setReach] = useState<"idle" | "checking" | "up" | "down">("idle");
  const [status, setStatus] = useState<InviteStatus | null>(null);
  const joined = status?.state === "joined";
  const aliveRef = useRef(true);

  const probe = async () => {
    setReach("checking");
    const ok = await probeHost(url);
    if (aliveRef.current) setReach(ok ? "up" : "down");
  };

  // Only while the panel is open (opt-in, bounded): probe reachability once and
  // poll join-status every 3s, stopping the poll as soon as they've joined.
  useEffect(() => {
    if (!open) return;
    aliveRef.current = true;
    void probe();
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await inviteStatus(token);
        if (!aliveRef.current) return;
        setStatus(s);
        if (s.state === "joined" || s.state === "unknown") {
          stop = true;
          clearInterval(timer);
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => {
      aliveRef.current = false;
      stop = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, url, token]);

  return (
    <div className="border-t border-surface-2 pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-subtext-0 hover:text-subtext-1"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        Diagnostics — what's happening?
        {joined && <span className="text-success">· joined ✓</span>}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5 rounded-lg bg-surface-1 px-3 py-2">
          {/* Did they join? — the "does it work now?" answer, up top. */}
          {status?.state === "joined" ? (
            <Row tone="ok" label="Joined!" detail={`${status.joined_name ? status.joined_name + " · " : ""}${relTime(status.consumed_at)}`} />
          ) : status?.state === "expired" ? (
            <Row tone="bad" label="Link expired." detail="Generate a fresh invite." />
          ) : status?.state === "unknown" ? (
            <Row tone="mute" label="Join status:" detail="not tracked (link may be old)." />
          ) : (
            <Row tone="wait" label="Waiting for them to join…" detail="this updates the moment they do." />
          )}

          {/* Reachability of the baked address from this device. */}
          {reach === "checking" ? (
            <Row tone="wait" label="Reachable?" detail="checking this address…" />
          ) : reach === "up" ? (
            <Row tone="ok" label="Host answered" detail="the daemon is serving at this address." />
          ) : reach === "down" ? (
            <Row tone="bad" label="No answer at this address" detail={isTailnetUrl(url) ? "expected if you're not on the tailnet — the recipient must accept the share first." : "the daemon may be down, or this address isn't reachable from here."} />
          ) : null}

          {/* Config & share. */}
          {daemonRunning !== undefined && (
            <Row tone={daemonRunning ? "ok" : "bad"} label="Daemon:" detail={daemonRunning ? `hosting${port ? ` on port ${port}` : ""}` : "not hosting"} />
          )}
          <Row tone="mute" label="Address:" detail={`${url}  ·  ${addrKind(url)}`} />
          {ts ? (
            <Row tone="ok" label="Tailscale share:" detail="attached — recipient can join from any network." />
          ) : shareError ? (
            <Row tone="warn" label="Tailscale share:" detail={`not attached — ${shareError}`} />
          ) : (
            <Row tone="mute" label="Tailscale share:" detail="none (auto-share off — only reachable on your tailnet)." />
          )}
          {status?.expires_at && status.state !== "joined" && status.state !== "unknown" && (
            <Row tone="mute" label="Expires:" detail={relTime(status.expires_at)} />
          )}

          <button
            onClick={() => void probe()}
            className="mt-1 text-[11px] text-primary hover:underline"
          >
            Re-check reachability
          </button>
        </div>
      )}
    </div>
  );
}
