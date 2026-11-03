import { useEffect, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import {
  listCalendarSubscriptions,
  createCalendarSubscription,
  syncCalendarSubscription,
  deleteCalendarSubscription,
} from '../lib/daemon';
import type { CalendarSubscription, CalendarSyncResult } from '../types';
import ScrollArea from './ScrollArea';
import { Modal } from './gilt';

const MUTED = 'text-[color:var(--g-mut)]';

const SWATCHES = ['#89b4fa', '#a6e3a1', '#f9e2af', '#fab387', '#f38ba8', '#cba6f7', '#94e2d5'];

function relTime(iso?: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return 'never';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString();
}

/** Owner-only manager for imported calendar feeds (ICS/webcal). Adding or
 * syncing a feed pulls its events into the calendar as UNALLOCATED events the
 * user then assigns to projects/tasks via the event editor. */
export default function CalendarSubscriptionsModal({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [subs, setSubs] = useState<CalendarSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState<string>(SWATCHES[0]);
  const [busy, setBusy] = useState(false);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    listCalendarSubscriptions()
      .then(setSubs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const summarize = (r: CalendarSyncResult) =>
    r.ok ? `Imported ${r.total ?? 0} events (${r.added ?? 0} new)` : `Sync failed: ${r.error ?? 'unknown error'}`;

  const add = async () => {
    if (!name.trim() || !url.trim() || busy) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const { sync } = await createCalendarSubscription({ name: name.trim(), url: url.trim(), color });
      // The subscription is created even when the fetch fails (sync.ok=false);
      // surface that as an error, not a success flash.
      if (sync.ok) {
        setName('');
        setUrl('');
        setFlash(summarize(sync));
      } else {
        setError(summarize(sync));
      }
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sync = async (id: number) => {
    setSyncingId(id);
    setError(null);
    setFlash(null);
    try {
      const r = await syncCalendarSubscription(id);
      if (r.ok) setFlash(summarize(r));
      else setError(summarize(r));
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingId(null);
    }
  };

  const remove = async (s: CalendarSubscription) => {
    if (!await confirmDialog(`Remove "${s.name}"? Its imported events stay as normal events (any you allocated are kept).`)) return;
    try {
      await deleteCalendarSubscription(s.id);
      load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal onClose={onClose} title="Imported calendars" className="w-[560px]">
      <p className={`px-8 -mt-2 pb-4 text-[13px] text-center ${MUTED}`}>
        Subscribe to an ICS/webcal feed. Events import unallocated — open one to assign it to a project or tasks.
      </p>

      <ScrollArea className="flex-1 min-h-0 border-t border-gilt-b" contentClassName="px-6 py-5 space-y-4">
        {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded px-3 py-2">{error}</div>}
        {flash && <div className="text-sm text-success bg-success/10 border border-success/30 rounded px-3 py-2">{flash}</div>}

        {/* Existing subscriptions */}
        {loading ? (
          <p className={`text-sm ${MUTED}`}>Loading…</p>
        ) : subs.length === 0 ? (
          <p className={`text-sm italic text-center ${MUTED}`}>No calendars imported yet.</p>
        ) : (
          <div className="space-y-2">
            {subs.map((s) => (
              <div key={s.id} className="g-plain flex items-center gap-3 px-3.5 py-2.5">
                <span className="g-gem" style={{ background: s.color || '#89b4fa' }} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text font-semibold truncate">{s.name}</div>
                  <div className={`text-xs truncate ${MUTED}`} title={s.url}>{s.url}</div>
                  <div
                    className={`text-[11px] mt-0.5 ${
                      s.last_status?.startsWith('error') ? 'text-error' : MUTED
                    }`}
                  >
                    {s.last_status ?? 'not synced'} · {relTime(s.last_synced_at)}
                  </div>
                </div>
                <button
                  onClick={() => sync(s.id)}
                  disabled={syncingId === s.id}
                  className="g-btn g-btn-gilt g-btn-sm shrink-0"
                >
                  {syncingId === s.id ? 'Syncing…' : 'Sync'}
                </button>
                <button
                  onClick={() => remove(s)}
                  className="g-iconbtn !w-8 !h-8 shrink-0 hover:!text-error"
                  title="Remove"
                  aria-label={`Remove ${s.name}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add form */}
        <div className="border-t border-gilt-b pt-4 space-y-2.5">
          <div className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)]">Add a calendar</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. University timetable)"
            className="g-field"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="https://… .ics  (or webcal://…)"
            className="g-field"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-8 h-8 inline-flex items-center justify-center rounded ${color === c ? 'bg-gilt-b shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : 'hover:bg-surface-0'}`}
                  title="Pick a colour"
                  aria-label={`Colour ${c}`}
                  aria-pressed={color === c}
                >
                  <span className="g-gem !w-2.5 !h-2.5" style={{ background: c }} />
                </button>
              ))}
            </div>
            <button
              onClick={add}
              disabled={!name.trim() || !url.trim() || busy}
              className="g-btn g-btn-pri g-glint"
            >
              {busy ? 'Importing…' : 'Add & import'}
            </button>
          </div>
        </div>
      </ScrollArea>
      {/* Last in the DOM so the first field, not Close, takes the opening focus. */}
      <button onClick={onClose} className="g-iconbtn absolute top-[22px] right-[22px] !w-8 !h-8" aria-label="Close" title="Close">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </Modal>
  );
}
