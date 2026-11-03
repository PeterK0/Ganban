import { useEffect, useRef, useState } from 'react';
import type { User } from '../types';
import { verifyUserPin } from '../lib/api';

/** Initials for the picker avatars (profile avatars stay in profile_json). */
function initials(u: User): string {
  return (
    u.full_name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || u.username.slice(0, 2).toUpperCase()
  );
}

/**
 * The launch/profile gate: pick who you are, and prove it with the profile's
 * PIN when one is set. This is a courtesy lock against casual switching on a
 * shared machine — the data lives locally, so it is not cryptographic
 * security — but it stops the app from silently opening as whoever used it
 * last, and from one-click impersonation.
 */
export default function ProfileGate({
  users,
  initialUserId,
  onUnlock,
}: {
  users: User[];
  initialUserId: number | null;
  onUnlock: (userId: number) => void;
}) {
  const initial = users.find((u) => u.id === initialUserId) ?? (users.length === 1 ? users[0] : null);
  const [selected, setSelected] = useState<User | null>(initial);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  // A pin-less profile needs no ceremony — selecting it unlocks directly.
  useEffect(() => {
    if (selected && !selected.has_pin) onUnlock(selected.id);
    else if (selected) pinRef.current?.focus();
  }, [selected, onUnlock]);

  const submit = async () => {
    if (!selected || busy || pin.length < 4) return;
    setBusy(true);
    setError(null);
    try {
      if (await verifyUserPin(selected.id, pin)) {
        onUnlock(selected.id);
      } else {
        setError('Wrong PIN');
        setPin('');
        pinRef.current?.focus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="g-form fixed inset-0 z-50 bg-mantle text-text flex items-center justify-center p-6 overflow-y-auto">
      <div className="g-card g-corners w-full max-w-[420px] px-7 py-8 space-y-6">
        <div className="text-center space-y-2">
          <img src="/logo.svg" alt="" className="w-12 h-12 mx-auto" />
          <h1 className="g-deco text-[24px] font-light tracking-[0.16em] leading-tight">Ganban</h1>
          <p className="text-sm text-subtext-0">
            {selected?.has_pin ? `Enter the PIN for ${selected.full_name}` : 'Who is working?'}
          </p>
        </div>

        {selected?.has_pin ? (
          <div className="space-y-3">
            <input
              ref={pinRef}
              autoFocus
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="PIN"
              className="w-full px-4 py-3 text-center text-2xl tracking-[0.5em] bg-mantle border border-surface-1 rounded focus:outline-none focus:border-gold"
            />
            {error && <p className="text-sm text-error text-center">{error}</p>}
            <button
              onClick={() => void submit()}
              disabled={busy || pin.length < 4}
              className="g-btn g-btn-pri w-full"
            >
              {busy ? 'Checking…' : 'Unlock'}
            </button>
            {users.length > 1 && (
              <button
                onClick={() => {
                  setSelected(null);
                  setPin('');
                  setError(null);
                }}
                className="w-full min-h-[32px] text-sm text-subtext-0 hover:text-text"
              >
                Switch profile
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => setSelected(u)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-mantle border border-surface-0 rounded text-left hover:border-gilt-a hover:bg-gilt-b"
              >
                <span className="g-av w-9 h-9 text-xs">
                  {initials(u)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{u.full_name}</span>
                  <span className="block text-xs text-subtext-0 truncate">@{u.username}</span>
                </span>
                {u.has_pin && <span className="text-subtext-0">🔒</span>}
                {u.is_owner && <span className="g-tag">owner</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
