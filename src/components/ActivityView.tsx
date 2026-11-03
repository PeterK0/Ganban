import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from '../lib/confirm';
import ScrollArea from "./ScrollArea";
import { Card, DecoHeading } from "./gilt";
import {
  listPendingProposals,
  listAgentActions,
  executeProposal,
  rejectProposal,
  hasDaemon,
  DaemonError,
  type PendingProposal,
  type AgentAction,
  type ProposalDetails,
} from "../lib/daemon";

/** Field-by-field "before → after" rows for a proposal's details. */
function DetailsDiff({ details }: { details?: ProposalDetails }) {
  const after = details?.after ?? null;
  const before = details?.before ?? null;
  if (!after && !before) return null;
  const keys = Object.keys({ ...(before ?? {}), ...(after ?? {}) }).filter((k) => k !== "project_id" && k !== "user_id");
  if (keys.length === 0) return null;
  const show = (v: unknown) => (v == null || v === "" ? "—" : String(v));
  return (
    <div className="mt-1.5 space-y-0.5">
      {keys.map((k) => (
        <div key={k} className="text-xs flex gap-2 items-baseline">
          <span className="text-subtext-0 w-20 shrink-0">{k}</span>
          {before && k in before && (
            <>
              <span className="text-subtext-1 line-through decoration-error/50">{show(before[k])}</span>
              <span className="text-subtext-0">→</span>
            </>
          )}
          <span className="text-text">{show(after?.[k] ?? (before ? "" : undefined))}</span>
        </div>
      ))}
    </div>
  );
}

const MUTED = "text-[color:var(--g-mut)]";
/** An update row (the prototype's `.upd`). */
const UPD = "flex gap-3.5 py-4 border-t border-gilt-b";
/** Running text keeps a readable line length on any width. */
const TEXT = "mt-1 max-w-[72ch] text-text";

/** Up to two initials for the avatar; agent work without a name shows "AI". */
const initials = (name?: string | null) =>
  name
    ? name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("")
    : "AI";

const timeLabel = (iso: string) => {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  return isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/**
 * Agent activity — the global approval inbox (pending write proposals from any
 * conversation) above the action ledger (every applied/rejected agent write).
 * Proposals are data on the host, so this surface mirrors the same gate the
 * chat cards use; approving here lands the change exactly the same way.
 */
export default function ActivityView() {
  const [pending, setPending] = useState<PendingProposal[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  const [busy, setBusy] = useState<Record<number, "applying" | "rejecting">>({});
  const [error, setError] = useState<string | null>(null);
  const connected = hasDaemon();

  // Project names come FROM THE HOST with each row — never resolved against
  // the merged multi-workspace store, where numeric ids collide (the
  // "approved in Ganban, labeled ZZ - Developing Ganban" incident). The
  // filter dropdown is built from the same rows for the same reason.
  const rowProjectName = (row: { project_id: number | null; project_name?: string | null }) =>
    row.project_id == null ? "All projects" : row.project_name ?? `Project #${row.project_id}`;
  const filterOptions = (() => {
    const seen = new Map<number, string>();
    for (const r of [...pending, ...actions]) {
      if (r.project_id != null && !seen.has(r.project_id)) {
        seen.set(r.project_id, r.project_name ?? `Project #${r.project_id}`);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  })();

  const refresh = useCallback(async () => {
    if (!hasDaemon()) return;
    try {
      const [p, a] = await Promise.all([listPendingProposals(), listAgentActions(projectFilter)]);
      setPending(p);
      setActions(a);
      setError(null);
    } catch (e) {
      // A member without the global view falls back to per-project filtering.
      setError(e instanceof DaemonError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }, [projectFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolve = async (p: PendingProposal, action: "approve" | "reject") => {
    setBusy((b) => ({ ...b, [p.id]: action === "approve" ? "applying" : "rejecting" }));
    try {
      if (action === "approve") await executeProposal(p.id);
      else await rejectProposal(p.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => {
        const { [p.id]: _, ...rest } = b;
        return rest;
      });
      void refresh();
    }
  };

  // Batch decision over what's currently visible (respects the project filter).
  // Sequential on purpose: each write applies through the same gate, and a
  // failure stops the run so the error names the proposal that broke.
  const [batchBusy, setBatchBusy] = useState(false);
  const resolveAll = async (ps: PendingProposal[], action: "approve" | "reject") => {
    if (ps.length === 0 || !await confirmDialog(`${action === "approve" ? "Approve" : "Reject"} all ${ps.length} pending proposal(s)?`)) return;
    setBatchBusy(true);
    try {
      for (const p of ps) {
        if (action === "approve") await executeProposal(p.id);
        else await rejectProposal(p.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchBusy(false);
      void refresh();
    }
  };

  if (!connected) {
    return (
      <div className="h-full flex items-center justify-center px-8 text-center bg-mantle text-[color:var(--g-mut)]">
        Agent activity lives on the host — connect to a daemon (or run the desktop app) to see it.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full bg-mantle text-text">
      <div className="px-8 pt-[30px] pb-16 flex flex-col gap-[30px]">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h1 className="g-ptitle">Agent activity</h1>
          <div className="flex items-center gap-2">
            <select
              value={projectFilter ?? ""}
              onChange={(e) => setProjectFilter(e.target.value ? Number(e.target.value) : null)}
              aria-label="Filter by project"
              className="g-field w-auto"
            >
              <option value="">All projects</option>
              {filterOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <button onClick={() => void refresh()} className="g-btn g-btn-gilt">
              Refresh
            </button>
          </div>
        </div>
        {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded px-4 py-2.5">{error}</div>}

        {/* Inbox: pending proposals awaiting a decision */}
        <Card as="section" className="px-[26px] pt-[22px] pb-2.5" aria-label="Awaiting approval">
          <DecoHeading count={pending.length > 0 ? pending.length : undefined}>Awaiting approval</DecoHeading>
          {(() => {
            const visible = pending.filter((p) => (projectFilter == null || p.project_id === projectFilter) && p.can_approve !== false);
            if (visible.length < 2) return null;
            return (
              <div className="flex justify-center gap-2 mb-3">
                <button
                  onClick={() => void resolveAll(visible, "approve")}
                  disabled={batchBusy}
                  className="g-btn g-btn-pri g-btn-sm"
                >
                  {batchBusy ? "Working…" : `Approve all (${visible.length})`}
                </button>
                <button
                  onClick={() => void resolveAll(visible, "reject")}
                  disabled={batchBusy}
                  className="g-btn g-btn-ghost g-btn-sm"
                >
                  Reject all
                </button>
              </div>
            );
          })()}
          {pending.length === 0 && <p className={`text-center mt-2 mb-4 ${MUTED}`}>Nothing pending — proposals from tools-on chats land here.</p>}
          {pending
            .filter((p) => projectFilter == null || p.project_id === projectFilter)
            .map((p) => (
              <div key={p.id} className={UPD}>
                <span className="g-av !w-[34px] !h-[34px]" aria-hidden="true">{initials(p.proposer_name)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                    <b className="font-semibold">
                      {p.proposer_name ?? "Agent"}
                      {p.proposer_name && p.origin === 'agent' && <span className={`font-normal ${MUTED}`}> (via agent)</span>}
                    </b>
                    {p.created_at && <span className={MUTED}>{timeLabel(p.created_at)}</span>}
                    <span className="g-tag">{rowProjectName(p)}</span>
                    <span className="g-tag">{p.tool}</span>
                  </div>
                  <p className={TEXT}>{p.summary}</p>
                  <div className="max-w-[72ch]">
                    <DetailsDiff details={p.details} />
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0 self-start">
                  {busy[p.id] ? (
                    <span className={`text-xs px-2 py-1 ${MUTED}`}>{busy[p.id] === "applying" ? "applying…" : "rejecting…"}</span>
                  ) : p.can_approve === false ? (
                    // Visibility ≠ approval right: under an 'owner' policy a
                    // member sees their pending work but the decision isn't theirs.
                    <span className={`text-xs px-2 py-1 italic ${MUTED}`}>awaiting the owner</span>
                  ) : (
                    <>
                      <button onClick={() => void resolve(p, "approve")} className="g-btn g-btn-pri g-btn-sm">
                        Approve
                      </button>
                      <button onClick={() => void resolve(p, "reject")} className="g-btn g-btn-ghost g-btn-sm">
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
        </Card>

        {/* Ledger: what was applied or rejected */}
        <Card as="section" className="px-[26px] pt-[22px] pb-2.5" aria-label="Activity">
          <DecoHeading>Activity</DecoHeading>
          {actions.length === 0 && <p className={`text-center mt-2 mb-4 ${MUTED}`}>No agent actions yet.</p>}
          {actions.map((a) => (
            <div key={a.id} className={UPD}>
              <span
                className={`g-av !w-[34px] !h-[34px] !text-sm ${a.status === "applied" ? "!text-success" : `!text-[color:var(--g-mut)]`}`}
                title={a.status}
              >
                {a.status === "applied" ? "✓" : "✗"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
                  <span className={`g-tag ${a.status === "applied" ? "g-tag-ok" : ""}`}>{a.status}</span>
                  <span className={MUTED}>{timeLabel(a.created_at)}</span>
                  <span className="g-tag">{rowProjectName(a)}</span>
                  <span className="g-tag">{a.tool}</span>
                  {a.routine_id != null && <span className="g-tag g-tag-hi">routine</span>}
                </div>
                <p className={TEXT}>{a.summary}</p>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </ScrollArea>
  );
}
