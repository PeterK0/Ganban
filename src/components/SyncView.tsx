import { useEffect, useState } from "react";
import { confirmDialog } from '../lib/confirm';
import { QRCodeSVG } from "qrcode.react";
import {
  checkHealth,
  getSnapshot,
  getDaemonBaseUrl,
  setDaemonBaseUrl,
  getTransportMode,
  isDesktopOnline,
  parseInviteLink,
  enrollDevice,
  DaemonError,
  type Snapshot,
} from "../lib/daemon";
import { addRemoteWorkspace, setActiveWorkspace, LOCAL_ID } from "../lib/workspaces";
import {
  createProjectInvite,
  daemonStart,
  daemonStatus,
  daemonStop,
  deviceList,
  deviceRevoke,
  inviteLink,
  enrollQr,
  memberList,
  memberRemove,
  memberSetRole,
  pairOwnerDevice,
  tailscaleShare,
  type DaemonStatus,
  type DeviceInfo,
  type MemberInfo,
  tokenRenewNote,
  type TokenExpiry,
} from "../lib/host";
import { isTailnetUrl } from "../lib/invite.pure";
import { TailnetUnreachableGate } from "./TailnetUnreachableGate";
import { PairingDiagnostics } from "./PairingDiagnostics";
import { getProjects, getUser, getUsers } from "../lib/api";
import {
  canSyncNow,
  getSyncConflicts,
  lastSyncedAt,
  resolveSyncConflict,
  syncNow,
  syncStatus,
  type SyncConflict,
  type SyncReport,
  type SyncStatus,
} from "../lib/sync";
import ProfileCardModal from "./ProfileCardModal";
import type { Project, User } from "../types";

type ConnStatus = "idle" | "connecting" | "connected" | "error";

/**
 * Desktop "Sync" view (Phase 1: read-through only).
 *
 * Lets the user point at the daemon, connect (GET /health), and view the
 * canonical database fetched over HTTP — proving the desktop and the phone see
 * the same source of truth. Writes still go through the local app for now.
 */
export default function SyncView() {
  const [url, setUrl] = useState<string>(getDaemonBaseUrl() ?? "http://127.0.0.1:8765");
  const [status, setStatus] = useState<ConnStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const snap = await getSnapshot();
      setSnapshot(snap);
      setLastSynced(new Date());
    } catch (e) {
      setError(e instanceof DaemonError ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const connect = async () => {
    setStatus("connecting");
    setError(null);
    setVersion(null);
    try {
      const health = await checkHealth(url);
      setDaemonBaseUrl(url);
      setVersion(health.version);
      setStatus("connected");
      await refresh();
    } catch (e) {
      setStatus("error");
      setError(e instanceof DaemonError ? e.message : String(e));
    }
  };

  const statusDot =
    status === "connected"
      ? "bg-success"
      : status === "connecting"
      ? "bg-warning animate-pulse"
      : status === "error"
      ? "bg-error"
      : "bg-overlay-0";

  const statusLabel =
    status === "connected"
      ? `Connected${version ? ` · daemon v${version}` : ""}`
      : status === "connecting"
      ? "Connecting…"
      : status === "error"
      ? "Connection failed"
      : "Not connected";

  const taskCount = (projectId: number) =>
    snapshot?.tasks.filter((t) => t.project_id === projectId).length ?? 0;

  return (
    <div className="p-6 bg-base text-text">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="g-h2 justify-start mb-1">Sync</h1>
          <p className="text-sm text-subtext-0 mt-1">
            Host the daemon here so your phone can pair by QR, or connect to a daemon and view the
            shared database over HTTP.
          </p>
        </div>

        <ClientModePanel />

        <ReconcilePanel />

        <HostPanel />

        <MembersPanel />

        <div className="g-flbl pt-2">
          Connect to a daemon
        </div>

        {/* Connection panel */}
        <div className="g-card p-5 space-y-3">
          <label className="block text-sm font-medium text-subtext-1">Daemon URL</label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") connect();
              }}
              placeholder="http://100.x.y.z:8765"
              className="g-field flex-1"
            />
            <button
              onClick={connect}
              disabled={status === "connecting"}
              className="g-btn g-btn-pri"
            >
              Connect
            </button>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusDot}`} />
              <span className="text-subtext-1">{statusLabel}</span>
            </div>
            {status === "connected" && (
              <div className="flex items-center gap-3 text-sm">
                {lastSynced && (
                  <span className="text-subtext-0">
                    Last synced {lastSynced.toLocaleTimeString()}
                  </span>
                )}
                <button
                  onClick={refresh}
                  disabled={refreshing}
                  className="px-3 py-1.5 bg-surface-1 hover:bg-surface-2 rounded-lg transition-colors disabled:opacity-50"
                >
                  {refreshing ? "Refreshing…" : "Refresh"}
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Synced data */}
        {snapshot && (
          <div className="space-y-6">
            <div className="flex gap-4">
              <StatCard label="Projects" value={snapshot.counts.projects} />
              <StatCard label="Tasks" value={snapshot.counts.tasks} />
            </div>

            {/* Projects with task counts */}
            <section className="g-card overflow-hidden">
              <h2 className="g-cap px-4 py-3 border-b border-gilt-b">
                Projects
              </h2>
              {snapshot.projects.length === 0 ? (
                <p className="px-4 py-6 text-sm text-subtext-0 italic">No projects</p>
              ) : (
                <ul className="divide-y divide-surface-2">
                  {snapshot.projects.map((p) => (
                    <li key={p.id} className="px-4 py-3 flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{p.name}</div>
                        {p.description && (
                          <div className="text-sm text-subtext-0 truncate">{p.description}</div>
                        )}
                      </div>
                      <span className="g-tag ml-3 shrink-0">
                        {taskCount(p.id)} task{taskCount(p.id) === 1 ? "" : "s"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Tasks table (read-only) */}
            <section className="g-card overflow-hidden">
              <h2 className="g-cap px-4 py-3 border-b border-gilt-b">
                Tasks
              </h2>
              {snapshot.tasks.length === 0 ? (
                <p className="px-4 py-6 text-sm text-subtext-0 italic">No tasks</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-subtext-0 text-left">
                      <tr className="border-b border-surface-2">
                        <th className="px-4 py-2 font-medium">Title</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                        <th className="px-4 py-2 font-medium">Priority</th>
                        <th className="px-4 py-2 font-medium">Project</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-2">
                      {snapshot.tasks.map((t) => (
                        <tr key={t.id}>
                          <td className="px-4 py-2">{t.title}</td>
                          <td className="px-4 py-2">{t.status}</td>
                          <td className="px-4 py-2">{t.priority}</td>
                          <td className="px-4 py-2 text-subtext-0">
                            {snapshot.projects.find((p) => p.id === t.project_id)?.name ?? t.project_id}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/** Point this desktop at an always-on host and run the full app against its DB
 * (online mode), or switch back to this machine's own local database. */
function ClientModePanel() {
  const [mode] = useState(getTransportMode());
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const payload = parseInviteLink(link);
    if (!payload) {
      setError("Paste the host's pairing link — on the host: Sync → Host this device → Pair a phone → Copy invite link.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await enrollDevice(payload.u, payload.t, "Ganban desktop");
      // Register the host as a workspace + activate it (K2) — adds to the
      // registry instead of flipping a global.
      const id = addRemoteWorkspace({ url: payload.u, token: res.device_token });
      setActiveWorkspace(id);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const goLocal = () => {
    // Activate the local workspace: write-through restores the loopback URL,
    // drops the remote token, sets local transport.
    setActiveWorkspace(LOCAL_ID);
    window.location.reload();
  };

  if (mode === "online") {
    return (
      <div className="g-card p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-success" />
          <h2 className="g-h2 justify-start mb-1">Online — client of a host</h2>
        </div>
        <p className="text-sm text-subtext-0">
          This desktop is reading & writing the host's database at{" "}
          <span className="font-mono break-all text-subtext-1">{getDaemonBaseUrl()}</span>. Edits sync live.
        </p>
        <button onClick={goLocal} className="g-btn g-btn-ghost">
          Switch back to this machine's local database
        </button>
        <AddMyDeviceCard />
      </div>
    );
  }

  return (
    <div className="g-card p-5 space-y-2">
      <h2 className="g-h2 justify-start mb-1">Run as a client of a host</h2>
      <p className="text-sm text-subtext-0">
        Point this desktop at an always-on host (a desktop or mini PC that stays on) and use the full app against its database, live
        over the tailnet. On the host: <span className="text-subtext-1">Sync → Host this device → Pair a phone → Copy invite link</span>.
      </p>
      <input
        type="text"
        value={link}
        onChange={(e) => setLink(e.target.value)}
        placeholder="Paste the host's pairing link"
        className="g-field"
      />
      {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{error}</div>}
      <button
        onClick={connect}
        disabled={busy || !link.trim()}
        className="g-btn g-btn-pri"
      >
        {busy ? "Connecting…" : "Connect (online mode)"}
      </button>
    </div>
  );
}

/**
 * "Add another device" for a connected member (or any user): mint a one-time
 * code that enrolls another device against THIS SAME account, so your profile
 * (name, avatar, theme, PIN) and project memberships come with it — instead of
 * re-joining via an invite link, which would create a SECOND, blank account.
 * The token is a "new_device" kind hard-targeted at your own user id (host-side).
 */
function AddMyDeviceCard() {
  const [pair, setPair] = useState<{ url: string; token: string; ts?: string | null; shareError?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = await pairOwnerDevice(); // mints a new_device token for the current account
      const share = await tailscaleShare(); // best-effort; owner-only host-side, so usually null for members
      setPair({ url: getDaemonBaseUrl() ?? "", token, ts: share.ts, shareError: share.error });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="border-t border-surface-2 pt-3 mt-1 space-y-2">
      <div className="text-sm font-medium text-text">Add another device</div>
      <p className="text-xs text-subtext-0">
        Sign in on another device as you — your profile and projects come with it. (Joining again with a fresh invite
        link would make a separate, blank account.)
      </p>
      {!pair ? (
        <button
          onClick={() => void generate()}
          disabled={busy}
          className="g-btn g-btn-ghost g-btn-sm"
        >
          {busy ? "Generating…" : "Add another device"}
        </button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="bg-white p-2 rounded-lg shrink-0">
              <QRCodeSVG value={inviteLink(pair.url, pair.token, pair.ts ?? undefined)} size={132} />
            </div>
            <div className="min-w-0 space-y-1.5 text-sm">
              <p className="text-subtext-0 text-xs">
                Scan with your other device's camera (or the Ganban app), or open this link there. That device must be
                able to reach the host (on your tailnet, or having accepted its machine-share).
              </p>
              <button onClick={() => void copy(inviteLink(pair.url, pair.token, pair.ts ?? undefined))} className="g-btn g-btn-ghost g-btn-sm">
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          </div>
          <PairingDiagnostics url={pair.url} token={pair.token} ts={pair.ts} shareError={pair.shareError} />
          <button onClick={() => setPair(null)} className="text-xs text-subtext-0 hover:text-subtext-1">Done</button>
        </div>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

/**
 * LOCAL-mode reconcile: a "Sync now" button that pushes local edits to the host
 * and pulls the host's changes, plus a review panel for any field-level
 * conflicts. Hidden unless this is a local-mode desktop paired with a host.
 */
function ReconcilePanel() {
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [stat, setStat] = useState<SyncStatus | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [lastAt, setLastAt] = useState<string | null>(null);
  // Per-conflict, per-column choice ("local" keeps mine, "server" takes theirs).
  const [choice, setChoice] = useState<Record<string, Record<string, "local" | "server">>>({});

  const refresh = async () => {
    setStat(await syncStatus());
    setConflicts(await getSyncConflicts());
    setLastAt(await lastSyncedAt());
  };

  useEffect(() => {
    if (canSyncNow()) refresh().catch(() => {});
  }, []);

  if (!canSyncNow()) return null;

  const run = async () => {
    setBusy(true);
    try {
      setReport(await syncNow());
      await refresh();
    } catch (e) {
      setReport({ ran: false, offline: false, pulled: 0, applied: 0, pushed: 0, conflicts: 0, rejected: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const pick = (uuid: string, col: string, side: "local" | "server") =>
    setChoice((c) => ({ ...c, [uuid]: { ...c[uuid], [col]: side } }));

  const resolve = async (cf: SyncConflict) => {
    const sel = choice[cf.sync_uuid] ?? {};
    const resolved: Record<string, unknown> = {};
    for (const col of cf.clashing_cols ?? []) {
      const side = sel[col] ?? "local";
      resolved[col] = (side === "server" ? cf.server : cf.local)[col];
    }
    await resolveSyncConflict(cf.sync_uuid, resolved);
    await refresh();
  };

  const fmt = (v: unknown) => (v === null || v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v));

  return (
    <div className="g-card p-5 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="g-h2 justify-start mb-1">Reconcile with host</h2>
          <p className="text-sm text-subtext-0">
            Working on this machine's local database. Push your changes to the host and pull theirs.
          </p>
        </div>
        <button
          onClick={run}
          disabled={busy}
          className="g-btn g-btn-pri"
        >
          {busy ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-subtext-1">
        {stat && (
          <>
            <span>{stat.dirty_count} unsynced change{stat.dirty_count === 1 ? "" : "s"}</span>
            {stat.tombstone_count > 0 && <span>{stat.tombstone_count} pending delete{stat.tombstone_count === 1 ? "" : "s"}</span>}
            {stat.conflict_count > 0 && <span className="text-warning">{stat.conflict_count} conflict{stat.conflict_count === 1 ? "" : "s"} to review</span>}
          </>
        )}
        {lastAt && <span className="text-subtext-0">last synced {new Date(lastAt).toLocaleString()}</span>}
      </div>

      {report && (
        <div
          className={`text-sm rounded-lg px-3 py-2 ${
            report.error
              ? "text-error bg-error/10 border border-error/30"
              : report.offline
                ? "text-warning bg-warning/10 border border-warning/30"
                : "text-subtext-1 bg-surface-1 border border-surface-2"
          }`}
        >
          {report.error
            ? report.error
            : report.offline
              ? "Host unreachable — still working offline. Your changes are saved and will sync when it's back."
              : `Synced: pulled ${report.pulled}, applied ${report.applied}, pushed ${report.pushed}` +
                (report.conflicts ? `, ${report.conflicts} conflict(s) to review` : "") +
                (report.rejected ? `, ${report.rejected} rejected` : "")}
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="space-y-3 pt-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-warning">Conflicts to review</div>
          {conflicts.map((cf) => {
            const sel = choice[cf.sync_uuid] ?? {};
            return (
              <div key={cf.sync_uuid} className="border border-warning/40 rounded-lg p-3 space-y-2">
                <div className="text-sm font-medium">
                  {cf.entity} <span className="text-subtext-0 font-mono text-xs">{cf.sync_uuid.slice(0, 8)}</span>
                </div>
                {(cf.clashing_cols ?? []).length === 0 && (
                  <p className="text-sm text-subtext-0">
                    This row changed on both sides. Resolve to keep this machine's version and re-sync it to the host.
                  </p>
                )}
                {(cf.clashing_cols ?? []).map((col) => {
                  const side = sel[col] ?? "local";
                  return (
                    <div key={col} className="text-sm">
                      <div className="text-subtext-0 mb-1">{col}</div>
                      <div className="grid grid-cols-2 gap-2">
                        {(["local", "server"] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => pick(cf.sync_uuid, col, s)}
                            className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                              side === s
                                ? "border-gilt-a bg-gilt-b text-gold"
                                : "border-surface-2 bg-surface-1 text-subtext-1 hover:bg-surface-2"
                            }`}
                          >
                            <div className="g-flbl">
                              {s === "local" ? "This machine" : "Host"}
                            </div>
                            <div className="break-words">{fmt((s === "server" ? cf.server : cf.local)[col])}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => resolve(cf)}
                    className="g-btn g-btn-pri g-btn-sm"
                  >
                    Resolve
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex-1 g-plain px-4 py-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="g-flbl">{label}</div>
    </div>
  );
}

/** Owner-only: manage who is in each project, their role, and their devices. */
function MembersPanel() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number>(0);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [devLoading, setDevLoading] = useState(false);
  const [cardUser, setCardUser] = useState<User | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [addUserId, setAddUserId] = useState<number | "">("");
  const [addRole, setAddRole] = useState<string>("member");

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const showCard = async (userId: number) => {
    try {
      setCardUser(await getUser(userId));
    } catch (e) {
      fail(e);
    }
  };

  useEffect(() => {
    getProjects()
      .then((ps) => {
        const active = ps.filter((p) => !p.archived);
        setProjects(active);
        setProjectId((id) => id || active[0]?.id || 0);
      })
      .catch(fail);
    // Existing people, so the owner can reuse one instead of re-inviting.
    getUsers().then(setAllUsers).catch(() => {});
  }, []);

  // Candidates for "add existing": real people not already in this project.
  const candidates = allUsers.filter((u) => !u.is_owner && !members.some((m) => m.user_id === u.id));

  const addExisting = async () => {
    if (!addUserId || !projectId) return;
    try {
      await memberSetRole(projectId, Number(addUserId), addRole);
      setAddUserId("");
      loadMembers(projectId);
    } catch (e) {
      fail(e);
    }
  };

  const loadMembers = async (pid: number) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    setExpanded(null);
    try {
      setMembers(await memberList(pid));
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) loadMembers(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const setRole = async (userId: number, role: string) => {
    try {
      await memberSetRole(projectId, userId, role);
      loadMembers(projectId);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (m: MemberInfo) => {
    if (!await confirmDialog(`Remove ${m.display_name} from this project?`)) return;
    try {
      await memberRemove(projectId, m.user_id);
      loadMembers(projectId);
    } catch (e) {
      fail(e);
    }
  };

  const toggleDevices = async (userId: number) => {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    setDevLoading(true);
    setDevices([]);
    try {
      setDevices(await deviceList(userId));
    } catch (e) {
      fail(e);
    } finally {
      setDevLoading(false);
    }
  };

  const revoke = async (d: DeviceInfo, userId: number) => {
    if (!await confirmDialog(`Revoke ${d.device_label || "this device"}? It will need a new invite to reconnect.`)) return;
    try {
      await deviceRevoke(d.id);
      setDevices(await deviceList(userId));
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="g-card p-5 space-y-3">
      <div>
        <h2 className="g-h2 justify-start mb-1">Members &amp; access</h2>
        <p className="text-sm text-subtext-0">Manage who's in each project, their role, and their devices.</p>
      </div>

      <select
        value={projectId}
        onChange={(e) => setProjectId(Number(e.target.value))}
        className="w-full px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-text"
      >
        {projects.length === 0 && <option value={0}>No projects</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-subtext-0">Loading…</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-subtext-0 italic">No members yet. Invite someone from "Host this device".</p>
      ) : (
        <ul className="divide-y divide-surface-2 border border-surface-2 rounded-lg overflow-hidden">
          {members.map((m) => {
            const isOwner = m.role === "owner";
            return (
              <li key={m.user_id} className="px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <button onClick={() => showCard(m.user_id)} className="font-medium truncate text-text hover:text-primary text-left" title="View profile">
                      {m.display_name}
                    </button>
                    <div className="text-xs text-subtext-0">@{m.username}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isOwner ? (
                      <span className="g-tag">owner</span>
                    ) : (
                      <select
                        value={m.role}
                        onChange={(e) => setRole(m.user_id, e.target.value)}
                        className="text-sm bg-surface-1 border border-surface-2 rounded-lg px-2 py-1 text-text"
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                    )}
                    <button
                      onClick={() => toggleDevices(m.user_id)}
                      className="text-sm text-subtext-1 px-2 py-1 rounded-lg hover:bg-surface-1"
                    >
                      Devices
                    </button>
                    {!isOwner && (
                      <button onClick={() => remove(m)} className="g-btn g-btn-danger g-btn-sm">
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                {expanded === m.user_id && (
                  <div className="bg-surface-1 rounded-lg p-2 text-sm space-y-1.5">
                    {devLoading ? (
                      <p className="text-subtext-0">Loading devices…</p>
                    ) : devices.length === 0 ? (
                      <p className="text-subtext-0 italic">No active devices.</p>
                    ) : (
                      devices.map((d) => (
                        <div key={d.id} className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate">{d.device_label || "Unnamed device"}</div>
                            <div className="text-xs text-subtext-0">
                              {d.last_seen_at ? `last seen ${new Date(d.last_seen_at).toLocaleString()}` : "never used"} · added{" "}
                              {new Date(d.created_at).toLocaleDateString()}
                            </div>
                          </div>
                          <button
                            onClick={() => revoke(d, m.user_id)}
                            className="g-btn g-btn-danger g-btn-sm shrink-0"
                          >
                            Revoke
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add an existing person to this project (reuse, no re-invite) */}
      {projectId > 0 && candidates.length > 0 && (
        <div className="border border-surface-2 rounded-lg p-3 space-y-2">
          <div className="g-flbl">Add existing collaborator</div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={addUserId}
              onChange={(e) => setAddUserId(e.target.value ? Number(e.target.value) : "")}
              className="flex-1 min-w-[160px] px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-text text-sm"
            >
              <option value="">Pick a person…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} (@{u.username})
                </option>
              ))}
            </select>
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              className="px-3 py-2 bg-surface-1 border border-surface-2 rounded-lg text-text text-sm"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <button
              onClick={addExisting}
              disabled={!addUserId}
              className="g-btn g-btn-pri"
            >
              Add
            </button>
          </div>
          <p className="text-xs text-subtext-0">Their existing login works immediately — no new invite needed.</p>
        </div>
      )}

      {cardUser && <ProfileCardModal user={cardUser} onClose={() => setCardUser(null)} />}
    </div>
  );
}

/** Start/stop the in-process daemon and show a QR + URLs for phone pairing. */
function HostPanel() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [pair, setPair] = useState<{ label: string; url: string; token: string; ts?: string | null; shareError?: string | null; tokenExpiry?: TokenExpiry | null } | null>(null);
  // The host URL is a tailnet 100.x and no share attached → the link is
  // unreachable off-tailnet; the gate hides it until the owner reveals it
  // (recipient already on the tailnet) or fixes auto-share. Reset per invite.
  const [revealTailnet, setRevealTailnet] = useState(false);
  // Older Ganban apps only parse the JSON {u,t} pairing payload, not the
  // browser-openable invite LINK the QR now carries — this flips the QR back
  // for a phone that hasn't updated yet.
  const [legacyQr, setLegacyQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [invProject, setInvProject] = useState<number>(0);
  const [invRole, setInvRole] = useState<string>("member");
  const [openQr, setOpenQr] = useState<"pair" | null>(null);
  // Connected to a remote daemon vs hosting locally — drives the invite URL choice.
  const online = isDesktopOnline();

  useEffect(() => {
    let active = true;
    const refresh = () =>
      daemonStatus()
        .then((s) => {
          if (!active) return;
          setStatus(s);
          setSelected((prev) => (s.urls.includes(prev) ? prev : s.urls[0] ?? ""));
        })
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const apply = (s: DaemonStatus) => {
    setStatus(s);
    setSelected((prev) => (s.urls.includes(prev) ? prev : s.urls[0] ?? ""));
  };

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (status?.running && !status.loopback) {
        // Stop hosting for OTHER devices, but keep the machine-only daemon the
        // app itself relies on (assistant, tabs, secretary…): full stop, then
        // restart loopback-only.
        await daemonStop();
        const s = await daemonStart(undefined, true);
        apply(s);
        if (s.port) setDaemonBaseUrl(`http://127.0.0.1:${s.port}`);
      } else {
        // Widen to the tailnet/LAN (upgrades a loopback-only daemon in place).
        const s = await daemonStart();
        apply(s);
        // Auto-connect the app to the daemon we just started, so chat / AI
        // config work without a separate "Connect to a daemon" step.
        if (s.port) setDaemonBaseUrl(`http://127.0.0.1:${s.port}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      fail(e);
    }
  };

  // When connected to a remote daemon (online), invites/pairing target that
  // host and the link must use its URL — not this laptop's (which isn't hosting).
  const hostUrl = online ? (getDaemonBaseUrl() ?? "") : selected;

  const pairPhone = async () => {
    setError(null);
    try {
      const token = await pairOwnerDevice();
      // Fold in a Tailscale device-share so a phone on a DIFFERENT tailnet (or
      // not on yours yet) can accept the machine and reach the host — "pair any
      // phone from anywhere", no manual tailnet join. Best-effort.
      const share = await tailscaleShare();
      setRevealTailnet(false);
      setPair({ label: "Owner device", url: hostUrl, token, ts: share.ts, shareError: share.error, tokenExpiry: share.tokenExpiry });
      setOpenQr("pair");
    } catch (e) {
      fail(e);
    }
  };

  const openInvite = async () => {
    setError(null);
    try {
      const ps = (await getProjects()).filter((p) => !p.archived);
      setProjects(ps);
      setInvProject(ps[0]?.id ?? 0);
      setInviting(true);
    } catch (e) {
      fail(e);
    }
  };

  const genInvite = async () => {
    if (!invProject) return;
    setError(null);
    try {
      const token = await createProjectInvite(invProject, invRole);
      const name = projects.find((p) => p.id === invProject)?.name ?? "project";
      const share = await tailscaleShare();
      setRevealTailnet(false);
      setPair({ label: `Invite to ${name} (${invRole})`, url: hostUrl, token, ts: share.ts, shareError: share.error, tokenExpiry: share.tokenExpiry });
      setOpenQr("pair");
      setInviting(false);
    } catch (e) {
      fail(e);
    }
  };

  // "Hosting" = reachable by other devices. The loopback-only daemon the app
  // starts for itself at launch doesn't count.
  const running = (status?.running ?? false) && !(status?.loopback ?? false);

  // The pair-a-device / invite-to-a-project controls, shared by local-hosting
  // mode and remote-connected (online) mode. Uses hostUrl for the link/QR.
  const inviteControls = (
    <>
      {pair && openQr === "pair" ? (
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <div className="font-medium">{pair.label}</div>
            <button onClick={() => { setPair(null); setOpenQr(null); }} className="text-primary text-xs">Done</button>
          </div>
          {tokenRenewNote(pair.tokenExpiry) && (
            <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-lg px-2 py-1.5">{tokenRenewNote(pair.tokenExpiry)}</p>
          )}
          {pair.ts ? (
            // Device-share attached: the phone can be on ANY network/tailnet. It
            // accepts a one-time share of this Mac (Step 1), then joins (Step 2).
            <>
              <div className="rounded-lg border border-surface-2 p-3 space-y-2">
                <div className="text-xs font-semibold text-text">Step 1 · Add this Mac to their Tailscale</div>
                <p className="text-[11px] text-subtext-0">
                  Scan to accept a one-time share of this machine — works from any network, no need to already be on your
                  tailnet (needs the Tailscale app + any Tailscale account).
                </p>
                <div className="flex items-center gap-3">
                  <div className="bg-white p-2 rounded-lg shrink-0"><QRCodeSVG value={pair.ts} size={120} /></div>
                  <button onClick={() => copyLink(pair.ts!)} className="g-btn g-btn-ghost g-btn-sm">
                    {copied ? "Copied ✓" : "Copy Step 1 link"}
                  </button>
                </div>
              </div>
              <div className="rounded-lg border border-surface-2 p-3 space-y-2">
                <div className="text-xs font-semibold text-text">Step 2 · Open Ganban</div>
                <p className="text-[11px] text-subtext-0">After Step 1: scan with your phone camera to open it in a browser — no install, works on iOS too. (The Ganban app reads it as well.)</p>
                <div className="flex items-center gap-3">
                  <div className="bg-white p-2 rounded-lg shrink-0"><QRCodeSVG value={inviteLink(pair.url, pair.token, pair.ts ?? undefined)} size={120} /></div>
                  <button onClick={() => copyLink(inviteLink(pair.url, pair.token, pair.ts ?? undefined))} className="g-btn g-btn-ghost g-btn-sm">
                    {copied ? "Copied ✓" : "Copy Step 2 link"}
                  </button>
                </div>
              </div>
              <p className="text-subtext-0 text-xs">Both are one-time.</p>
            </>
          ) : isTailnetUrl(pair.url) && !revealTailnet ? (
            <TailnetUnreachableGate
              url={pair.url}
              shareError={pair.shareError}
              onClose={() => { setPair(null); setOpenQr(null); }}
              onReveal={() => setRevealTailnet(true)}
              onManualShare={(ts) => setPair({ ...pair, ts, shareError: null })}
            />
          ) : (
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="self-center shrink-0 flex flex-col items-center gap-1.5">
                <div className="bg-white p-3 rounded-xl">
                  <QRCodeSVG value={legacyQr ? enrollQr(pair.url, pair.token, pair.ts ?? undefined) : inviteLink(pair.url, pair.token)} size={188} />
                </div>
                <button
                  onClick={() => setLegacyQr((v) => !v)}
                  className="text-[11px] text-subtext-0 hover:text-text underline decoration-dotted"
                  title="Older Ganban apps reject the link-style QR with “isn't a Ganban pairing code” — this shows the classic format they understand."
                >
                  {legacyQr ? 'standard code' : 'app says “isn\u2019t a pairing code”?'}
                </button>
              </div>
              <div className="flex-1 min-w-0 space-y-2 text-sm">
                <p className="text-subtext-0">
                  {legacyQr ? (
                    <><span className="text-subtext-1">Legacy pairing code</span> — for Ganban apps that haven't updated yet. Phone cameras can't open this one in a browser; use the Ganban app's scanner.</>
                  ) : (
                    <><span className="text-subtext-1">Scan it</span> with a phone camera — it opens the join screen in your browser (no install, iOS too). The Ganban app reads it as well.</>
                  )}
                </p>
                <div className="pt-1 border-t border-surface-2 space-y-1.5">
                  <p className="text-subtext-0">
                    <span className="text-subtext-1">Or send this link</span> — it opens Ganban in a browser:
                  </p>
                  <div className="font-mono text-xs text-subtext-0 break-all bg-surface-1 rounded-lg px-2 py-1.5">
                    {inviteLink(pair.url, pair.token)}
                  </div>
                  <button
                    onClick={() => copyLink(inviteLink(pair.url, pair.token))}
                    className="g-btn g-btn-ghost g-btn-sm"
                  >
                    {copied ? "Copied ✓" : "Copy invite link"}
                  </button>
                </div>
                {pair.shareError ? (
                  <p className="text-warning text-xs">
                    Couldn't attach a Tailscale machine-share: {pair.shareError}. The phone must already reach this host
                    (on your tailnet, or share the machine manually).
                  </p>
                ) : (
                  isTailnetUrl(pair.url) && (
                    <p className="text-warning text-xs">
                      This is a Tailscale (tailnet) address — the phone must be on your tailnet to reach it. Configure
                      Tailscale auto-share (Settings → Sync → Tailscale) and it'll attach a one-tap machine share so any
                      phone joins from anywhere.
                    </p>
                  )
                )}
                <p className="text-subtext-0 text-xs">One-time link.</p>
              </div>
            </div>
          )}
          <PairingDiagnostics
            url={pair.url}
            token={pair.token}
            ts={pair.ts}
            shareError={pair.shareError}
            daemonRunning={running}
            port={status?.port ?? null}
          />
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button onClick={pairPhone} disabled={!hostUrl} className="g-btn g-btn-pri">
            Pair a device
          </button>
          <button onClick={openInvite} disabled={!hostUrl} className="g-btn g-btn-ghost">
            Invite to a project…
          </button>
        </div>
      )}

      {inviting && !(pair && openQr === "pair") && (
        <div className="bg-surface-1 rounded-lg p-3 space-y-2">
          <select
            value={invProject}
            onChange={(e) => setInvProject(Number(e.target.value))}
            className="w-full px-3 py-2 bg-surface-0 border border-surface-2 rounded-lg text-text"
          >
            {projects.length === 0 && <option value={0}>No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            {["member", "admin"].map((r) => (
              <button
                key={r}
                onClick={() => setInvRole(r)}
                className={`flex-1 py-2 rounded-lg border text-sm ${invRole === r ? "border-primary bg-surface-2 text-text" : "border-surface-2 text-subtext-1"}`}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={genInvite} disabled={!invProject} className="g-btn g-btn-pri flex-1">
              Generate invite QR
            </button>
            <button onClick={() => setInviting(false)} className="g-btn g-btn-ghost">
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="g-card p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="g-h2 justify-start mb-1">Host this device</h2>
          <p className="text-sm text-subtext-0">
            Run the daemon here so phones pair by QR — and anyone can join from a browser link over the tailnet, no install needed.
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className={`shrink-0 px-5 py-2 rounded-lg transition-colors disabled:opacity-50 ${
            running ? "bg-error/15 text-error hover:bg-error/25" : "bg-primary text-primary-text hover:bg-primary-hover"
          }`}
        >
          {busy ? "…" : running ? "Stop" : "Start"}
        </button>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${running ? "bg-success" : "bg-overlay-0"}`} />
        <span className="text-subtext-1">{running ? `Running on port ${status?.port}` : "Stopped"}</span>
      </div>

      {error && (
        <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{error}</div>
      )}

      {running && status && (
        <div className="space-y-3 pt-1">
          <div className="space-y-1">
            <p className="text-sm text-subtext-1">Reachable at (pick the address phones should use):</p>
            {status.urls.length === 0 ? (
              <p className="text-sm text-warning">No Tailscale/LAN address detected. Make sure Tailscale is connected.</p>
            ) : (
              status.urls.map((u) => (
                <button
                  key={u}
                  onClick={() => setSelected(u)}
                  className={`w-full text-left px-3 py-2 rounded-lg border break-all font-mono text-sm ${
                    selected === u ? "border-primary bg-surface-1 text-text" : "border-surface-2 text-subtext-1"
                  }`}
                >
                  {u}
                </button>
              ))
            )}
          </div>

          {inviteControls}
        </div>
      )}

      {/* Connected to a remote daemon (laptop away from the host): invite people
          to the server's projects / pair a device, using the remote host's URL. */}
      {online && !running && (
        <div className="space-y-3 pt-1">
          <p className="text-sm text-subtext-1">
            Connected to{" "}
            <span className="font-mono break-all text-text">{getDaemonBaseUrl()}</span>. Invite people to its projects or
            pair another device:
          </p>
          {inviteControls}
        </div>
      )}
    </div>
  );
}
