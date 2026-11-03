// "Your devices" — the member-side half of device pairing. Lists every device
// enrolled as this user, marks the one you're on, lets you revoke the others
// (or this one, with a warning), and mints a one-time code to bring your
// account to another device. Shared by the desktop shell (Settings → Profile)
// and the touch shell (Account) — same handshake, two chromes.

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { listMyDevices, revokeMyDevice, pairAnotherDevice, type DeviceInfo, type PairingCode } from '../lib/devices';
import { confirmDialog } from '../lib/confirm';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export default function YourDevices({ compact = false, onSignedOutHere }: { compact?: boolean; onSignedOutHere?: () => void }) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const load = async () => {
    try {
      setDevices(await listMyDevices());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDevices([]);
    }
  };
  useEffect(() => { void load(); }, []);

  const revoke = async (d: DeviceInfo) => {
    const label = d.device_label || 'this device';
    const msg = d.current
      ? `Sign out ${label} — the device you're using right now? You'll need a pairing code to get back in.`
      : `Remove ${label}? It will be signed out and need a new pairing code.`;
    if (!(await confirmDialog(msg))) return;
    try {
      await revokeMyDevice(d.id);
      if (d.current) onSignedOutHere?.();
      else await load();
    } catch (e) {
      alert(`Couldn't remove device: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const mint = async () => {
    setMinting(true);
    try {
      setPairing(await pairAnotherDevice());
    } catch (e) {
      alert(`Couldn't create a pairing code: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMinting(false);
    }
  };

  // Web Share (phones, and desktop Chrome/Safari): the link straight to AirDrop /
  // Messages / Notes — the natural bridge from a phone to a laptop.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = async () => {
    if (!pairing) return;
    try {
      await navigator.share({ title: 'Sign in to Ganban as me', text: 'Open this in Ganban (Join a project → paste), or in a browser.', url: pairing.link });
    } catch (e) {
      // AbortError = the person closed the sheet; anything else is worth showing.
      if ((e as { name?: string })?.name !== 'AbortError') setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async (what: 'code' | 'link') => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(what === 'code' ? pairing.code : pairing.link);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — the text is selectable below */
    }
  };

  const pad = compact ? 'px-4' : '';
  const row = compact ? 'px-4 py-3 border-b border-surface-2' : 'px-3 py-2 rounded-lg border border-surface-2 bg-surface-1';

  return (
    <div className={compact ? '' : 'space-y-3'}>
      {error && <p className={`text-xs text-error ${pad}`}>Couldn't load devices: {error}</p>}
      <div className={compact ? '' : 'space-y-1.5'}>
        {devices === null && <p className={`text-xs text-subtext-0 ${pad}`}>Loading…</p>}
        {devices?.map((d) => (
          <div key={d.id} className={`flex items-center gap-3 ${row}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text truncate">
                {d.device_label || 'Unnamed device'}
                {d.current && <span className="ml-2 text-[10px] uppercase tracking-wide text-primary font-semibold">this device</span>}
              </div>
              <div className="text-[11px] text-subtext-0">last seen {ago(d.last_seen_at)} · added {new Date(d.created_at).toLocaleDateString()}</div>
            </div>
            <button onClick={() => void revoke(d)} className="text-xs text-subtext-0 hover:text-error shrink-0" title={d.current ? 'Sign out here' : 'Remove this device'}>
              {d.current ? 'Sign out' : 'Remove'}
            </button>
          </div>
        ))}
      </div>

      <div className={`${pad} ${compact ? 'py-3' : ''}`}>
        {!pairing ? (
          <button
            onClick={() => void mint()}
            disabled={minting}
            className="g-btn g-btn-pri g-btn-sm"
          >
            {minting ? 'Creating code…' : '+ Pair another device'}
          </button>
        ) : (
          <div className="g-inset p-3 space-y-3">
            <p className="text-xs text-subtext-1">
              This signs another device in as <span className="text-text">you</span>. One use, expires in 24 h.
            </p>
            <div className="flex gap-3 items-start">
              <div className="bg-white p-1.5 rounded-lg shrink-0">
                <QRCodeSVG value={pairing.qr} size={compact ? 112 : 128} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <div className="g-flbl text-[10px] mb-0.5">Code</div>
                  <div className="flex items-center gap-2">
                    <code className="text-[11px] font-mono text-text break-all select-all flex-1">{pairing.code}</code>
                    <button onClick={() => void copy('code')} className="text-xs text-primary shrink-0">{copied === 'code' ? 'Copied' : 'Copy'}</button>
                  </div>
                </div>
                <div>
                  <div className="g-flbl text-[10px] mb-0.5">Link</div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-subtext-1 break-all select-all flex-1">{pairing.link}</span>
                    <button onClick={() => void copy('link')} className="text-xs text-primary shrink-0">{copied === 'link' ? 'Copied' : 'Copy'}</button>
                  </div>
                </div>
              </div>
            </div>
            {/* The same credential, four doors — say which door for which device,
                because "open the link" on a Mac opens a BROWSER, not the app. */}
            <div className="text-[11px] text-subtext-0 space-y-1">
              <div className="text-[10px] uppercase tracking-wide">Where to use it</div>
              <p><span className="text-subtext-1">Computer with the Ganban app</span> — open Ganban → <span className="text-text">Join a project</span> (sidebar, or the first-run screen) → paste the <em>link</em>.</p>
              <p><span className="text-subtext-1">Computer, browser only</span> — just open the link.</p>
              <p><span className="text-subtext-1">iPhone Home Screen app</span> — it's a separate app to iOS with its own sign-in: paste the <em>code</em> (or the link) on its Join screen, or tap Scan QR there.</p>
              <p><span className="text-subtext-1">Android Ganban app</span> — scan the QR.</p>
            </div>
            <div className="flex items-center gap-3">
              {canShare && (
                <button
                  onClick={() => void share()}
                  className="g-btn g-btn-pri g-btn-sm"
                  title="AirDrop, Messages, Notes… straight to the other device"
                >
                  Share link…
                </button>
              )}
              <button onClick={() => setPairing(null)} className="text-xs text-subtext-0 hover:text-text">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
