// Review and revoke outstanding invites. Invites are one-time enrollment tokens;
// before this there was no way to see which were still live or to kill a stale/
// leaked one — once you closed the QR it was "out in the wild" untracked. This
// lists every token (pending / joined / expired) with project grouping, a state
// filter, sorting, and a Revoke that deletes the token so it can't be redeemed.
// Already-joined members keep their access (their device token is separate).
//
// Owner-gated host-side (global list); degrades to hidden if the caller can't
// list (e.g. a non-owner remote client) — so it's safe to mount unconditionally
// wherever there's a host.
import { useEffect, useMemo, useState } from "react";
import { confirmDialog } from '../lib/confirm';
import { listInvites, revokeInvite, type InviteSummary } from "../lib/host";

type StateFilter = "all" | "pending" | "joined" | "expired";
type Sort = "newest" | "oldest" | "expiring";

function relTime(iso?: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  const past = ms < 0;
  const s = Math.abs(ms) / 1000;
  let out: string;
  if (s < 45) return past ? "just now" : "in moments";
  else if (s < 3600) out = `${Math.round(s / 60)} min`;
  else if (s < 86400) out = `${Math.round(s / 3600)}h`;
  else out = `${Math.round(s / 86400)} days`;
  return past ? `${out} ago` : `in ${out}`;
}

const groupLabel = (i: InviteSummary): string =>
  i.project_name ?? (i.kind === "new_device" ? "Device pairing" : "No project");

const STATE_STYLE: Record<string, string> = {
  pending: "bg-warning/20 text-warning",
  joined: "bg-success/20 text-success",
  expired: "bg-error/15 text-error",
};

/** `projectId` scopes to one project (admin); omit for the global owner list. */
export function PendingInvitesPanel({ projectId }: { projectId?: number }) {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [hidden, setHidden] = useState(false); // not authorized / no host → render nothing
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<StateFilter>("pending");
  const [sort, setSort] = useState<Sort>("newest");
  const [grouped, setGrouped] = useState(true);

  const load = async () => {
    setBusy(true);
    try {
      const list = await listInvites(projectId);
      setInvites(list);
      setHidden(false);
    } catch {
      setHidden(true); // caller can't list invites here — hide the whole panel
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const revoke = async (i: InviteSummary) => {
    const who = i.display_name || i.project_name || "this invite";
    if (!(await confirmDialog(`Revoke the invite for ${who}? The link will stop working immediately.`))) return;
    setBusy(true);
    try {
      await revokeInvite(i.id);
      await load();
    } catch (e) {
      alert(`Couldn't revoke: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  const pendingCount = useMemo(() => invites.filter((i) => i.state === "pending").length, [invites]);

  const shown = useMemo(() => {
    let rows = filter === "all" ? invites.slice() : invites.filter((i) => i.state === filter);
    rows.sort((a, b) => {
      if (sort === "expiring") return a.expires_at.localeCompare(b.expires_at);
      const cmp = a.created_at.localeCompare(b.created_at);
      return sort === "oldest" ? cmp : -cmp;
    });
    return rows;
  }, [invites, filter, sort]);

  const groups = useMemo(() => {
    if (!grouped) return [["", shown]] as [string, InviteSummary[]][];
    const m = new Map<string, InviteSummary[]>();
    for (const i of shown) {
      const k = groupLabel(i);
      (m.get(k) ?? m.set(k, []).get(k)!).push(i);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown, grouped]);

  if (hidden) return null;

  const chip = (key: StateFilter, label: string) => (
    <button
      onClick={() => setFilter(key)}
      className={`px-2 py-0.5 rounded-full text-xs ${filter === key ? "bg-primary text-primary-text" : "bg-surface-1 text-subtext-0 hover:text-subtext-1"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mb-5 g-card">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <span className={`text-subtext-0 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
          <span className="font-semibold text-text">Pending invites</span>
          {pendingCount > 0 && (
            <span className="g-tag g-tag-warn">{pendingCount} live</span>
          )}
        </span>
        <span className="text-xs text-subtext-0">{invites.length} total</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          {/* Controls: filter / sort / group. */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {chip("pending", "Pending")}
            {chip("expired", "Expired")}
            {chip("joined", "Joined")}
            {chip("all", "All")}
            <span className="mx-1 text-surface-2">|</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="bg-surface-1 border border-surface-2 rounded-lg px-2 py-1 text-text"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="expiring">Expiring soon</option>
            </select>
            <label className="flex items-center gap-1 text-subtext-0">
              <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
              Group by project
            </label>
            <button onClick={() => void load()} disabled={busy} className="ml-auto text-primary hover:underline disabled:opacity-50">
              {busy ? "…" : "Refresh"}
            </button>
          </div>

          {shown.length === 0 ? (
            <p className="text-sm text-subtext-0 italic py-2">No {filter === "all" ? "" : filter + " "}invites.</p>
          ) : (
            <div className="space-y-3">
              {groups.map(([label, rows]) => (
                <div key={label || "_"}>
                  {grouped && (
                    <div className="g-flbl mb-1">{label}</div>
                  )}
                  <div className="space-y-1.5">
                    {rows.map((i) => (
                      <div key={i.id} className="flex items-center gap-2 bg-surface-1 rounded-lg px-3 py-2 text-sm">
                        <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full ${STATE_STYLE[i.state] ?? "bg-surface-2 text-subtext-0"}`}>
                          {i.state}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-text truncate">
                            {i.joined_name || i.display_name || (i.kind === "new_device" ? "Device pairing" : "Invite link")}
                            {i.role && <span className="text-subtext-0 text-xs"> · {i.role}</span>}
                          </div>
                          <div className="text-[11px] text-subtext-0">
                            {i.state === "joined"
                              ? `joined ${relTime(i.consumed_at)}`
                              : i.state === "expired"
                                ? `expired ${relTime(i.expires_at)}`
                                : `created ${relTime(i.created_at)} · expires ${relTime(i.expires_at)}`}
                          </div>
                        </div>
                        {i.state !== "joined" && (
                          <button
                            onClick={() => void revoke(i)}
                            disabled={busy}
                            className="shrink-0 text-xs text-error hover:underline disabled:opacity-50"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
