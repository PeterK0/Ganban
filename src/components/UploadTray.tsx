import { useEffect, useMemo, useRef, useState } from 'react';
import ScrollArea from './ScrollArea';
import {
  cancelAllUploads,
  cancelUpload,
  clearFinishedUploads,
  canRetry,
  fmtBytes,
  retryFailedUploads,
  isActive,
  useUploads,
  type UploadItem,
} from '../lib/uploads';

/**
 * Where uploads show: overall progress, speed and time left, and each file
 * with its own bar and a cancel. On desktop that's the Uploads section of the
 * avatar pop-up ({@link UploadsSection}); on mobile, a panel in the corner
 * ({@link UploadTray}). A clean finish clears itself after a few seconds (the
 * bell keeps the summary; lib/uploads.ts), failures stay until dismissed.
 */
function useUploadOverview() {
  const items = useUploads((s) => s.items);
  const visible = items.filter((i) => i.status !== 'cancelled' || items.some(isActive));
  const active = items.filter(isActive);
  const failed = items.filter((i) => i.status === 'error');
  // Totals cover what is (or will be) on the host — not cancelled/failed files.
  const counted = items.filter((i) => i.status !== 'cancelled' && i.status !== 'error');
  const total = counted.reduce((s, i) => s + i.size, 0);
  const sent = counted.reduce((s, i) => s + (i.status === 'done' ? i.size : i.sent), 0);
  const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  const rate = useRate(active.length > 0 ? sent : null);
  const doneCount = counted.filter((i) => i.status === 'done').length;
  const title =
    active.length > 0
      ? `Uploading ${counted.length} file${counted.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} done` : ''}`
      : failed.length > 0
        ? `${failed.length} upload${failed.length === 1 ? '' : 's'} failed`
        : `${doneCount} upload${doneCount === 1 ? '' : 's'} complete`;
  const eta = active.length > 0 && rate > 0 ? (total - sent) / rate : null;
  // Nothing counted (every file failed or was cancelled): no totals to show.
  const stats = total === 0 ? '' : `${fmtBytes(sent)} of ${fmtBytes(total)}${active.length > 0 && rate > 0 ? ` · ${fmtBytes(rate)}/s` : ''}${eta != null ? ` · ${fmtEta(eta)} left` : ''}`;
  const tone: 'primary' | 'success' | 'error' = failed.length > 0 && active.length === 0 ? 'error' : active.length > 0 ? 'primary' : 'success';
  const glyph = active.length > 0 ? '⬆️' : failed.length > 0 ? '⚠️' : '✅';
  const retryable = failed.filter(canRetry).length;
  return { visible, active, pct, title, stats, tone, glyph, hasTotals: total > 0, retryable };
}

/** Run the failed files again: one bad file never stops the rest, and this
 * picks up the ones that failed. */
function RetryButton({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <button onClick={() => retryFailedUploads()} className="g-btn g-btn-sm g-btn-gilt" title="Upload the failed files again">
      Retry {count === 1 ? 'failed' : `${count} failed`}
    </button>
  );
}

/** Each file with its bar, and Cancel all while more than one runs. */
function UploadFiles({ visible, active }: { visible: UploadItem[]; active: UploadItem[] }) {
  return (
    <>
      {/* ScrollArea's viewport is h-full: it needs a real height, not a max. */}
      <div style={{ height: Math.min(256, visible.reduce((h, i) => h + (i.error ? 70 : 52), 16)) }}>
        <ScrollArea className="h-full" contentClassName="px-3.5 py-2 space-y-2.5">
          {visible.map((i) => (
            <Row key={i.id} item={i} />
          ))}
        </ScrollArea>
      </div>
      {active.length > 1 && (
        <div className="px-3.5 py-2 border-t border-gilt-b flex justify-end">
          <button onClick={cancelAllUploads} className="g-btn g-btn-sm g-btn-danger">
            Cancel all
          </button>
        </div>
      )}
    </>
  );
}

/** The Uploads section of the avatar pop-up (desktop). Renders nothing when
 * there's nothing to show. */
export function UploadsSection() {
  const { visible, active, pct, title, stats, tone, glyph, hasTotals, retryable } = useUploadOverview();
  if (visible.length === 0) return null;
  return (
    <div className="border-b border-gilt-b bg-mantle" role="status" aria-live="polite">
      <div className="px-4 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-base">{glyph}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text truncate">{title}</div>
            {stats && <div className="text-[11px] text-subtext-0 tabular-nums">{stats}</div>}
          </div>
          {hasTotals && <span className="text-sm font-semibold text-text tabular-nums">{pct}%</span>}
          <RetryButton count={retryable} />
          {active.length === 0 && (
            <button onClick={clearFinishedUploads} className="g-btn g-btn-sm g-btn-ghost !shadow-none" title="Clear the finished uploads">
              Clear
            </button>
          )}
        </div>
        <Bar pct={pct} tone={tone} />
      </div>
      <div className="border-t border-gilt-b">
        <UploadFiles visible={visible} active={active} />
      </div>
    </div>
  );
}

/** The upload panel in the corner (mobile): appears only when there's
 * something to show, expands to the file list. */
export default function UploadTray({ mobile = false }: { mobile?: boolean }) {
  const { visible, active, pct, title, stats, tone, glyph, hasTotals, retryable } = useUploadOverview();
  const [expanded, setExpanded] = useState(false);
  if (visible.length === 0) return null;

  return (
    <div
      className={`fixed z-[60] right-4 ${mobile ? 'bottom-20 left-4' : 'bottom-4 w-[380px]'} g-card g-corners shadow-2xl overflow-hidden`}
      role="status"
      aria-live="polite"
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">{glyph}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text truncate">{title}</div>
            {stats && <div className="text-[11px] text-subtext-0 tabular-nums">{stats}</div>}
          </div>
          {hasTotals && <span className="text-sm font-semibold text-text tabular-nums">{pct}%</span>}
          <RetryButton count={retryable} />
          <button
            onClick={() => setExpanded((x) => !x)}
            className="g-iconbtn !w-8 !h-8"
            title={expanded ? 'Hide the files' : 'Show the files'}
            aria-expanded={expanded}
          >
            {expanded ? '▾' : '▴'}
          </button>
          {active.length === 0 && (
            <button
              onClick={clearFinishedUploads}
              className="g-iconbtn !w-8 !h-8"
              title="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
        <Bar pct={pct} tone={tone} />
      </div>
      {expanded && (
        <div className="border-t border-gilt-b">
          <UploadFiles visible={visible} active={active} />
        </div>
      )}
    </div>
  );
}

function Row({ item }: { item: UploadItem }) {
  const pct = item.size ? Math.min(100, Math.round(((item.status === 'done' ? item.size : item.sent) / item.size) * 100)) : 0;
  const status =
    item.status === 'queued'
      ? 'Waiting'
      : item.status === 'uploading'
        ? `${pct}%`
        : item.status === 'done'
          ? '✓'
          : item.status === 'cancelled'
            ? 'Cancelled'
            : 'Failed';
  return (
    <div>
      <div className="flex items-center gap-2 text-xs">
        <span className="flex-1 min-w-0 truncate text-text" title={item.name}>
          {item.name}
        </span>
        <span
          className={`shrink-0 tabular-nums ${item.status === 'error' ? 'text-error' : item.status === 'done' ? 'text-success' : 'text-subtext-0'}`}
        >
          {status}
        </span>
        {isActive(item) && (
          <button onClick={() => cancelUpload(item.id)} className="shrink-0 text-subtext-0 hover:text-error" title="Cancel this upload">
            ✕
          </button>
        )}
      </div>
      <div className="text-[10px] text-subtext-0 truncate">
        {fmtBytes(item.size)}
        {item.target && ` → ${item.target}`}
      </div>
      {item.error && (
        <div className="text-[11px] text-error leading-snug mt-0.5 break-words" title={item.error}>
          {item.error}
        </div>
      )}
      {item.status !== 'cancelled' && item.status !== 'error' && (
        <Bar pct={pct} tone={item.status === 'done' ? 'success' : 'primary'} thin muted={item.status === 'queued'} />
      )}
    </div>
  );
}

function Bar({ pct, tone, thin, muted }: { pct: number; tone: 'primary' | 'success' | 'error'; thin?: boolean; muted?: boolean }) {
  const color = tone === 'success' ? 'bg-success' : tone === 'error' ? 'bg-error' : 'bg-gold';
  return (
    <div className={`mt-1.5 w-full rounded-full bg-surface-0 overflow-hidden ${thin ? 'h-1' : 'h-1.5'} ${muted ? 'opacity-50' : ''}`}>
      <div className={`h-full ${color} transition-[width] duration-300 ease-out`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Bytes per second over the last few seconds (null = idle → reset). */
function useRate(sent: number | null): number {
  const samples = useRef<{ t: number; b: number }[]>([]);
  const [rate, setRate] = useState(0);
  useEffect(() => {
    if (sent == null) {
      samples.current = [];
      setRate(0);
      return;
    }
    const now = Date.now();
    const s = samples.current;
    s.push({ t: now, b: sent });
    while (s.length > 2 && now - s[0].t > 4000) s.shift();
    if (s.length >= 2) {
      const dt = (s[s.length - 1].t - s[0].t) / 1000;
      if (dt > 0.3) setRate(Math.max(0, (s[s.length - 1].b - s[0].b) / dt));
    }
  }, [sent]);
  return useMemo(() => rate, [rate]);
}

function fmtEta(sec: number): string {
  if (!isFinite(sec)) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
