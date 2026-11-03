// Settings → Updates: this app's update (desktop: checks on open, downloads in the
// background, "Restart to update"), the owner's "Update the server" card with the
// host update's live log, and the advanced first-install downloads. ADR 0007, docs/design/UPDATES.md. A build from GitHub
// Releases updates from GitHub instead, behind the "Check GitHub for new
// versions" switch (ADR 0008).
import { useEffect, useRef, useState } from 'react';
import ScrollArea from './ScrollArea';
import { ShareBuildsPanel } from './ShareBuildsPanel';
import { confirmDialog } from '../lib/confirm';
import {
  appVersion,
  checkForUpdate,
  describeUpdateState,
  downloadPercent,
  getClientBuilds,
  getHostUpdateStatus,
  isDesktopApp,
  canUpdateHost,
  restartToUpdate,
  startHostUpdate,
  updateHost,
  useUpdateState,
  type ClientBuilds,
  type HostUpdateStatus,
} from '../lib/update';
import { HOST_POLL_MS, hostClientApps, keepPolling, nextHostPoll, type HostPoll } from '../lib/update.pure';
import { UPDATE_CHANNEL, setGithubChecksOn, useGithubChecksOn } from '../lib/updateChannel';

const fmtSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function UpdatesPanel() {
  return (
    <>
      <ThisAppCard />
      <HostUpdateCard />
    </>
  );
}

function ThisAppCard() {
  const desktop = isDesktopApp();
  // A desktop build from GitHub Releases: it asks GitHub, never the host.
  const github = desktop && UPDATE_CHANNEL.kind === 'github' ? UPDATE_CHANNEL.repo : null;
  const githubBroken = desktop && UPDATE_CHANNEL.kind === 'github-broken';
  const githubOn = useGithubChecksOn();
  const st = useUpdateState();
  const [version, setVersion] = useState('');
  const [builds, setBuilds] = useState<ClientBuilds | null>(null);
  const [buildsErr, setBuildsErr] = useState<string | null>(null);
  const [restartErr, setRestartErr] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const host = updateHost();

  const loadBuilds = () => {
    if (github || githubBroken) return;
    setBuildsErr(null);
    getClientBuilds()
      .then(setBuilds)
      .catch((e) => setBuildsErr(why(e)));
  };

  useEffect(() => {
    void appVersion().then(setVersion);
    loadBuilds();
    void checkForUpdate(); // Settings → Updates opening is one of the check's moments
  }, []);

  const restart = async () => {
    setRestarting(true);
    setRestartErr(null);
    try {
      await restartToUpdate();
    } catch (e) {
      setRestartErr(why(e));
      setRestarting(false);
    }
  };

  const toggleGithub = () => {
    setGithubChecksOn(!githubOn);
    if (!githubOn) void checkForUpdate(); // turned on: check now (the switch's state is already stored)
  };

  // Off, an idle or finished check has nothing to say; a download already under way finishes.
  const githubOff = !!github && !githubOn && (st.kind === 'idle' || st.kind === 'up-to-date' || st.kind === 'failed');
  const pct = downloadPercent(st);
  const tag =
    st.kind === 'up-to-date' ? 'g-tag-ok' : st.kind === 'ready' ? 'g-tag-pri' : st.kind === 'failed' ? 'g-tag-red' : st.kind === 'unsupported' ? 'g-tag-warn' : '';
  const busy = st.kind === 'checking' || st.kind === 'downloading';

  return (
    <div className="g-card p-5 space-y-3">
      <div className="g-stitle">This app</div>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-subtext-0">Version</dt>
        <dd className="text-text tabular-nums">{desktop ? version || '…' : 'Served live by the host'}</dd>
        {github || githubBroken ? (
          <>
            <dt className="text-subtext-0">Updates from</dt>
            <dd className="text-subtext-1 truncate">GitHub Releases{github ? ` · ${github}` : ''}</dd>
          </>
        ) : (
          <>
            <dt className="text-subtext-0">Host's desktop build</dt>
            <dd className="text-text">
              {buildsErr ? (
                <span className="text-subtext-0">{buildsErr}</span>
              ) : !builds ? (
                '…'
              ) : builds.desktop ? (
                <>
                  <span className="tabular-nums">{builds.desktop.version}</span>
                  <span className="text-subtext-0">
                    {' '}· {builds.desktop.target}-{builds.desktop.arch} · {fmtSize(builds.desktop.size)} · {fmtDate(builds.desktop.pubDate)}
                  </span>
                </>
              ) : (
                <span className="text-subtext-0">None yet. The host builds one when it updates.</span>
              )}
            </dd>
            {host && (
              <>
                <dt className="text-subtext-0">Updates from</dt>
                <dd className="text-subtext-1 truncate" title={host.url}>{host.label} · {host.url}</dd>
              </>
            )}
          </>
        )}
      </dl>

      {github && (
        <div className="g-togrow border-t border-gilt-b">
          <span id="upd-github" className="flex-1 min-w-0">
            <span className="block font-semibold text-text">Check GitHub for new versions</span>
            <span className="block text-xs text-subtext-0">
              Asks github.com for the latest release at launch and every 6 hours. Off, this app never contacts GitHub.
            </span>
          </span>
          <button onClick={toggleGithub} role="switch" aria-checked={githubOn} aria-labelledby="upd-github" className="g-tog">
            <span className="g-tog-k" />
          </button>
        </div>
      )}

      {desktop ? (
        <div className="g-inset space-y-2">
          <div className="flex items-center gap-2 text-sm">
            {tag && !githubOff && <span className={`g-tag ${tag}`}>{st.kind === 'up-to-date' ? 'Up to date' : st.kind === 'ready' ? 'Ready' : st.kind === 'failed' ? 'Failed' : 'Unavailable'}</span>}
            <span className="text-text min-w-0">
              {githubOff ? 'Checking GitHub is off.' : describeUpdateState(st, github ? 'GitHub' : 'the host')}
            </span>
          </div>
          {st.kind === 'downloading' && (
            <div className="g-pbar" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${pct ?? 0}%` }} />
            </div>
          )}
          {restartErr && <p className="text-xs text-error">Couldn't install: {restartErr}</p>}
          <div className="flex gap-2 pt-1">
            {st.kind === 'ready' ? (
              <button className="g-btn g-btn-pri g-btn-sm" onClick={() => void restart()} disabled={restarting}>
                {restarting ? 'Restarting…' : 'Restart to update'}
              </button>
            ) : (
              <button
                className="g-btn g-btn-ghost g-btn-sm"
                onClick={() => {
                  loadBuilds();
                  void checkForUpdate();
                }}
                disabled={busy || st.kind === 'unsupported' || githubOff}
              >
                {st.kind === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-subtext-0">
          This page is served live by your host, so it's always current. The desktop app updates itself from the host.
        </p>
      )}
    </div>
  );
}

const STATE_TAG: Record<HostUpdateStatus['state'], [string, string]> = {
  idle: ['', 'Idle'],
  running: ['g-tag-pri', 'Running'],
  succeeded: ['g-tag-ok', 'Succeeded'],
  failed: ['g-tag-red', 'Failed'],
};

/** A fresh click waits this long for the update job to report "running". */
const START_GRACE_MS = 30_000;

function HostUpdateCard() {
  const [owner, setOwner] = useState(false);
  const [status, setStatus] = useState<HostUpdateStatus | null>(null);
  const [poll, setPoll] = useState<HostPoll>({ kind: 'ok' });
  const [polling, setPolling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const armedAt = useRef(0);
  const statusRef = useRef<HostUpdateStatus | null>(null);
  statusRef.current = status;
  const logRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  // Owner only, on a host that has the feature; then read the status once, and
  // follow it if an update is running.
  useEffect(() => {
    let alive = true;
    void canUpdateHost().then((o) => {
      if (!alive || !o) return;
      setOwner(true);
      getHostUpdateStatus()
        .then((s) => {
          if (!alive) return;
          setStatus(s);
          if (s.state === 'running') setPolling(true);
        })
        .catch((e) => alive && setErr(why(e)));
    });
    return () => {
      alive = false;
    };
  }, []);

  // The poll: every 2 s while the update runs, and through the host's restart
  // (connection errors count as "restarting…" for up to 3 minutes).
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let conn: HostPoll = { kind: 'ok' };
    let lastState: HostUpdateStatus['state'] | null = statusRef.current?.state ?? null;
    const tick = async () => {
      let ok = false;
      try {
        const s = await getHostUpdateStatus();
        if (!alive) return;
        ok = true;
        setStatus(s);
        if (lastState === 'running' && s.state === 'succeeded') void checkForUpdate(); // a new desktop build may be up
        if (s.state === 'running') armedAt.current = 0; // the job has reported in: follow its state from here
        lastState = s.state;
      } catch (e) {
        // An answer from the host (401, 403, a missing command) isn't a restart:
        // say so and stop. No answer at all is the restart, or the host gone.
        const status = (e as { status?: number }).status;
        if (alive && status && status < 500) {
          setErr(why(e));
          setPolling(false);
          return;
        }
      }
      if (!alive) return;
      conn = nextHostPoll(conn, ok, Date.now());
      setPoll(conn);
      const armed = Date.now() - armedAt.current < START_GRACE_MS;
      if (keepPolling(lastState, conn) || (armed && conn.kind !== 'lost')) timer = setTimeout(() => void tick(), HOST_POLL_MS);
      else setPolling(false);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [polling]);

  // The log sticks to the bottom unless the owner has scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [status?.log]);

  if (!owner) return null;

  // The apps the host's update builds (none on a host whose devices update from GitHub).
  const apps = hostClientApps(status?.clientBuilds);
  const appNames = apps.map((a) => (a === 'desktop' ? 'the desktop app' : 'the Android app')).join(' and ');
  // An older host doesn't say; only a definite "no" disables the button.
  const notInstalled = status?.updaterInstalled === false;

  const start = async () => {
    const ok = await confirmDialog(
      `Update the server now? The host pulls the latest code, checks it, rebuilds, and restarts the server (a minute or two offline)${apps.length ? `, then builds ${appNames}` : ''}.`,
    );
    if (!ok) return;
    setStarting(true);
    setErr(null);
    try {
      await startHostUpdate();
      armedAt.current = Date.now();
      setPoll({ kind: 'ok' });
      setPolling(true);
    } catch (e) {
      setErr(why(e));
    } finally {
      setStarting(false);
    }
  };

  const running = polling || (status?.state === 'running' && poll.kind !== 'lost');
  const [tagCls, tagLabel] = status ? STATE_TAG[status.state] ?? ['', status.state] : ['', ''];
  const clients = status?.clients;
  const launchd = status?.launchd;
  // The apps' lines, once there is something to say: "…" means "not yet", so only while it runs.
  const showClients = !!clients && (status?.state === 'running' || !!clients.desktop || !!clients.android);

  return (
    <div className="g-card p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="g-stitle">Update the server</div>
        <button
          className="g-btn g-btn-gilt g-btn-sm"
          onClick={() => void start()}
          disabled={starting || running || notInstalled}
          title={notInstalled ? 'Run ops/install.sh on the host once' : undefined}
        >
          {starting ? 'Starting…' : running ? 'Updating…' : 'Update the server'}
        </button>
      </div>
      <p className="text-sm text-subtext-0">
        Pulls the latest code on the host, checks it, rebuilds and restarts the server.{' '}
        {apps.length
          ? `Then it builds ${appNames}, and devices pick the new ${apps.length > 1 ? 'apps' : 'app'} up on their own.`
          : "This host doesn't build apps; devices update from GitHub releases."}
      </p>
      {notInstalled && (
        <p className="text-sm text-warning">
          The updater isn't installed on the host. Run <span className="font-mono">ops/install.sh</span> on the host
          once.
        </p>
      )}
      {err && <p className="text-sm text-error">{err}</p>}

      {status && (
        <>
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-subtext-0">State</dt>
            <dd className="flex items-center gap-2 min-w-0">
              {tagCls || tagLabel ? <span className={`g-tag ${tagCls}`}>{tagLabel}</span> : null}
              {poll.kind === 'restarting' && <span className="g-tag g-tag-warn">Restarting…</span>}
              {poll.kind === 'lost' && <span className="g-tag g-tag-red">Host unreachable for 3 minutes</span>}
              {status.step && <span className="text-text truncate">{status.step}</span>}
            </dd>
            {(status.fromBuild || status.toBuild) && (
              <>
                <dt className="text-subtext-0">Build</dt>
                <dd className="text-text font-mono text-xs self-center">
                  {status.fromBuild ?? '?'} → {status.toBuild ?? '…'}
                </dd>
              </>
            )}
            {status.startedAt && (
              <>
                <dt className="text-subtext-0">Started</dt>
                <dd className="text-text">
                  {fmtDate(status.startedAt)}
                  {status.finishedAt && <span className="text-subtext-0"> · finished {fmtDate(status.finishedAt)}</span>}
                </dd>
              </>
            )}
            {showClients &&
              apps.map((a) => (
                <ClientLine key={a} label={a === 'desktop' ? 'Desktop app' : 'Android app'} line={clients[a]} />
              ))}
          </dl>
          {launchd && (
            <div className="g-inset space-y-2 text-sm">
              <p className="text-text">
                launchd's view of the updater:{' '}
                {launchd.lastExitCode ? (
                  <>
                    last exit code <span className="font-mono">{launchd.lastExitCode}</span>
                  </>
                ) : (
                  'no exit code recorded'
                )}
                .
              </p>
              {launchd.log && (
                <LogBlock text={launchd.log} />
              )}
              <p className="text-xs text-subtext-0">
                Re-run <span className="font-mono">ops/install.sh</span> on the host, and check that the host's checkout
                pulls from the right remote (<span className="font-mono">git remote -v</span>).
              </p>
            </div>
          )}
          {status.log && (
            <ScrollArea
              className="h-64 g-inset !p-0"
              contentClassName="p-3"
              scrollRef={logRef}
              onScroll={() => {
                const el = logRef.current;
                if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
            >
              <pre className="font-mono text-xs text-subtext-1 whitespace-pre-wrap break-words">{status.log}</pre>
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}

/** A short log as it is; a long one in a scroller. */
function LogBlock({ text }: { text: string }) {
  const pre = <pre className="font-mono text-xs text-subtext-1 whitespace-pre-wrap break-words">{text}</pre>;
  return text.split('\n').length > 8 ? <ScrollArea className="h-40">{pre}</ScrollArea> : pre;
}

function ClientLine({ label, line }: { label: string; line: string | null }) {
  return (
    <>
      <dt className="text-subtext-0">{label}</dt>
      <dd className={clientCls(line)}>{line || '…'}</dd>
    </>
  );
}

/** The /download page's installers, for a new device's first install: an advanced
 * option behind a disclosure, closed by default (GitHub Releases is where people
 * normally download Ganban). Mounted only while open, so it scans only when asked. */
export function ServeInstallersCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="g-card p-5 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="serve-installers"
        className="g-rule"
      >
        <span className="inline-flex items-center gap-2">
          Advanced: serve installers from this host
          <svg className={`transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </span>
      </button>
      {open && (
        <div id="serve-installers" className="g-reveal space-y-3">
          <p className="text-sm text-subtext-0">
            GitHub Releases is the normal place to download Ganban. Serve installers from this host only for a device
            that can't reach GitHub, or to hand out your own builds.
          </p>
          <ShareBuildsPanel />
        </div>
      )}
    </div>
  );
}

const clientCls = (line: string | null) =>
  !line ? 'text-subtext-0' : line.startsWith('failed') ? 'text-error' : line.startsWith('skipped') ? 'text-subtext-0' : 'text-text';
