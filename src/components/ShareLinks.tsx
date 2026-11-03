import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './gilt';
import ScrollArea from './ScrollArea';
import {
  createShareLink,
  getShareDoor,
  listShareLinks,
  revokeShareLink,
  type ShareDoor,
  type ShareLink,
  type ShareScope,
} from '../lib/api';
import { confirmDialog } from '../lib/confirm';
import { fmtBytes } from '../lib/uploads';
import type { FileAttachment } from '../types';
import type { FileEntry } from './files/FileBrowser';

/**
 * Share links (docs/design/SHARE_LINKS.md): the modal that makes one, and the lists
 * of links with their downloads, for a task's Files tab and for Project >
 * Files. Only project admins and the owner see these; the host refuses
 * everyone else.
 */

/** A file the modal offers: a task attachment or a project's own file. */
export interface ShareFile {
  kind: 'attachment' | 'project';
  id: number;
  name: string;
  /** The folder it sits in inside the link (the zip's path), '' at the top. */
  folder: string;
  size: number;
  /** On the host; false for a file only on a member's device. */
  hosted: boolean;
}

export const shareKey = (f: { kind: string; id: number }) => `${f.kind}-${f.id}`;

const dirOf = (p: string | null | undefined) => {
  const i = (p ?? '').lastIndexOf('/');
  return i > 0 ? p!.slice(0, i) : '';
};

/** A task's folder in a link made from the project, as the host names it. */
const taskFolder = (title: string | undefined) =>
  [...(title ?? '').trim()].map((c) => (c === '/' || c === '\\' || c < ' ' ? '_' : c)).join('') || 'Untitled task';

/** A task's attachment, offered from its Files tab. */
export const attachmentShareFile = (a: FileAttachment): ShareFile => ({
  kind: 'attachment',
  id: a.id,
  name: a.file_name,
  folder: dirOf(a.rel_path),
  size: a.storage_size ?? a.file_size ?? 0,
  hosted: !!a.is_shared,
});

/** A file of Project > Files: a task's file sits under its task's folder. */
export const entryShareFile = (e: FileEntry): ShareFile => {
  const own = dirOf(e.relPath);
  const folder = e.kind === 'attachment' ? [taskFolder(e.taskTitle), own].filter(Boolean).join('/') : own;
  return { kind: e.kind, id: e.id, name: e.name, folder, size: e.size, hosted: e.shared };
};

/** Files grouped by folder: loose files first, then folders by path, their files by name. */
function groupByFolder(files: ShareFile[]): { folder: string; files: ShareFile[] }[] {
  const by = new Map<string, ShareFile[]>();
  for (const f of files) {
    if (!by.has(f.folder)) by.set(f.folder, []);
    by.get(f.folder)!.push(f);
  }
  const keys = [...by.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  return keys.map((folder) => ({ folder, files: by.get(folder)!.sort((a, b) => a.name.localeCompare(b.name)) }));
}

const STATUS_LABEL: Record<ShareLink['status'], string> = { active: 'Active', preparing: 'Preparing', expired: 'Expired', revoked: 'Revoked' };
const STATUS_TAG: Record<ShareLink['status'], string> = { active: 'g-tag-ok', preparing: 'g-tag-warn', expired: '', revoked: 'g-tag-red' };

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function DoorNote({ door }: { door: ShareDoor | null }) {
  if (!door || (door.enabled && door.publicUrl)) return null;
  return (
    <p className="g-inset text-[13px] text-subtext-1">
      This host has no public share door yet, so the link can be made but can’t be opened from outside. Links work once
      the share door is set up: see <span className="font-mono text-text">docs/host/SELF_HOSTING.md</span> § Share links.
    </p>
  );
}

function CopyButton({ url, small = true }: { url: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        void copyText(url).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 1500);
        })
      }
      className={`g-btn ${small ? 'g-btn-sm' : ''} g-btn-gilt`}
      title="Copy the link"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** The modal that makes a link: a task's files, or a project's (its own and its tasks'). */
export function ShareLinkModal({
  scope,
  title,
  files,
  initial,
  door,
  onClose,
  onCreated,
}: {
  scope: ShareScope;
  /** The task's or project's title: the label when the files share no top folder. */
  title: string;
  files: ShareFile[];
  /** The keys ticked to begin with (`shareKey`); default every host-stored file. */
  initial?: string[];
  door: ShareDoor | null;
  onClose: () => void;
  onCreated: (link: ShareLink) => void;
}) {
  const hosted = useMemo(() => files.filter((f) => f.hosted), [files]);
  const deviceOnly = useMemo(() => files.filter((f) => !f.hosted), [files]);
  const groups = useMemo(() => groupByFolder(files), [files]);
  const [picked, setPicked] = useState<Set<string>>(() => {
    const ok = new Set(hosted.map(shareKey));
    return new Set(initial ? initial.filter((k) => ok.has(k)) : ok);
  });
  const [label, setLabel] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [expiry, setExpiry] = useState<'1' | '7' | '30' | 'never'>('7');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<ShareLink | null>(null);

  // The label the host would pick: the folder's name when every chosen file
  // shares one top folder, else the task's title.
  const defaultLabel = useMemo(() => {
    const chosen = hosted.filter((f) => picked.has(shareKey(f)));
    const tops = new Set(chosen.map((f) => f.folder.split('/')[0]));
    const [only] = [...tops];
    return tops.size === 1 && only ? only : title;
  }, [hosted, picked, title]);
  useEffect(() => {
    if (!labelTouched) setLabel(defaultLabel);
  }, [defaultLabel, labelTouched]);

  // Preparing: the host computes the zip's checksums; poll until it's ready.
  useEffect(() => {
    if (!made || made.status !== 'preparing') return;
    const t = setInterval(() => {
      listShareLinks(scope)
        .then((links) => {
          const now = links.find((l) => l.id === made.id);
          if (now && now.status !== made.status) setMade(now);
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [made]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the first ticked file into view: a folder picked in a big project may sit far down.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('input:checked')?.closest('label')?.scrollIntoView({ block: 'nearest' });
  }, []);

  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const chosen = hosted.filter((f) => picked.has(shareKey(f)));
  const chosenBytes = chosen.reduce((n, f) => n + f.size, 0);

  async function create() {
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const of = (kind: ShareFile['kind']) => chosen.filter((f) => f.kind === kind).map((f) => f.id);
      const link = await createShareLink({
        ...scope,
        attachmentIds: of('attachment'),
        ...('projectId' in scope ? { projectFileIds: of('project') } : {}),
        label: label.trim() || undefined,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
        password: password || undefined,
      });
      setMade(link);
      onCreated(link);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    return (
      <Modal onClose={onClose} title="Share link" className="w-[min(560px,calc(100vw-32px))]">
        <div className="px-6 pb-6 space-y-3">
          <p className="text-[13px] text-subtext-1">
            <b className="text-text">{made.label}</b> · {made.fileCount} file{made.fileCount === 1 ? '' : 's'} ·{' '}
            {fmtBytes(made.totalBytes)} · {made.expiresAt ? `expires ${fmtDay(made.expiresAt)}` : 'never expires'}
            {made.hasPassword ? ' · password' : ''}
          </p>
          {made.url ? (
            <div className="flex gap-2">
              <input readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} className="g-field flex-1 font-mono text-[13px]" aria-label="The link" />
              <CopyButton url={made.url} small={false} />
            </div>
          ) : (
            <p className="text-[13px] text-subtext-1">
              The link’s path is <span className="font-mono text-text">{made.path}</span>; it gets a public address once the share door is set up.
            </p>
          )}
          {made.status === 'preparing' && (
            <p className="text-[13px] text-subtext-0" role="status">
              Preparing… the host is checking the files for the download. The link works once this is done.
            </p>
          )}
          {made.status === 'active' && <p className="text-[13px] text-success" role="status">Ready.</p>}
          <DoorNote door={door} />
          <div className="flex justify-end">
            <button onClick={onClose} className="g-btn g-btn-pri">Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Share link" className="w-[min(600px,calc(100vw-32px))]">
      <div className="px-6 pb-6 space-y-4">
        <DoorNote door={door} />
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <span className="g-flbl !mb-0">Files</span>
            <span className="text-[12px] text-subtext-0 tabular-nums">
              {chosen.length} of {hosted.length} · {fmtBytes(chosenBytes)}
            </span>
          </div>
          {/* ScrollArea's viewport is h-full: it needs a real height. */}
          <div ref={listRef} className="g-inset !p-0" style={{ height: Math.min(300, Math.max(44, files.length * 32 + groups.filter((g) => g.folder).length * 36 + 8)) }}>
          <ScrollArea className="h-full">
            {groups.map(({ folder, files: gf }) => {
              const ids = gf.filter((f) => f.hosted).map(shareKey);
              const on = ids.filter((id) => picked.has(id)).length;
              return (
                <div key={folder || '.'} className="border-b border-gilt-b last:border-b-0">
                  {folder && (
                    <label className="flex items-center gap-2 px-3 py-2 text-[13px] font-medium text-text cursor-pointer">
                      <input
                        type="checkbox"
                        disabled={ids.length === 0}
                        checked={ids.length > 0 && on === ids.length}
                        ref={(el) => {
                          if (el) el.indeterminate = on > 0 && on < ids.length;
                        }}
                        onChange={(e) => toggle(ids, e.target.checked)}
                      />
                      <span className="truncate flex-1" title={folder}>📁 {folder}</span>
                      <span className="text-[12px] text-subtext-0 tabular-nums">{gf.length}</span>
                    </label>
                  )}
                  {gf.map((f) => (
                    <label
                      key={shareKey(f)}
                      className={`flex items-center gap-2 py-1.5 pr-3 text-[13px] ${folder ? 'pl-8' : 'pl-3'} ${f.hosted ? 'cursor-pointer' : 'opacity-60'}`}
                    >
                      <input type="checkbox" disabled={!f.hosted} checked={picked.has(shareKey(f))} onChange={(e) => toggle([shareKey(f)], e.target.checked)} />
                      <span className="truncate flex-1 text-text" title={f.folder ? `${f.folder}/${f.name}` : f.name}>{f.name}</span>
                      {f.hosted ? (
                        <span className="text-[12px] text-subtext-0 tabular-nums">{fmtBytes(f.size)}</span>
                      ) : (
                        <span className="text-[12px] text-subtext-0">on a device · upload first</span>
                      )}
                    </label>
                  ))}
                </div>
              );
            })}
            {files.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-subtext-0">{'taskId' in scope ? 'This task' : 'This project'} has no files yet.</p>
            )}
          </ScrollArea>
          </div>
          {deviceOnly.length > 0 && (
            <p className="text-[12px] text-subtext-0 mt-1.5">
              {deviceOnly.length} file{deviceOnly.length === 1 ? ' is' : 's are'} only on a member’s device; upload {deviceOnly.length === 1 ? 'it' : 'them'} to the host first to share {deviceOnly.length === 1 ? 'it' : 'them'}.
            </p>
          )}
        </div>
        <label className="block">
          <span className="g-flbl">Label</span>
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setLabelTouched(true);
            }}
            className="g-field w-full"
            maxLength={200}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="g-flbl">Expires</span>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)} className="g-field w-full">
              <option value="1">In 1 day</option>
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="never">Never</option>
            </select>
          </label>
          <label className="block">
            <span className="g-flbl">Password (optional)</span>
            <div className="flex gap-1.5">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="g-field flex-1 min-w-0"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="g-btn g-btn-ghost"
                aria-pressed={showPassword}
                title={showPassword ? 'Hide the password' : 'Show the password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
        </div>
        {error && <p className="text-[13px] text-error" role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="g-btn g-btn-ghost">Cancel</button>
          <button onClick={() => void create()} disabled={busy || chosen.length === 0} className="g-btn g-btn-pri">
            {busy ? 'Creating…' : 'Create link'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A task's or a project's links, the share door, and revoking; polls while one is preparing. */
function useShareLinks(scope: ShareScope) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [door, setDoor] = useState<ShareDoor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const key = 'taskId' in scope ? `t${scope.taskId}` : `p${scope.projectId}`;
  // A reply for a task or project left meanwhile is dropped.
  const current = useRef(key);
  current.current = key;

  const load = useCallback(() => {
    const asked = key;
    const fresh = () => alive.current && current.current === asked;
    listShareLinks(scope)
      .then((l) => {
        if (!fresh()) return;
        setLinks(l);
        setError(null);
      })
      .catch((e) => fresh() && setError(e instanceof Error ? e.message : String(e)));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLinks(null);
    load();
    getShareDoor()
      .then((d) => alive.current && setDoor(d))
      .catch(() => {});
  }, [load]);

  // A link that's preparing turns active in a few seconds per GB.
  const preparing = links?.some((l) => l.status === 'preparing');
  useEffect(() => {
    if (!preparing) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [preparing, load]);

  const revoke = async (l: ShareLink) => {
    if (!(await confirmDialog(`Revoke the link “${l.label}”? Anyone who has it loses access at once.`))) return;
    try {
      await revokeShareLink(l.id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return { links, door, error, load, revoke };
}

/** The links, newest first: status, expiry, downloads, Copy and Revoke. */
function LinkRows({ links, onRevoke, origin }: { links: ShareLink[]; onRevoke: (l: ShareLink) => void; origin?: (l: ShareLink) => string | null }) {
  return (
    <div className="border-t border-gilt-b">
      {links.map((l) => {
        const live = l.status === 'active' || l.status === 'preparing';
        const from = origin?.(l);
        return (
          <div key={l.id} className="g-frow py-2.5 px-1 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`font-medium truncate ${live ? 'text-text' : 'text-subtext-0'}`} title={l.label}>{l.label}</span>
                <span className={`g-tag ${STATUS_TAG[l.status]} shrink-0`}>{STATUS_LABEL[l.status]}</span>
                {l.hasPassword && <span className="g-tag shrink-0" title="Needs a password">🔒</span>}
              </div>
              <p className="text-[12px] text-subtext-0 mt-0.5 tabular-nums">
                {l.fileCount} file{l.fileCount === 1 ? '' : 's'} · {fmtBytes(l.totalBytes)} ·{' '}
                {l.status === 'revoked' && l.revokedAt
                  ? `revoked ${fmtDay(l.revokedAt)}`
                  : l.expiresAt
                    ? `${l.status === 'expired' ? 'expired' : 'expires'} ${fmtDay(l.expiresAt)}`
                    : 'never expires'}
                {from ? ` · ${from}` : ''}
              </p>
              <p className="text-[12px] text-subtext-0 tabular-nums">
                {l.downloadCount === 0
                  ? 'No downloads yet'
                  : `${l.downloadCount} download${l.downloadCount === 1 ? '' : 's'}${l.lastDownloadAt ? ` · last ${fmtWhen(l.lastDownloadAt)}` : ''}`}
              </p>
            </div>
            {live && (
              <div className="flex items-center gap-1 shrink-0">
                {l.url && <CopyButton url={l.url} />}
                <button onClick={() => onRevoke(l)} className="g-btn g-btn-sm g-btn-danger">Revoke</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The task's links under its files, with the "Share link…" button. */
export default function TaskShareLinks({ taskId, taskTitle, files }: { taskId: number; taskTitle: string; files: FileAttachment[] }) {
  const { links, door, error, load, revoke } = useShareLinks({ taskId });
  const [open, setOpen] = useState(false);
  const offered = useMemo(() => files.map(attachmentShareFile), [files]);

  return (
    <section className="flex flex-col gap-2" aria-label="Share links">
      <div className="flex items-center justify-between gap-2">
        <span className="g-cap">Share links</span>
        <button onClick={() => setOpen(true)} className="g-btn g-btn-sm g-btn-gilt">Share link…</button>
      </div>
      {error && <p className="text-[13px] text-error">{error}</p>}
      {links && links.length === 0 && (
        <p className="text-[13px] text-subtext-0">No links yet. A link gives someone outside the team this task’s files, with no account.</p>
      )}
      {links && links.length > 0 && <LinkRows links={links} onRevoke={(l) => void revoke(l)} />}
      {open && (
        <ShareLinkModal scope={{ taskId }} title={taskTitle} files={offered} door={door} onClose={() => setOpen(false)} onCreated={load} />
      )}
    </section>
  );
}

const OPEN_KEY = 'ganban:files-share-links-open';

/**
 * Project > Files: the project's links (made from its Files or any of its
 * tasks) in a collapsible section under the browser, and the modal, opened
 * with `shareWith` (the files to tick) by the browser's "Share link…".
 */
export function ProjectShareLinks({
  projectId,
  projectName,
  entries,
  shareWith,
  onShareClosed,
  taskTitle,
}: {
  projectId: number;
  projectName: string;
  entries: FileEntry[];
  /** The browser asked for a link with these files ticked; null when the modal is shut. */
  shareWith: FileEntry[] | null;
  onShareClosed: () => void;
  taskTitle: (taskId: number) => string | undefined;
}) {
  const { links, door, error, load, revoke } = useShareLinks({ projectId });
  // Whether the section is open: a cosmetic preference.
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === '1');
  const toggle = (on: boolean) => {
    setOpen(on);
    localStorage.setItem(OPEN_KEY, on ? '1' : '0');
  };
  const offered = useMemo(() => entries.map(entryShareFile), [entries]);
  const live = links?.filter((l) => l.status === 'active' || l.status === 'preparing').length ?? 0;
  const origin = (l: ShareLink) => (l.taskId == null ? null : `from task “${taskTitle(l.taskId) ?? `#${l.taskId}`}”`);

  return (
    <section className="shrink-0 border-t border-gilt-b bg-base" aria-label="Share links">
      <button
        onClick={() => toggle(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 min-h-10 text-left hover:bg-surface-0"
      >
        <span className={`text-subtext-0 text-lg leading-none w-4 text-center transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ›
        </span>
        <span className="g-cap">Share links</span>
        {links && (
          <span className="text-[12px] text-subtext-0 tabular-nums">
            {links.length === 0 ? 'none yet' : `${live} live · ${links.length} in all`}
          </span>
        )}
      </button>
      {open && (
        <div className="g-reveal px-4 pb-3" style={{ height: links && links.length > 2 ? 260 : undefined }}>
          {error && <p className="text-[13px] text-error mb-2">{error}</p>}
          {links && links.length === 0 && (
            <p className="text-[13px] text-subtext-0">
              No links yet. Select files or a folder and choose “Share link…” to give someone outside the team a download, with no account.
            </p>
          )}
          {links && links.length > 0 &&
            (links.length > 2 ? (
              <ScrollArea className="h-full" contentClassName="pr-3">
                <LinkRows links={links} onRevoke={(l) => void revoke(l)} origin={origin} />
              </ScrollArea>
            ) : (
              <LinkRows links={links} onRevoke={(l) => void revoke(l)} origin={origin} />
            ))}
        </div>
      )}
      {shareWith && (
        <ShareLinkModal
          scope={{ projectId }}
          title={projectName}
          files={offered}
          initial={shareWith.map(shareKey)}
          door={door}
          onClose={onShareClosed}
          onCreated={() => {
            load();
            toggle(true);
          }}
        />
      )}
    </section>
  );
}
