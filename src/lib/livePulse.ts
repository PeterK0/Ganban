import { useEffect, useRef } from 'react';

/** The window event App/MobileApp dispatch after a debounced host pulse.
 * Views listen via useDataPulse; mobile's useAsync listens globally. */
export const DATA_PULSE_EVENT = 'ganban:data-changed';

/**
 * The coarse "what changed" kinds the server publishes (see
 * `events::invoke_pulse_kind` in crates/server). The server maps every write
 * command to one of these before publishing — never a payload, never a raw
 * command name — so the most a subscriber learns is "some task changed
 * somewhere". `lagged` is the "I missed pulses, refetch wholesale" marker.
 *
 * Subscribers pass a predicate to `useDataPulse` to opt in only to the kinds
 * they actually render. A subscriber that omits the predicate still refetches
 * on every pulse (backward-compatible).
 */
export type PulseKind =
  | 'tasks'
  | 'events'
  | 'projects'
  | 'comments'
  | 'contacts'
  | 'areas'
  | 'time'
  | 'files'
  | 'models' | 'quiz'
  | 'users'
  | 'entities'
  | 'lagged';

/** The custom event detail. `kind` is the server-reported "what changed";
 * always present on real pulses, `lagged` when the SSE stream fell behind. */
export interface DataPulseDetail {
  kind: PulseKind;
}

/**
 * Re-run `refetch` when the host says data changed somewhere (the SSE pulse,
 * already debounced upstream), filtered by `kinds` when supplied.
 *
 * For STORE-LEVEL refetches only — never wire this to anything that remounts
 * views or reseeds form state, or a teammate's edit would eat the user's
 * unsaved keystrokes.
 *
 * `kinds`: when omitted, refetch on every pulse (the original behavior —
 * backward-compatible). When supplied, refetch ONLY when the pulse's kind is in
 * the set. This is the lever that stops a comment edit from refetching the
 * Calendar: the server already classifies every write into a coarse kind
 * (`tasks`, `events`, `comments`, …), so a view that renders only events can
 * ignore a `comments` pulse entirely. `lagged` always passes (it means "I may
 * have missed pulses — refetch wholesale"), so a subscriber never silently
 * goes stale by over-filtering.
 */
export function useDataPulse(refetch: () => void, kinds?: PulseKind[]) {
  const ref = useRef(refetch);
  ref.current = refetch;
  useEffect(() => {
    const h = (e: Event) => {
      // A bare Event (no detail) — e.g. a manual refreshAll dispatch — always
      // passes. The server-routed pulse carries { kind } in the detail.
      const detail = (e as CustomEvent<DataPulseDetail>).detail;
      // `lagged` always passes: it means the SSE stream fell behind and the
      // subscriber may have missed a relevant pulse — refetch wholesale rather
      // than risk going silently stale by over-filtering.
      if (!detail || !kinds || kinds.includes(detail.kind) || detail.kind === 'lagged') {
        ref.current();
      }
    };
    window.addEventListener(DATA_PULSE_EVENT, h);
    return () => window.removeEventListener(DATA_PULSE_EVENT, h);
    // kinds is a static array literal at each call site; deps would re-bind on
    // every render. eslint-disable is correct here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
