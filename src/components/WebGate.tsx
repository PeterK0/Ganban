// Enrollment gate for the DESKTOP shell running in a plain browser.
//
// A browser client is served by the daemon, so the host is simply this page's
// origin — there is no URL to type and no QR to scan (no camera plugin). What
// it may still need is a device token: the host machine's own browser is the
// owner over loopback and sails through, while a remote member enrolls once,
// either from an invite link (?invite=<token>) or by pasting a pairing code.
//
// The touch shell has its own gate inside MobileApp (with the native scanner);
// this is the same handshake wearing desktop chrome. If a third shell ever
// needs it, promote the effect below into a shared hook.

import { useEffect, useRef, useState } from 'react';
import ThemeProvider from './ThemeProvider';
import { extractEnrollToken } from '../lib/invite.pure';
import QrScanner from './QrScanner';
import { isStandaloneDisplay } from '../lib/shell';
import { buildLabel } from '../lib/build';
import {
  enrollDevice,
  getDeviceToken,
  getMe,
  inviteTokenFromUrl,
  isUnauthorized,
  setUnauthorizedHandler,
} from '../lib/daemon';

export default function WebGate({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(() => inviteTokenFromUrl() ?? '');
  // Three different reasons to not be "in", three different screens:
  //   unreachable — I couldn't ASK the host (restarting, proxy down). The token
  //                 is intact; show retry, never the Join card.
  //   signedOut   — the host REJECTED a token I had (revoked / account removed).
  //                 Say so; the Join card is the way back in.
  //   (neither)   — a fresh visitor: the Join card.
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const standalone = isStandaloneDisplay();
  // Whatever was pasted — bare code, invite/pairing link, or QR text — as a token.
  const pastedToken = extractEnrollToken(code);
  const [scanning, setScanning] = useState(false);
  const [name, setName] = useState('');
  const autoTried = useRef(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const probe = async () => {
    setChecking(true);
    setUnreachable(null);
    const hadToken = !!getDeviceToken();
    try {
      await getMe(); // loopback owner, or a still-valid device token
      setConnected(true);
    } catch (e) {
      if (isUnauthorized(e)) {
        if (hadToken) setSignedOut(true); // daemonFetch already dropped the token
      } else {
        setUnreachable(e instanceof Error ? e.message : String(e));
      }
    }
    setChecking(false);
  };

  useEffect(() => {
    // A 401 during normal use → token cleared → route back here, and say why.
    setUnauthorizedHandler(() => {
      setSignedOut(true);
      setConnected(false);
    });
    void probe();
    return () => setUnauthorizedHandler(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const join = async (token: string, displayName?: string) => {
    setBusy(true);
    setError(null);
    try {
      await enrollDevice(origin, token.trim(), browserLabel(), displayName?.trim() || undefined);
      await getMe();
      setConnected(true);
      // Don't leave a spent invite token in the address bar.
      if (inviteTokenFromUrl()) window.history.replaceState({}, '', window.location.pathname);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // An invite link carries everything needed — enrol without making the member
  // read a form first. Only once, and only if the probe said we're not in.
  useEffect(() => {
    const token = inviteTokenFromUrl();
    if (!checking && !connected && token && !autoTried.current) {
      autoTried.current = true;
      void join(token);
    }
  }, [checking, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) {
    return (
      <ThemeProvider>
        <div className="h-screen w-screen bg-mantle flex items-center justify-center">
          <span className="text-subtext-0 text-sm animate-pulse">Connecting…</span>
        </div>
      </ThemeProvider>
    );
  }

  if (connected) return <>{children}</>;

  if (unreachable) {
    return (
      <ThemeProvider>
        <div className="h-screen w-screen bg-mantle flex items-center justify-center p-6 overflow-y-auto">
          <div className="g-card g-corners w-full max-w-[420px] px-7 py-8 space-y-3 text-center">
            <img src="/logo.svg" alt="" className="w-12 h-12 mx-auto mb-3" />
            <h1 className="g-deco text-[22px] font-light tracking-[0.16em] leading-tight text-text">Can't reach the host</h1>
            <p className="text-xs text-subtext-0 break-all">{origin}</p>
            <p className="text-sm text-error break-words">{unreachable}</p>
            <p className="text-sm text-subtext-1">
              {getDeviceToken() ? 'This device is still signed in — nothing to re-pair. ' : ''}
              The host may be restarting or offline. Try again in a moment.
            </p>
            <button
              onClick={() => void probe()}
              className="g-btn g-btn-pri w-full min-h-[44px]"
            >
              Retry
            </button>
          </div>
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <div className="g-form h-screen w-screen bg-mantle flex items-center justify-center p-6 overflow-y-auto">
        <div className="g-card g-corners w-full max-w-[420px] px-7 py-8 my-auto">
          <img src="/logo.svg" alt="" className="w-12 h-12 mx-auto mb-3" />
          <h1 className="g-deco text-[22px] font-light tracking-[0.16em] leading-tight text-text text-center">Join this Ganban</h1>
          <p className="text-xs text-subtext-0 mt-1 break-all text-center">{origin}</p>
          {signedOut && (
            <p className="mt-3 text-sm text-warning bg-warning/10 border border-warning/30 rounded px-3 py-2">
              This device was signed out by the host — its access was revoked, or the account was removed. Pair again to
              continue.
            </p>
          )}
          {standalone && !inviteTokenFromUrl() && (
            <div className="mt-3 text-sm bg-gilt-b border border-gilt-a rounded px-3 py-2.5 space-y-1.5">
              <p className="font-medium text-text">This is Ganban from your Home Screen</p>
              <p className="text-subtext-1">
                It's a separate app with its own sign-in. In your browser, open Ganban →{' '}
                <span className="text-text">Settings → Profile → Your devices → Pair another device</span>, copy the code, and paste it
                below.
              </p>
            </div>
          )}
          <p className="text-sm text-subtext-1 mt-4">
            Paste the code or link you were given — an invite from the owner, or a pairing code from a device where you're
            already signed in.
          </p>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (pastedToken && !busy) void join(pastedToken, name);
            }}
          >
            <div>
              <label className="g-flbl">Invite or pairing code (a link works too)</label>
              <div className="flex gap-2">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoFocus
                  className="flex-1 min-w-0 min-h-[44px] px-3 py-2 rounded bg-surface-1 border border-surface-2 text-text text-sm font-mono"
                  placeholder="paste the code or link"
                />
                <button
                  type="button"
                  onClick={() => setScanning(true)}
                  className="g-btn g-btn-ghost shrink-0 min-h-[44px]"
                  title="Scan the QR code the owner is showing you"
                >
                  Scan QR
                </button>
              </div>
            </div>
            <div>
              <label className="g-flbl">Your name (new members only)</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full min-h-[44px] px-3 py-2 rounded bg-surface-1 border border-surface-2 text-text text-sm"
                placeholder="optional"
              />
            </div>
            {error && <p className="text-xs text-error break-words">{error}</p>}
            {code.trim() && !pastedToken && (
              <p className="text-xs text-error">That doesn't look like a code or a Ganban link.</p>
            )}
            <button
              type="submit"
              disabled={busy || !pastedToken}
              className="g-btn g-btn-pri w-full min-h-[44px]"
            >
              {busy ? 'Joining…' : 'Join'}
            </button>
          </form>
          {scanning && (
            <QrScanner
              onClose={() => setScanning(false)}
              onResult={(text) => {
                setScanning(false);
                const t = extractEnrollToken(text);
                if (!t) {
                  setCode(text);
                  setError("That QR isn't a Ganban invite or pairing code.");
                  return;
                }
                setCode(t);
                void join(t, name);
              }}
            />
          )}
          {/* The way back in. A device token is per-device; the ACCOUNT lives
              on the host. Without this note a locked-out member has no idea
              their account is one code away. */}
          <div className="mt-5 pt-4 border-t border-gilt-b text-xs text-subtext-0 space-y-1.5">
            <p className="text-subtext-1 font-medium">Already a member?</p>
            <p>
              On a device where you're still signed in: <span className="text-text">Settings → Profile → Your devices → Pair another device</span>,
              then paste that code here. You'll be you — same projects, same history.
            </p>
            <p>
              No signed-in device left? Ask the host's owner — <span className="text-text">Members → you → Pair a device</span> (or Contacts). It
              signs you in as your existing account.
            </p>
            {!standalone && <p>iPhone: a Ganban added to the Home Screen has its own sign-in. Pair it with a code from your Safari tab.</p>}
            <p className="pt-2 text-[10px] font-mono opacity-70">build {buildLabel()}</p>
          </div>
        </div>
      </div>
    </ThemeProvider>
  );
}

/** A human-readable device label so the host's device list isn't all "browser". */
function browserLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /chrome\//i.test(ua) ? 'Chrome'
    : /firefox\//i.test(ua) ? 'Firefox'
    : /safari\//i.test(ua) ? 'Safari'
    : 'Browser';
  const os = /windows/i.test(ua) ? 'Windows'
    : /mac os x/i.test(ua) ? 'macOS'
    : /linux/i.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
