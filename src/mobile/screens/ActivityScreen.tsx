import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import {
  executeProposal,
  getMe,
  listAgentActions,
  listPendingProposals,
  rejectProposal,
  type AgentAction,
  type PendingProposal,
  type ProposalDetails,
} from "../../lib/daemon";
import { EmptyState, ErrorBanner, RefreshBtn, Screen, SectionHeader, Select, Spinner, errMsg } from "../ui";

interface Membership {
  project_id: number;
  project_name: string;
  role: string;
}

/** Field-by-field "before → after" rows for a proposal's details. */
function DetailsDiff({ details }: { details?: ProposalDetails }) {
  const after = details?.after ?? null;
  const before = details?.before ?? null;
  if (!after && !before) return null;
  const keys = Object.keys({ ...(before ?? {}), ...(after ?? {}) }).filter((k) => k !== "project_id" && k !== "user_id");
  if (keys.length === 0) return null;
  const show = (v: unknown) => (v == null || v === "" ? "—" : String(v));
  return (
    <div className="mt-2 space-y-1">
      {keys.map((k) => (
        <div key={k} className="text-xs flex gap-2 items-baseline">
          <span className="gm-mut w-20 shrink-0">{k}</span>
          {before && k in before && (
            <>
              <span className="gm-fg2 line-through decoration-error/50 break-words min-w-0">{show(before[k])}</span>
              <span className="gm-mut shrink-0">→</span>
            </>
          )}
          <span className="text-text break-words min-w-0">{show(after?.[k] ?? (before ? "" : undefined))}</span>
        </div>
      ))}
    </div>
  );
}

const timeLabel = (iso: string) => {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  return isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/**
 * Agent activity — the phone-side approval inbox (the caller's pending write
 * proposals, always visible) above the per-project agent ledger. The global
 * ledger is owner-only on the host, so members pick a project they belong to
 * and see that project's trail; the first membership is selected by default.
 */
export default function ActivityScreen() {
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingProposal[]>([]);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [busy, setBusy] = useState<Record<number, "applying" | "rejecting">>({});
  const [error, setError] = useState<string | null>(null);
  // Approve/reject failures get their own banner — the load effects clear the
  // shared `error` on success, which would swallow this one.
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /** Inbox + memberships (proposals are always the caller's own — no scoping). */
  const loadInbox = useCallback(async () => {
    const [me, p] = await Promise.all([getMe(), listPendingProposals()]);
    setMemberships(me.memberships);
    setPending(p);
    setProjectId((cur) => cur ?? me.memberships[0]?.project_id ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadInbox();
        if (!cancelled) setError(null);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadInbox, nonce]);

  // Ledger is scoped per project (the unscoped trail is owner-only on the host).
  useEffect(() => {
    if (projectId == null) {
      setActions([]);
      return;
    }
    let cancelled = false;
    setLedgerLoading(true);
    listAgentActions(projectId, 100)
      .then((a) => {
        if (!cancelled) setActions(a);
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e));
      })
      .finally(() => {
        if (!cancelled) setLedgerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  const refresh = () => {
    setError(null);
    setNonce((n) => n + 1);
  };

  const projectName = (id: number | null) =>
    id == null ? "All projects" : memberships?.find((m) => m.project_id === id)?.project_name ?? `Project #${id}`;

  const resolve = async (p: PendingProposal, action: "approve" | "reject") => {
    setBusy((b) => ({ ...b, [p.id]: action === "approve" ? "applying" : "rejecting" }));
    setActionError(null);
    try {
      if (action === "approve") await executeProposal(p.id);
      else await rejectProposal(p.id);
    } catch (e) {
      setActionError(`Could not ${action} “${p.summary}”: ${errMsg(e)}`);
    } finally {
      setBusy((b) => {
        const { [p.id]: _, ...rest } = b;
        return rest;
      });
      setNonce((n) => n + 1); // reload both lists either way; actionError survives
    }
  };

  // Batch decision (bulk proposals from "do this for ALL items" chats).
  // Sequential: each write goes through the same gate; first failure stops.
  const [batchBusy, setBatchBusy] = useState(false);
  const resolveAll = async (action: "approve" | "reject") => {
    if (pending.length === 0 || !await confirmDialog(`${action === "approve" ? "Approve" : "Reject"} all ${pending.length} pending proposal(s)?`)) return;
    setBatchBusy(true);
    setActionError(null);
    try {
      for (const p of pending) {
        if (action === "approve") await executeProposal(p.id);
        else await rejectProposal(p.id);
      }
    } catch (e) {
      setActionError(`Batch ${action} stopped: ${errMsg(e)}`);
    } finally {
      setBatchBusy(false);
      setNonce((n) => n + 1);
    }
  };

  return (
    <Screen title="Activity" subtitle="Agent approvals & ledger" right={<RefreshBtn onClick={refresh} />}>
      {error && <ErrorBanner message={error} onRetry={refresh} />}
      {actionError && <ErrorBanner message={actionError} onRetry={() => { setActionError(null); refresh(); }} />}
      {loading && !memberships ? (
        <Spinner />
      ) : (
        <div className="pb-8">
          {/* Inbox: pending proposals awaiting a decision */}
          <SectionHeader>
            Awaiting approval{pending.length > 0 ? ` (${pending.length})` : ""}
          </SectionHeader>
          {pending.length > 1 && (
            <div className="px-4 pb-2 flex gap-2">
              <button
                onClick={() => void resolveAll("approve")}
                disabled={batchBusy}
                className="g-btn g-btn-pri g-btn-sm min-h-[44px]"
              >
                {batchBusy ? "Working…" : `Approve all (${pending.length})`}
              </button>
              <button
                onClick={() => void resolveAll("reject")}
                disabled={batchBusy}
                className="g-btn g-btn-ghost g-btn-sm min-h-[44px]"
              >
                Reject all
              </button>
            </div>
          )}
          <div className="px-4 space-y-2">
            {pending.length === 0 ? (
              <p className="text-sm gm-mut italic py-1">
                Nothing pending — proposals from tools-on chats land here.
              </p>
            ) : (
              pending.map((p) => (
                <div key={p.id} className="g-card g-corners px-4 py-3.5">
                  <div className="text-[15px] text-text">{p.summary}</div>
                  <div className="text-xs gm-mut mt-0.5">
                    {projectName(p.project_id)} · {p.tool}
                  </div>
                  <DetailsDiff details={p.details} />
                  <div className="flex gap-2 mt-3">
                    {busy[p.id] ? (
                      <span className="flex-1 min-h-[44px] flex items-center justify-center text-sm gm-mut">
                        {busy[p.id] === "applying" ? "Applying…" : "Rejecting…"}
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => void resolve(p, "approve")}
                          className="g-btn g-btn-pri flex-1 min-h-[44px] active:bg-primary-hover"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => void resolve(p, "reject")}
                          className="g-btn g-btn-ghost flex-1 min-h-[44px] active:bg-surface-0"
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Ledger: what was applied or rejected, per project */}
          <SectionHeader>Agent ledger</SectionHeader>
          <div className="px-4 space-y-2">
            {memberships && memberships.length > 0 ? (
              <Select
                value={projectId ?? memberships[0].project_id}
                options={memberships.map((m) => ({ value: m.project_id, label: m.project_name }))}
                onChange={(v) => setProjectId(v)}
              />
            ) : (
              <EmptyState text="Join a project to see its agent ledger." />
            )}
            {projectId != null &&
              (ledgerLoading ? (
                <Spinner />
              ) : actions.length === 0 ? (
                <p className="text-sm gm-mut italic py-1">No agent actions in this project yet.</p>
              ) : (
                actions.map((a) => (
                  <div
                    key={a.id}
                    className="g-plain px-3 py-2.5 flex items-center gap-3"
                  >
                    <span className={`text-sm shrink-0 ${a.status === "applied" ? "text-success" : "gm-mut"}`}>
                      {a.status === "applied" ? "✓" : "✗"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-text truncate">{a.summary}</div>
                      <div className="text-xs gm-mut truncate">
                        {a.tool} · {a.status}
                        {a.routine_id != null && (
                          <span className="ml-1 px-1.5 rounded bg-surface-0 gm-fg2">routine</span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs gm-mut shrink-0">{timeLabel(a.created_at)}</span>
                  </div>
                ))
              ))}
          </div>
        </div>
      )}
    </Screen>
  );
}
