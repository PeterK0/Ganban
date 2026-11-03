// Persistence for the secretary conversation. The endpoint is stateless by
// design (the client replays history each turn) — so the CLIENT owns the
// thread, and losing it on every navigation made multi-turn work with Donna
// impossible (field, 2026-07-30). localStorage: survives navigation AND
// restarts; capped so an eternal thread can't bloat the profile.

export interface SecretaryMsg {
  role: 'user' | 'assistant';
  content: string;
}

const KEY = 'ganban:secretary-thread';
const MAX_TURNS = 60; // messages kept client-side; the server replays last 20

export function loadSecretaryThread(): SecretaryMsg[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (m): m is SecretaryMsg =>
        m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    );
  } catch {
    return [];
  }
}

export function saveSecretaryThread(msgs: SecretaryMsg[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(msgs.slice(-MAX_TURNS)));
  } catch {
    /* quota — losing persistence beats crashing the send */
  }
}

export function clearSecretaryThread(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
