import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getProjects } from '../lib/api';
import { contactInvite, contactAddToProject, pairMemberDevice, daemonStatus, inviteLink, tailscaleShare, tokenRenewNote, type TokenExpiry } from '../lib/host';
import { isTailnetUrl } from '../lib/invite.pure';
import { TailnetUnreachableGate } from './TailnetUnreachableGate';
import { PairingDiagnostics } from './PairingDiagnostics';
import type { Contact, Project } from '../types';
import { Modal } from './gilt';
import ScrollArea from './ScrollArea';
import { projectColorClass } from '../lib/projectColor';

const MUTED = 'text-[color:var(--g-mut)]';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Add a contact to a project, or invite them with a join link. A contact
 * linked to an account can be added directly (their existing login works);
 * otherwise inviting mints a join link that, once accepted, reuses the same
 * identity across future projects. */
export default function ContactProjectModal({
  contact,
  onClose,
  onChanged,
}: {
  contact: Contact;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | ''>('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // kind: 'invite' creates/attaches an account + membership; 'device' pairs a
  // NEW DEVICE to the contact's EXISTING account (recovery — lost phone, a
  // Home Screen app's separate sign-in). Same link format, same Join screen.
  const [invite, setInvite] = useState<{ kind: 'invite' | 'device'; token: string; url: string | null; ts?: string | null; shareError?: string | null; tokenExpiry?: TokenExpiry | null } | null>(null);
  const [copied, setCopied] = useState(false);
  // Gate an off-tailnet-unreachable link (tailnet url, no share) until confirmed.
  const [revealTailnet, setRevealTailnet] = useState(false);
  // Tracks linkage locally: generating an invite creates+links an account, so
  // the modal can switch to the "Add to project" affordance without a remount.
  const [linkedNow, setLinkedNow] = useState(contact.user_id != null);
  const linked = linkedNow;

  useEffect(() => {
    getProjects()
      .then((ps) => {
        const active = ps.filter((p) => !p.archived);
        setProjects(active);
        if (active[0]) setProjectId(active[0].id);
      })
      .catch((e) => setError(msg(e)));
  }, []);

  const add = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    setInvite(null);
    try {
      await contactAddToProject(contact.id, Number(projectId), role);
      const name = projects.find((p) => p.id === projectId)?.name ?? 'the project';
      setFlash(`Added ${contact.full_name} to ${name}.`);
      onChanged?.();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const genInvite = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    setInvite(null);
    try {
      const token = await contactInvite(contact.id, Number(projectId), role);
      let url: string | null = null;
      try {
        const st = await daemonStatus();
        url = st.urls[0] ?? null;
      } catch {
        /* not hosting locally — show the token without a link */
      }
      const share = await tailscaleShare(); // best-effort device-share, null if off
      setRevealTailnet(false);
      setInvite({ kind: 'invite', token, url, ts: share.ts, shareError: share.error, tokenExpiry: share.tokenExpiry });
      setLinkedNow(true); // an account was created + linked to the contact
      onChanged?.();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  /** Owner-side recovery: a one-time code that signs a new device in as this
   * contact's existing account. Membership is untouched (that's "Add"). */
  const genDevice = async () => {
    if (contact.user_id == null || busy) return;
    setBusy(true);
    setError(null);
    setFlash(null);
    setInvite(null);
    try {
      const token = await pairMemberDevice(contact.user_id);
      let url: string | null = null;
      try {
        const st = await daemonStatus();
        url = st.urls[0] ?? null;
      } catch {
        /* not hosting locally — show the token without a link */
      }
      const share = await tailscaleShare();
      setRevealTailnet(false);
      setInvite({ kind: 'device', token, url, ts: share.ts, shareError: share.error, tokenExpiry: share.tokenExpiry });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const link = invite?.url ? inviteLink(invite.url, invite.token, invite.ts ?? undefined) : null;

  return (
    <Modal onClose={onClose} title={`Add ${contact.full_name} to a project`} className="w-[480px]">
      <p className={`px-8 -mt-2 pb-4 text-[13px] text-center ${MUTED}`}>
        {linked
          ? 'This contact has an account — add them to a project, or pair a new device for them.'
          : "This contact has no account yet — invite them and they'll be reusable across projects."}
      </p>

          <ScrollArea className="flex-1 min-h-0 border-t border-gilt-b" contentClassName="px-6 py-5 space-y-4">
            {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded px-3 py-2">{error}</div>}
            {flash && <div className="text-sm text-success bg-success/10 border border-success/30 rounded px-3 py-2">{flash}</div>}

            <div>
              <label className="g-flbl">Project</label>
              <div className="flex items-center gap-2.5">
              {(() => {
                const sel = projects.find((p) => p.id === projectId);
                return sel ? <span className={`g-gem ${projectColorClass(sel)}`} aria-hidden="true" /> : null;
              })()}
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : '')}
                className="g-field"
              >
                {projects.length === 0 && <option value="">No projects</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              </div>
            </div>

            <div>
              <label className="g-flbl">Role</label>
              <div className="flex gap-1.5 w-fit">
                {(['member', 'admin'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRole(r)}
                    className={`inline-flex items-center min-h-[32px] px-3.5 rounded-full text-[13px] font-medium capitalize transition-colors ${
                      role === r
                        ? 'g-on'
                        : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* A linked contact already has an account: add them directly (no new
                credential). An unlinked contact gets a fresh-identity invite link. */}
            <div className="pt-1 space-y-2">
              {linked ? (
                <>
                  <button
                    onClick={add}
                    disabled={!projectId || busy}
                    className="g-btn g-btn-pri g-glint w-full"
                  >
                    Add to project
                  </button>
                  <button
                    onClick={genDevice}
                    disabled={busy}
                    className="g-btn g-btn-ghost w-full"
                    title="For a lost phone, a new computer, or a Home Screen app — signs that device in as this account"
                  >
                    {busy && invite?.kind !== 'invite' ? 'Creating code…' : `Pair a new device for ${contact.full_name}`}
                  </button>
                </>
              ) : (
                <button
                  onClick={genInvite}
                  disabled={!projectId || busy}
                  className="g-btn g-btn-pri g-glint w-full"
                >
                  {busy ? 'Creating invite…' : 'Generate invite link'}
                </button>
              )}
            </div>

            {invite && (
              <div className="border-t border-gilt-b pt-4 space-y-3">
                {tokenRenewNote(invite.tokenExpiry) && (
                  <p className="text-xs text-warning bg-warning/10 border border-warning/30 rounded px-2 py-1.5">{tokenRenewNote(invite.tokenExpiry)}</p>
                )}
                {link && !invite.ts && isTailnetUrl(invite.url!) && !revealTailnet ? (
                  <TailnetUnreachableGate
                    url={invite.url!}
                    shareError={invite.shareError}
                    onClose={() => setInvite(null)}
                    onReveal={() => setRevealTailnet(true)}
                    onManualShare={(ts) => setInvite({ ...invite, ts, shareError: null })}
                  />
                ) : link ? (
                  <>
                    <div className="flex justify-center">
                      <div className="bg-white p-3 rounded shadow-[0_0_0_1px_var(--color-gilt-a)]">
                        <QRCodeSVG value={link} size={160} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        readOnly
                        value={link}
                        className={`g-field flex-1 !text-xs`}
                      />
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(link).then(() => {
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          });
                        }}
                        className="g-btn g-btn-gilt"
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className={`text-xs ${MUTED}`}>
                      {invite.kind === 'device'
                        ? `Open this on ${contact.full_name}'s new device — or have them paste the code on its Join screen. It signs that device in as their existing account. One use, 24 h.`
                        : `Share this link or QR. It works once; accepting reuses ${contact.full_name}'s account.`}
                    </p>
                  </>
                ) : (
                  <p className={`text-sm ${MUTED}`}>
                    Invite created, but no host URL is available — start hosting (Sync settings) to share a join link, or copy
                    the token: <span className="text-text break-all">{invite.token}</span>
                  </p>
                )}
                {link && (
                  <PairingDiagnostics
                    url={invite.url!}
                    token={invite.token}
                    ts={invite.ts}
                    shareError={invite.shareError}
                  />
                )}
              </div>
            )}
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
