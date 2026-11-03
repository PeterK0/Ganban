import { useState, useCallback, useEffect, useRef } from 'react';
import type { Task, Event, Project } from '../types';
import { useNav, pendingRestore, consumeRestore } from '../store/navHistory';

/** Something the right-hand detail pane can show. */
export type DetailTarget =
  | { kind: 'task'; task: Task }
  /** `occurrence`: the day (YYYY-MM-DD) of a repeating event that was opened. */
  | { kind: 'event'; event: Event; occurrence?: string | null }
  | { kind: 'project'; project: Project }
  /** A single calendar day's overview (events + Add). `date` is local YYYY-MM-DD. */
  | { kind: 'day'; date: string; scopeProjectId?: number | null };

export interface DetailStackOptions {
  /** Joins the app's back/forward history under this name (one per view's pane). */
  scope?: string;
  /** A back/forward wants the pane shown (true, with what it reopened) or hidden (false). */
  onShow?: (show: boolean, target?: DetailTarget) => void;
}

/** A browser-like history stack for the right-hand pane: open() pushes (and
 * truncates any forward history), back()/forward() move through it. Lets a
 * clicked linked task open in place and the event be one "back" away.
 *
 * With a `scope`, the pane also reports to the app-level history
 * (store/navHistory): a person's open() is a new place, the pane's own
 * back/forward amends the current one, and an app back/forward that lands on
 * this pane reopens its target. */
export function useDetailStack({ scope, onShow }: DetailStackOptions = {}) {
  const [state, setState] = useState<{ stack: DetailTarget[]; index: number }>({ stack: [], index: -1 });
  const stateRef = useRef(state);
  stateRef.current = state;
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;

  const report = useCallback(
    (target: DetailTarget | null, record: 'push' | 'amend') => {
      if (!scope) return;
      if (target) useNav.getState().openPane({ scope, target }, record);
      else useNav.getState().closePane(scope);
    },
    [scope]
  );

  const openRaw = useCallback((target: DetailTarget) => {
    setState((s) => {
      const stack = [...s.stack.slice(0, s.index + 1), target]; // truncate forward history, push
      return { stack, index: stack.length - 1 };
    });
  }, []);
  /** Show `target`. `record: 'amend'` for opens nobody clicked (an auto-open),
   * 'none' to leave the history alone. */
  const open = useCallback(
    (target: DetailTarget, opts?: { record?: 'push' | 'amend' | 'none' }) => {
      openRaw(target);
      const record = opts?.record ?? 'push';
      if (record !== 'none') report(target, record);
    },
    [openRaw, report]
  );
  // Update the current entry in place (e.g. after an edit) without touching
  // history, so the header/back-forward reflect the saved data.
  const replace = useCallback((target: DetailTarget) => {
    setState((s) => {
      if (s.index < 0) return s;
      const stack = [...s.stack];
      stack[s.index] = target;
      return { stack, index: s.index };
    });
  }, []);
  // Swap in a saved copy of an item wherever the stack holds it (matched by kind
  // and id), whichever entry is current. Safe after the user has moved on: an
  // editor saving on close mustn't overwrite the entry that's now showing.
  const refresh = useCallback((target: DetailTarget) => {
    const idOf = (t: DetailTarget) =>
      t.kind === 'task' ? t.task.id : t.kind === 'event' ? t.event.id : t.kind === 'project' ? t.project.id : t.date;
    setState((s) => {
      if (!s.stack.some((t) => t.kind === target.kind && idOf(t) === idOf(target))) return s;
      // An event keeps the day it was opened on.
      const swap = (t: DetailTarget): DetailTarget =>
        t.kind === 'event' && target.kind === 'event' && target.occurrence === undefined ? { ...t, event: target.event } : target;
      return { ...s, stack: s.stack.map((t) => (t.kind === target.kind && idOf(t) === idOf(target) ? swap(t) : t)) };
    });
  }, []);
  // An event entry became another event (a change to one day of a series made a
  // one-off copy or a new series): swap it wherever the stack holds it.
  const swapEvent = useCallback((fromId: number, event: Event, occurrence: string | null) => {
    setState((s) => {
      if (!s.stack.some((t) => t.kind === 'event' && t.event.id === fromId)) return s;
      return { ...s, stack: s.stack.map((t) => (t.kind === 'event' && t.event.id === fromId ? { kind: 'event', event, occurrence } : t)) };
    });
  }, []);
  const move = useCallback(
    (by: -1 | 1) => {
      const s = stateRef.current;
      const index = Math.max(0, Math.min(s.stack.length - 1, s.index + by));
      if (index === s.index || index < 0) return;
      setState({ ...s, index });
      report(s.stack[index], 'amend');
    },
    [report]
  );
  const back = useCallback(() => move(-1), [move]);
  const forward = useCallback(() => move(1), [move]);
  const close = useCallback(() => {
    setState({ stack: [], index: -1 });
    report(null, 'amend');
  }, [report]);

  // An app back/forward: reopen our target, or step aside for another pane's.
  const restoreSeq = useNav((s) => s.restore?.seq ?? 0);
  useEffect(() => {
    if (!scope) return;
    const r = pendingRestore(scope);
    if (!r) return;
    consumeRestore(scope);
    const pane = r.entry.pane;
    if (pane?.scope === scope) {
      openRaw(pane.target);
      onShowRef.current?.(true, pane.target);
    } else if (scope === 'search') {
      setState({ stack: [], index: -1 }); // the search drawer floats over every view
    } else if (!pane) {
      onShowRef.current?.(false);
    }
  }, [restoreSeq, scope, openRaw]);

  const current = state.index >= 0 && state.index < state.stack.length ? state.stack[state.index] : null;
  return {
    current,
    canBack: state.index > 0,
    canForward: state.index >= 0 && state.index < state.stack.length - 1,
    open,
    replace,
    refresh,
    swapEvent,
    back,
    forward,
    close,
  };
}

export type DetailController = ReturnType<typeof useDetailStack>;
