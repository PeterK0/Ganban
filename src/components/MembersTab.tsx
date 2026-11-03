import { useEffect, useState } from 'react';
import ScrollArea from './ScrollArea';
import { confirmDialog } from '../lib/confirm';
import { QRCodeSVG } from 'qrcode.react';
import { getProjectMemberOverview, getUsers } from '../lib/api';
import { memberSetRole, memberRemove, createProjectInvite, pairMemberDevice, inviteLink, tailscaleShare, daemonStatus, tokenRenewNote, type TokenExpiry } from '../lib/host';
import { currentDaemonUrl, isDesktopOnline, isTauri } from '../lib/daemon';
import { useProjectRole } from '../lib/projectRole';
import { isTailnetUrl } from '../lib/invite.pure';
import { TailnetUnreachableGate } from './TailnetUnreachableGate';
import { PairingDiagnostics } from './PairingDiagnostics';
import type { ProjectMemberOverview, User } from '../types';

function fmtDuration(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  if (m) return `${m}m`;
  return `${seconds}s`;
}

/** Parse the host's datetime (ISO with Z, or SQLite "YYYY-MM-DD HH:MM:SS" in UTC). */
function parseTs(s?: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function presence(lastSeen?: string | null): { label: string; online: boolean } {
  const d = parseTs(lastSeen);
  if (!d) return { label: 'never connected', online: false };
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 5) return { label: 'online', online: true };
  if (mins < 60) return { label: `${mins}m ago`, online: false };
  if (mins < 1440) return { label: `${Math.floor(mins / 60)}h ago`, online: false };
  if (mins < 43200) return { label: `${Math.floor(mins / 1440)}d ago`, online: false };
  return { label: d.toLocaleDateString(), online: false };
}

const ROLE_BADGE: Record<string, string> = {
  owner: 'g-tag-hi',
  admin: 'g-tag-ok',
  member: '',
};

/** A read-only field + Copy button with its own transient "Copied" feedback, so
 * several can coexist (the two-step invite shows one per link). */
function CopyField({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={value} className="g-field g-field-sm flex-1 min-w-0" />
      <button
        onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
        className="g-btn g-btn-gilt g-btn-sm shrink-0"
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Project Members tab: who has access (role), connection status, and how long
 * each person has tracked on which tasks. */
export default function MembersTab({ projectId }: { projectId: number }) {
  const [members, setMembers] = useState<ProjectMemberOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [addUserId, setAddUserId] = useState<number | ''>('');
  const [addRole, setAddRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ token: string; url: string | null; link: string | null; ts?: string | null; shareError?: string | null; tokenExpiry?: TokenExpiry | null } | null>(null);
  // A pairing code minted FOR one member (owner only): signs a new device in as
  // their existing account — a Home Screen app, a new phone, a cleared browser.
  const [pairing, setPairing] = useState<{ userId: number; name: string; token: string; link: string | null } | null>(null);
  // Reveal an off-tailnet-unreachable link only after an explicit confirm (the
  // recipient is already on the host's tailnet). Reset per invite.
  const [revealTailnet, setRevealTailnet] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    getProjectMemberOverview(projectId)
      .then(setMembers)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [projectId]);
  useEffect(() => {
    getUsers().then(setAllUsers).catch(() => {});
  }, []);

  // Who I am on this project's host (lib/projectRole). My role is read from this tab's
  // own member list, so a role change shows at once.
  const { myId, isOwner } = useProjectRole(projectId);
  const myRole = members.find((m) => m.user_id === myId)?.role;
  // The host's owner (from any device) or an owner/admin of this project may manage
  // members. Minting a device credential for someone else is the host owner's alone.
  const canManage = isOwner || myRole === 'owner' || myRole === 'admin';
  const candidates = allUsers.filter((u) => !members.some((m) => m.user_id === u.id));

  const addExisting = async () => {
    if (!addUserId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await memberSetRole(projectId, Number(addUserId), addRole);
      setAddUserId('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (userId: number, role: string) => {
    setBusy(true);
    setError(null);
    try {
      await memberSetRole(projectId, userId, role);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (userId: number, name: string) => {
    if (!(await confirmDialog(`Remove ${name} from this project? Their tracked time stays on the record; they just lose access.`))) return;
    setBusy(true);
    setError(null);
    try {
      await memberRemove(projectId, userId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The link must point at an address the RECIPIENT can reach. On a remote
  // client, getDaemonBaseUrl() is already the host's URL. But when you generate
  // a link ON the host, getDaemonBaseUrl() is the loopback (127.0.0.1) — useless
  // to share — so use the host's reachable tailnet/LAN address from daemon
  // status instead, and return null if the host has no shareable address yet.
  const shareableHostUrl = async (): Promise<string | null> => {
    // web client = the page origin (the address the recipient also reaches).
    let url: string | null = currentDaemonUrl();
    if (!isDesktopOnline() && isTauri()) {
      url = null;
      try {
        const st = await daemonStatus();
        if (st.urls?.length) url = st.urls[0];
      } catch { /* no reachable address — fall through to token-only */ }
    }
    return url;
  };

  const pairDevice = async (userId: number, name: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInvite(null);
    try {
      const token = await pairMemberDevice(userId);
      const url = await shareableHostUrl();
      setPairing({ userId, name, token, link: url ? inviteLink(url, token) : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const genInvite = async () => {
    setBusy(true);
    setError(null);
    setPairing(null);
    try {
      const token = await createProjectInvite(projectId, addRole);
      const url = await shareableHostUrl();
      // Best-effort: fold a Tailscale device-share into the link if the host has
      // auto-share configured. `error` is surfaced (not swallowed) so a
      // misconfigured credential — e.g. missing the device-invites scope —
      // is visible rather than silently producing a share-less link.
      const share = await tailscaleShare();
      setRevealTailnet(false);
      // Keep the bare host `url` separately from `link` — the gate displays the
      // address as text, and `link` carries the one-time token in its fragment.
      setInvite({ token, url, link: url ? inviteLink(url, token, share.ts ?? undefined) : null, ts: share.ts, shareError: share.error, tokenExpiry: share.tokenExpiry });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The tailnet link is hidden behind TailnetUnreachableGate (no share, off-tailnet
  // unreachable) — suppress the redundant advisories below while it's showing.
  const inviteGated = !!(invite?.link && !invite.ts && isTailnetUrl(invite.link) && !revealTailnet);

  return (
    <ScrollArea className="flex-1 bg-mantle">
      <div className="px-8 pt-7 pb-16">
        <div className="flex items-center justify-between gap-4 mb-2">
          <h1 className="g-ptitle text-text">Members</h1>
          <button onClick={load} className="g-btn g-btn-ghost g-btn-sm">
            Refresh
          </button>
        </div>
        <p className="text-sm text-[color:var(--g-fg2)] max-w-[72ch] mb-6">
          Who has access, their connection status, and time tracked on this project.
        </p>

        {canManage && (
          <section className="g-card g-corners px-6 pt-6 pb-5 mb-7 space-y-3" aria-label="Add a member">
            <h2 className="g-h2">Add a member</h2>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value ? Number(e.target.value) : '')}
                className="g-field flex-1 min-w-[180px]"
              >
                <option value="">Pick an existing person…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} (@{u.username})
                  </option>
                ))}
              </select>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as 'member' | 'admin')}
                className="g-field w-auto"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
              <button
                onClick={addExisting}
                disabled={!addUserId || busy}
                className="g-btn g-btn-pri"
              >
                Add
              </button>
              <button
                onClick={genInvite}
                disabled={busy}
                className="g-btn g-btn-ghost"
              >
                Invite by link…
              </button>
            </div>
            {invite && (
              <div className="text-sm space-y-3">
                {tokenRenewNote(invite.tokenExpiry) && (
                  <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1.5">{tokenRenewNote(invite.tokenExpiry)}</p>
                )}
                {invite.link ? (
                  invite.ts ? (
                    // The recipient is on a DIFFERENT tailnet and scanning with a
                    // phone camera (no app yet to run the in-app accept step), so
                    // it's genuinely two steps: accept the shared machine first
                    // (a public Tailscale page), THEN open the host join link
                    // (only reachable once the share is accepted).
                    <>
                      <div className="g-plain p-3 space-y-2">
                        <div className="text-xs font-semibold text-text">Step 1 · Add this Mac to their Tailscale</div>
                        <p className="text-[11px] text-subtext-0">
                          They scan this and accept — it puts <em>only this machine</em> on their tailnet (needs their own Tailscale account; gives no access to your other devices or files).
                        </p>
                        <CopyField value={invite.ts} />
                        <div className="flex items-center gap-3">
                          <div className="bg-white p-2 rounded-lg shrink-0">
                            <QRCodeSVG value={invite.ts} size={120} />
                          </div>
                          <p className="text-[11px] text-subtext-0">Scan to accept the shared machine.</p>
                        </div>
                      </div>
                      <div className="g-plain p-3 space-y-2">
                        <div className="text-xs font-semibold text-text">Step 2 · Join the project</div>
                        <p className="text-[11px] text-subtext-0">
                          After Step 1 this opens in their browser — no install. They land on the join screen as a member of <em>this project only</em>.
                        </p>
                        <CopyField value={invite.link} />
                        <div className="flex items-center gap-3">
                          <div className="bg-white p-2 rounded-lg shrink-0">
                            <QRCodeSVG value={invite.link} size={120} />
                          </div>
                          <p className="text-[11px] text-subtext-0">Scan to join.</p>
                        </div>
                      </div>
                      <p className="text-xs text-subtext-0">Both are one-time.</p>
                    </>
                  ) : isTailnetUrl(invite.link) && !revealTailnet ? (
                    // Tailnet (100.x) link with no share attached: unreachable to
                    // anyone off the tailnet — gate it behind an explicit confirm.
                    <TailnetUnreachableGate
                      url={invite.url ?? invite.link}
                      shareError={invite.shareError}
                      onClose={() => setInvite(null)}
                      onReveal={() => setRevealTailnet(true)}
                      onManualShare={(ts) =>
                        setInvite({ ...invite, ts, shareError: null, link: invite.url ? inviteLink(invite.url, invite.token, ts) : invite.link })
                      }
                    />
                  ) : (
                    // Same-tailnet recipient (or auto-share off): the host link
                    // alone is reachable, so a single QR is enough.
                    <>
                      <CopyField value={invite.link} />
                      <div className="flex items-center gap-3">
                        <div className="bg-white p-2 rounded-lg shrink-0">
                          <QRCodeSVG value={invite.link} size={128} />
                        </div>
                        <p className="text-xs text-subtext-0">
                          Scan with a phone camera — it opens the join link in a browser; the host serves the join screen, no install needed.
                        </p>
                      </div>
                    </>
                  )
                ) : (
                  <p className="text-subtext-0">
                    Invite token (this host has no shareable address yet — is it on your tailnet?): <span className="text-text break-all">{invite.token}</span>
                  </p>
                )}
                {invite.shareError && !inviteGated && (
                  <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1.5">
                    Couldn't attach a Tailscale share: {invite.shareError}. Until that's fixed, the link only works if the recipient can already reach this host — same tailnet, or share the machine to them manually.
                  </p>
                )}
                {invite.link && !invite.ts && !invite.shareError && !inviteGated && (
                  <p className="text-xs text-subtext-0">
                    One-time link. If the recipient is on a different tailnet, set up auto-share (Settings → Sync → Tailscale) so the invite adds a one-tap share of this machine — otherwise they can't reach this host.
                  </p>
                )}
                {invite.link && (
                  <PairingDiagnostics
                    url={invite.url ?? invite.link}
                    token={invite.token}
                    ts={invite.ts}
                    shareError={invite.shareError}
                  />
                )}
              </div>
            )}
            <p className="text-[11px] text-subtext-0">
              Existing people are added instantly (their login already works); a link is for someone new.
            </p>
          </section>
        )}

        {error && (
          <div className="text-sm text-error bg-error/10 border border-error/30 rounded px-3 py-2 mb-4">{error}</div>
        )}

        {loading ? (
          <p className="text-sm text-subtext-0">Loading…</p>
        ) : members.length === 0 ? (
          <p className="text-sm text-subtext-0 italic">No members yet.</p>
        ) : (
          <div className="grid gap-3 items-start grid-cols-[repeat(auto-fill,minmax(min(100%,440px),1fr))]">
            {members.map((m) => {
              const pres = presence(m.last_seen_at);
              const joined = parseTs(m.joined_at);
              const isOpen = expanded === m.user_id;
              const hasTime = m.by_task.length > 0;
              return (
                <div key={m.user_id} className="g-card overflow-hidden">
                  <button
                    onClick={() => hasTime && setExpanded(isOpen ? null : m.user_id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left ${hasTime ? 'hover:bg-gilt-b' : 'cursor-default'}`}
                  >
                    <div className="g-av !w-10 !h-10 !text-sm">
                      {m.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-text font-medium truncate">{m.display_name}</span>
                        <span className={`g-tag !min-h-[20px] !px-2 !text-[11px] ${ROLE_BADGE[m.role] ?? ROLE_BADGE.member}`}>
                          {m.role}
                        </span>
                      </div>
                      <div className="text-xs text-subtext-0 flex items-center gap-2 mt-0.5">
                        <span className="flex items-center gap-1">
                          <span className={`w-2 h-2 rounded-full ${pres.online ? 'bg-success' : 'bg-overlay-0'}`} />
                          {pres.label}
                        </span>
                        {joined && <span>· joined {joined.toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-medium text-text">{fmtDuration(m.total_seconds)}</div>
                      <div className="text-[11px] text-subtext-0">{hasTime ? (isOpen ? 'hide tasks ▴' : 'by task ▾') : 'tracked'}</div>
                    </div>
                  </button>

                  {canManage && m.role !== 'owner' && (
                    <div className="border-t border-gilt-b px-4 py-2 flex items-center justify-end gap-2">
                      {isOwner && (
                        <button
                          onClick={() => void pairDevice(m.user_id, m.display_name)}
                          disabled={busy}
                          className="mr-auto g-btn g-btn-ghost g-btn-sm"
                          title="A one-time code that signs a new device in as this person — a Home Screen app, a new phone, a cleared browser"
                        >
                          Pair a device…
                        </button>
                      )}
                      <label className="text-[11px] text-subtext-0 flex items-center gap-1.5">
                        role
                        <select
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => void changeRole(m.user_id, e.target.value)}
                          className="g-field g-field-sm w-auto"
                        >
                          <option value="member">member</option>
                          <option value="admin">admin</option>
                        </select>
                      </label>
                      <button
                        onClick={() => void removeMember(m.user_id, m.display_name)}
                        disabled={busy}
                        className="g-btn g-btn-danger g-btn-sm"
                      >
                        Remove
                      </button>
                    </div>
                  )}

                  {pairing?.userId === m.user_id && (
                    <div className="border-t border-gilt-b px-4 py-3 space-y-2 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs text-subtext-0">
                          Signs a new device in as <span className="text-text">{pairing.name}</span> — same account, nothing duplicated. They
                          paste the code (or open the link) on that device's Join screen. One use, 24 h.
                        </p>
                        <button onClick={() => setPairing(null)} className="g-iconbtn !w-8 !h-8 shrink-0" aria-label="Close">✕</button>
                      </div>
                      <div>
                        <div className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)] mb-1">Code</div>
                        <CopyField value={pairing.token} />
                      </div>
                      {pairing.link ? (
                        <div className="flex items-center gap-3">
                          <div className="bg-white p-2 rounded-lg shrink-0">
                            <QRCodeSVG value={pairing.link} size={112} />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="g-deco text-[11px] font-semibold text-[color:var(--g-mut)]">Link</div>
                            <CopyField value={pairing.link} />
                            <p className="text-[11px] text-subtext-0">Scan or open on the new device. For an iPhone Home Screen app, paste the code instead.</p>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-subtext-0">No shareable host address yet — send the code; they paste it on the Join screen.</p>
                      )}
                    </div>
                  )}

                  {isOpen && hasTime && (
                    <div className="border-t border-gilt-b divide-y divide-gilt-b">
                      {m.by_task.map((t) => (
                        <div key={t.task_id} className="flex items-center justify-between gap-3 px-4 py-2">
                          <span className="text-sm text-subtext-1 truncate">{t.task_title}</span>
                          <span className="text-sm text-text shrink-0 font-mono">{fmtDuration(t.seconds)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-[color:var(--g-mut)] max-w-[72ch] mt-6">
          Tracked time is attributed per person from when this was added — time logged earlier isn't split by member.
          Connection status is the most recent activity from any of their devices.
        </p>
      </div>
    </ScrollArea>
  );
}
