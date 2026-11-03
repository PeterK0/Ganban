// Event-reminder preferences + memory. Device-local on purpose: how loudly a
// machine nags you is a property of the machine, not the account.

/** When (if ever) to send the "X is tomorrow" heads-up. */
export type TomorrowPolicy = 'off' | 'evening' | 'all';

const POLICY_KEY = 'ganban:reminder-tomorrow-policy';
const DAYOF_KEY = 'ganban:reminder-day-of';
const SEEN_KEY = 'ganban:event-reminders-seen';

/** Default OFF — day-before reminders were the #1 noise complaint. */
export function getTomorrowPolicy(): TomorrowPolicy {
  const v = localStorage.getItem(POLICY_KEY);
  return v === 'evening' || v === 'all' ? v : 'off';
}
export function setTomorrowPolicy(p: TomorrowPolicy): void {
  localStorage.setItem(POLICY_KEY, p);
}

/** The "X is today at 15:00" morning reminder (time-proximate 1h/15m ones are unaffected). */
export function getDayOfEnabled(): boolean {
  return localStorage.getItem(DAYOF_KEY) !== '0';
}
export function setDayOfEnabled(on: boolean): void {
  localStorage.setItem(DAYOF_KEY, on ? '1' : '0');
}

// ── Persistent "already reminded" memory ────────────────────────────────────
// The old seen-set lived in a useRef: every app launch re-fired the whole
// week's reminders — THE bombardment. Persist id→timestamp, prune after 8 days
// (the longest-lived id, `-tomorrow`, is stale after 2).

function loadSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function wasReminded(id: string): boolean {
  return loadSeen()[id] !== undefined;
}

export function markReminded(id: string): void {
  const seen = loadSeen();
  seen[id] = Date.now();
  const cutoff = Date.now() - 8 * 24 * 3.6e6;
  for (const [k, ts] of Object.entries(seen)) {
    if (ts < cutoff) delete seen[k];
  }
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* quota — reminders degrade to per-session dedup, never crash */
  }
}
