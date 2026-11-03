import { useEffect, useRef, useState } from 'react';
import { useNotifications, notify, type Notif, type NotifCategory } from '../store/notifications';
import { getNotifications, markNotificationsRead } from '../lib/api';
import { useAppStore } from '../store/appStore';
import {
  listIndexJobs,
  listPendingProposals,
  executeProposal,
  rejectProposal,
  DaemonError,
  type IndexJob,
  type PendingProposal,
} from '../lib/daemon';
import { parseProfile } from '../lib/profile';
import { useUploadSummary } from '../lib/uploads';
import type { User } from '../types';
import { UploadsSection } from './UploadTray';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

const KIND_GLYPH: Record<Notif['kind'], string> = { info: 'ℹ️', success: '✅', error: '⚠️', progress: '⏳' };

const TABS: { id: 'all' | NotifCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'task', label: 'Tasks' },
  { id: 'event', label: 'Events' },
  { id: 'comment', label: 'Comments' },
  { id: 'system', label: 'System' },
];

/** Compact age for a proposal card. */
function proposalAge(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Render a proposal's before/after payload for human review. JSON, but
 * de-noised: the {before, after} wrapper becomes labelled sections. */
function formatProposalDetails(details: unknown): string {
  const d = details as { before?: unknown; after?: unknown } | null;
  const dump = (v: unknown) => JSON.stringify(v, null, 1);
  if (d && typeof d === 'object' && ('before' in d || 'after' in d)) {
    const parts: string[] = [];
    if (d.before !== undefined && d.before !== null) parts.push(`— before —\n${dump(d.before)}`);
    if (d.after !== undefined && d.after !== null) parts.push(`— after —\n${dump(d.after)}`);
    if (parts.length > 0) return parts.join('\n\n');
  }
  return dump(details);
}

/** Pending gated writes, resolvable RIGHT HERE — the popover is the one
 * place your eye already goes when something wants attention. Same durable
 * proposals, same gate as chat cards and the Activity inbox; approving here
 * lands the change identically. Polls only while the popover is open. */
function ProposalsInbox({ onChanged }: { onChanged: () => void }) {
  const [pending, setPending] = useState<PendingProposal[]>([]);
  const [busy, setBusy] = useState<Record<number, 'applying' | 'rejecting'>>({});
  const [err, setErr] = useState<string | null>(null);
  // Which cards are expanded to their full before/after details — approving
  // an agent's write from a one-line summary alone is rubber-stamping.
  const [open, setOpen] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const p = await listPendingProposals();
        if (alive) setPending(p);
      } catch {
        /* host unreachable — the section just doesn't render */
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const resolve = async (p: PendingProposal, action: 'approve' | 'reject') => {
    setBusy((b) => ({ ...b, [p.id]: action === 'approve' ? 'applying' : 'rejecting' }));
    setErr(null);
    try {
      if (action === 'approve') await executeProposal(p.id);
      else await rejectProposal(p.id);
      setPending((ps) => ps.filter((x) => x.id !== p.id));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => {
        const { [p.id]: _gone, ...rest } = b;
        return rest;
      });
    }
  };

  if (pending.length === 0) return null;
  return (
    <div className="border-b border-surface-2">
      <div className="px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
        Awaiting approval ({pending.length})
      </div>
      {err && <p className="px-4 pb-1 text-xs text-error">{err}</p>}
      <div className="max-h-72 overflow-y-auto">
        {/* Newest first — "which of these just came in?" must be answerable. */}
        {[...pending].reverse().map((p) => (
          <div key={p.id} className="px-4 py-2 border-t border-surface-2/60 first:border-t-0">
            <div className="flex items-baseline gap-2">
              <div className="text-sm text-text flex-1 min-w-0">{p.summary}</div>
              <span className="text-[10px] text-subtext-0 shrink-0" title={p.created_at}>
                {proposalAge(p.created_at)}
              </span>
            </div>
            <div className="text-[11px] text-subtext-0 truncate">
              {p.project_name ?? `Project #${p.project_id}`} · {p.tool}
              {p.proposer_name && (
                <span> · {p.proposer_name}{p.origin === 'agent' && ' (via agent)'}</span>
              )}
              {p.details != null && (
                <button
                  onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
                  className="ml-1.5 text-primary hover:underline"
                >
                  {open[p.id] ? 'hide' : 'review'} ▾
                </button>
              )}
            </div>
            {open[p.id] && p.details != null && (
              <div className="mt-1.5 text-[10px] font-mono whitespace-pre-wrap break-words g-inset p-2 max-h-48 overflow-y-auto text-subtext-1">
                {formatProposalDetails(p.details)}
              </div>
            )}
            <div className="flex gap-1.5 mt-1.5">
              {busy[p.id] ? (
                <span className="text-xs text-subtext-0 py-0.5">{busy[p.id] === 'applying' ? 'applying…' : 'rejecting…'}</span>
              ) : p.can_approve === false ? (
                <span className="text-xs text-subtext-0 italic py-0.5">awaiting the owner</span>
              ) : (
                <>
                  <button
                    onClick={() => void resolve(p, 'approve')}
                    className="px-2.5 py-1 text-xs bg-primary text-primary-text rounded-lg"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void resolve(p, 'reject')}
                    className="px-2.5 py-1 text-xs bg-surface-2 text-subtext-1 rounded-lg"
                  >
                    Reject
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Live "what's indexing" strip inside the popover. Polls only while open. */
function IndexingSummary() {
  const { projects } = useAppStore();
  const [jobs, setJobs] = useState<IndexJob[] | null>(null);
  const [off, setOff] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const js = await listIndexJobs();
        if (alive) {
          setJobs(js);
          setOff(false);
        }
      } catch (e) {
        if (alive && e instanceof DaemonError && e.status === 404) setOff(true);
        else if (alive) setJobs([]);
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (off || jobs === null) return null;
  const name = (id?: number | null) =>
    id == null ? 'a project' : projects.find((p) => p.id === id)?.name ?? `Project ${id}`;
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  if (!running && queued.length === 0) return null;

  return (
    <div className="px-4 py-2.5 border-b border-surface-2 bg-surface-1/50">
      <div className="flex items-center gap-2 text-sm">
        {running ? (
          <>
            <span className="inline-block w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-text truncate">Indexing {name(running.project_id)}…</span>
          </>
        ) : (
          <span className="text-subtext-0">Indexing queued</span>
        )}
        {queued.length > 0 && <span className="ml-auto text-xs text-subtext-0">{queued.length} queued</span>}
      </div>
    </div>
  );
}

/** Upload progress drawn around the avatar while uploads run. */
function UploadRing({ pct }: { pct: number }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  return (
    <svg className="absolute -inset-1 w-11 h-11 -rotate-90 pointer-events-none" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r={r} fill="none" strokeWidth="3" className="stroke-surface-2" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
        className="stroke-primary transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

/** The top-right notification hub: the user avatar opens a popover with the
 * notification feed (mark-all-read), uploads, live indexing, and quick
 * profile/settings. While uploads run, a ring around the avatar shows them. */
export default function NotificationCenter({
  currentUser,
  onOpenProfile,
  onOpenSettings,
  onRefresh,
  pendingApprovals = 0,
}: {
  currentUser: User | null;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  /** Re-pull everything from the host (the manual freshness override). */
  onRefresh: () => void;
  /** Gated writes awaiting a decision — counted into the badge; resolvable
   * inline from the popover's “Awaiting approval” section. */
  pendingApprovals?: number;
}) {
  const [open, setOpen] = useState(false);
  const items = useNotifications((s) => s.items);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const dismiss = useNotifications((s) => s.dismiss);
  const clear = useNotifications((s) => s.clear);
  const unread = items.filter((i) => !i.read).length;
  const [tab, setTab] = useState<'all' | NotifCategory>('all');
  const shown = tab === 'all' ? items : items.filter((i) => i.category === tab);
  const ref = useRef<HTMLDivElement>(null);

  // Pull durable server notifications (@mentions) into the bell. Surface each
  // unread one once (stable id dedups; a per-session set avoids re-adding ones
  // the user dismissed); only server-UNREAD are shown, so marking-read sticks.
  const surfaced = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!currentUser) return;
    let active = true;
    const pull = async () => {
      try {
        const list = await getNotifications();
        if (!active) return;
        for (const n of list) {
          if (n.read || surfaced.current.has(n.id)) continue;
          surfaced.current.add(n.id);
          notify({ id: `srv-${n.id}`, category: (n.category as NotifCategory) || 'comment', title: n.title, body: n.body ?? undefined });
        }
      } catch {
        /* host unreachable — the bell just doesn't update */
      }
    };
    pull();
    const t = setInterval(pull, 60000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [currentUser, open]);

  // Marking read clears them on the host too, so they don't re-surface on refetch.
  const markAll = () => {
    markAllRead();
    markNotificationsRead().catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const avatar = currentUser ? parseProfile(currentUser.profile_json).avatar : undefined;
  const badge = unread + pendingApprovals;
  const uploads = useUploadSummary();

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      {/* The ring is red when there are unread notifications, the theme accent
          (the user's choice) otherwise. overflow-hidden clips the avatar to the
          circle — the count badge lives OUTSIDE it (on the wrapper) so it sits
          around the portrait instead of on top of the photo. */}
      {uploads.active > 0 && <UploadRing pct={uploads.pct} />}
      <button
        onClick={() => setOpen((o) => !o)}
        title={uploads.active > 0 ? `Uploading · ${uploads.pct}% — notifications` : 'Notifications'}
        className={`g-glint w-[38px] h-[38px] rounded-full overflow-hidden border flex items-center justify-center bg-mantle text-gold g-deco text-xs font-semibold tracking-[.1em] pt-0.5 ${
          badge > 0 ? 'border-error' : 'border-gold'
        }`}
      >
        {avatar ? (
          <img src={avatar} alt="" className="w-full h-full object-cover" />
        ) : (
          <span>{currentUser ? initials(currentUser.full_name) : '?'}</span>
        )}
      </button>
      {badge > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10px] font-bold flex items-center justify-center border-2 border-crust pointer-events-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}

      {open && (
        <div className="g-card g-corners absolute right-0 top-full mt-3 w-96 max-h-[70vh] shadow-2xl z-50 flex flex-col overflow-hidden whitespace-normal">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-gilt-b">
            <span className="g-deco text-[13px] font-semibold text-gold">Notifications</span>
            <div className="flex items-center gap-3 text-xs">
              {unread > 0 && (
                <button onClick={markAll} className="text-primary hover:underline">Mark all as read</button>
              )}
              {items.length > 0 && (
                <button onClick={clear} className="text-subtext-0 hover:text-text">Clear</button>
              )}
            </div>
          </div>

          <UploadsSection />

          {/* Category tabs */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-gilt-b overflow-x-auto">
            {TABS.map((t) => {
              const count = t.id === 'all' ? items.length : items.filter((i) => i.category === t.id).length;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`shrink-0 px-2.5 min-h-[28px] rounded-full text-xs transition-colors ${
                    tab === t.id ? 'g-on' : 'text-subtext-0 hover:bg-surface-0 hover:text-text'
                  }`}
                >
                  {t.label}
                  {count > 0 && <span className="ml-1 opacity-70">{count}</span>}
                </button>
              );
            })}
          </div>

          <IndexingSummary />

          {/* Gated writes, decidable here — one badge, one inbox, zero clicks away. */}
          <ProposalsInbox onChanged={() => window.dispatchEvent(new Event('ganban:proposals-changed'))} />

          <div className="flex-1 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-subtext-0">
                {items.length === 0 ? "You're all caught up." : 'Nothing here.'}
              </p>
            ) : (
              shown.map((n) => (
                <div
                  key={n.id}
                  className={`group flex items-start gap-3 px-4 py-3 border-b border-surface-2 ${n.read ? '' : 'bg-primary/5'}`}
                >
                  <span className="text-base leading-5 shrink-0">{KIND_GLYPH[n.kind]}</span>
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm truncate ${n.read ? 'text-subtext-1' : 'text-text font-medium'}`}>{n.title}</div>
                    {n.body && <div className="text-xs text-subtext-0 break-words">{n.body}</div>}
                    <div className="text-[11px] text-subtext-0 mt-0.5">{ago(n.ts)}</div>
                  </div>
                  <button
                    onClick={() => dismiss(n.id)}
                    className="opacity-0 group-hover:opacity-100 text-subtext-0 hover:text-text transition-opacity shrink-0"
                    title="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between px-5 py-3.5 border-t border-gilt-b text-xs">
            <button onClick={() => { setOpen(false); onOpenProfile(); }} className="text-subtext-0 hover:text-text">Profile</button>
            <button
              onClick={() => { setOpen(false); onRefresh(); }}
              title="Re-pull projects and the current view from the host"
              className="text-primary hover:underline font-medium"
            >
              ⟳ Refresh
            </button>
            <button onClick={() => { setOpen(false); onOpenSettings(); }} className="text-subtext-0 hover:text-text">Settings</button>
          </div>
        </div>
      )}
    </div>
  );
}
