// The phone's self-update UI (ADR 0007): a banner above the tab bar when there's
// something to do, and the full state in Settings → App update. The state and
// the native calls live in src/lib/apkUpdate.ts. Android only: both render
// nothing elsewhere (iOS included).
import { useEffect, useState } from "react";
import {
  apkSource,
  apkSourceStatuses,
  apkUpdateSupported,
  checkApkUpdate,
  retryApkInstall,
  startApkUpdate,
  switchApkSource,
  useApkUpdate,
  type ApkUpdateState,
} from "../lib/apkUpdate";
import { bannerVisible, fmtMB, progressPct } from "../lib/apkUpdate.pure";
import { GITHUB_REPO, setGithubChecksOn, useGithubChecksOn, useUpdateSource } from "../lib/updateChannel";
import type { SourceStatus, UpdateSource } from "../lib/updateSource.pure";
import { currentDaemonUrl } from "../lib/daemon";
import { Button, SectionHeader, Toggle } from "./ui";

/** Progress for a download: a gold bar, and "12 / 48 MB · 25%". */
function Progress({ s }: { s: Extract<ApkUpdateState, { kind: "downloading" }> }) {
  const pct = progressPct(s.downloaded, s.total);
  return (
    <div className="space-y-1">
      <div className="g-pbar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <span style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="text-xs gm-mut tabular-nums">
        {fmtMB(s.downloaded)}
        {s.total > 0 ? ` / ${fmtMB(s.total)} · ${pct}%` : ""}
      </div>
    </div>
  );
}

/** One line per state: the title and what to do. Shared by the banner and Settings.
 * On GitHub Releases it names GitHub's latest release instead of the host. */
function describe(s: ApkUpdateState): { title: string; sub?: string; tone?: "error" | "ok" } {
  const gh = apkSource() === "github";
  switch (s.kind) {
    case "idle":
    case "checking":
      return { title: gh ? "Checking GitHub for a new version…" : "Checking the host for an update…" };
    case "off":
      return { title: "Checking GitHub is off", sub: "Turn it on below to hear about new versions." };
    case "no-build":
      return gh
        ? { title: "No Android build on GitHub", sub: "The latest release has no app to install." }
        : { title: "No Android build on the host", sub: "The host builds the app when it updates. Nothing to install yet." };
    case "up-to-date":
      if (s.older) {
        return {
          title: "Up to date",
          sub: `${gh ? `The latest release (${s.host})` : `The server's build (${s.host})`} is older than this app, and Android can't go back. ${gh ? "The next release" : "Its next build"} installs over this one.`,
          tone: "ok",
        };
      }
      return { title: "Up to date", sub: gh ? `The latest release is ${s.host}.` : `The host's build is ${s.host}.`, tone: "ok" };
    case "unavailable":
      return { title: `Can't update from ${gh ? "GitHub Releases" : "this server"}`, sub: s.why, tone: "error" };
    case "available":
      return { title: `Update available (${s.build.version})`, sub: `${fmtMB(s.build.size)} from ${gh ? "GitHub" : "the host"}` };
    case "downloading":
      return { title: `Downloading ${s.build.version}…` };
    case "needs-permission":
      return {
        title: "Allow installs from Ganban, then come back",
        sub: "Android opened its setting: turn on “Allow from this source” and go back. The install starts then, or tap Install.",
      };
    case "install-started":
      return {
        title: `Installing ${s.build.version}`,
        sub: "Answer Android's prompt. Ganban restarts on the new version.",
      };
    case "failed":
      return { title: s.during === "check" ? "Couldn't check for an update" : "The update failed", sub: s.why, tone: "error" };
  }
}

/** The state's buttons. */
function Actions({ s, full }: { s: ApkUpdateState; full?: boolean }) {
  switch (s.kind) {
    case "available":
      return <Button full={full} onClick={() => void startApkUpdate()}>Update</Button>;
    case "needs-permission":
      return <Button full={full} onClick={() => void retryApkInstall()}>Install</Button>;
    case "install-started":
      return <Button full={full} variant="ghost" onClick={() => void retryApkInstall()}>Install again</Button>;
    case "failed":
      return s.during === "update" && s.build ? (
        <Button full={full} variant="ghost" onClick={() => void startApkUpdate()}>Try again</Button>
      ) : null;
    default:
      return null;
  }
}

/** Above the tab bar, only when the update needs the user (see bannerVisible). */
export function UpdateBanner() {
  const s = useApkUpdate();
  // "Later" hides this build's banner for the session; a newer build shows again.
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!apkUpdateSupported() || !bannerVisible(s, dismissed)) return null;
  const d = describe(s);
  return (
    <div className="pl-4 pr-2 py-2 bg-crust border-t border-gilt-a text-text space-y-2" role="status">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium ${d.tone === "error" ? "text-error" : ""}`}>{d.title}</div>
          {d.sub && <div className="text-xs gm-mut break-words">{d.sub}</div>}
        </div>
        {(s.kind === "available" || s.kind === "failed") && (
          <button onClick={() => setDismissed(s.build?.versionCode ?? null)} className="g-lnk text-sm min-h-[44px] px-2 shrink-0">
            Later
          </button>
        )}
        <div className="shrink-0">
          <Actions s={s} />
        </div>
      </div>
      {s.kind === "downloading" && <div className="pr-2"><Progress s={s} /></div>}
    </div>
  );
}

/** "1.0.10", or why the source can't be chosen; "…" while it's unknown. The chosen source's
 * reason is left to the state card below, which says it in full. */
function sourceLine(st: SourceStatus | undefined, chosen: boolean): string {
  if (!st) return "…";
  return [st.latest, chosen && !st.available ? null : st.why].filter(Boolean).join(" · ") || "—";
}

/** Settings → App update: where this app updates from, its version, the source's build and the state. */
export function UpdateSection() {
  const s = useApkUpdate();
  const githubOn = useGithubChecksOn();
  const source = useUpdateSource() ?? "host";
  const [statuses, setStatuses] = useState<Record<UpdateSource, SourceStatus> | null>(null);
  const supported = apkUpdateSupported();
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void apkSourceStatuses().then((x) => alive && setStatuses(x));
    return () => {
      alive = false;
    };
  }, [supported, githubOn, source]);
  if (!supported) return null;
  const d = describe(s);
  const current = "current" in s && s.current ? s.current : null;
  const busy = s.kind === "checking" || s.kind === "downloading";
  const host = currentDaemonUrl();
  const options: { value: UpdateSource; label: string; disabled: boolean }[] = [
    { value: "github", label: `GitHub Releases${GITHUB_REPO ? ` · ${GITHUB_REPO}` : ""}`, disabled: !!statuses && !statuses.github.available && source !== "github" },
    { value: "host", label: `This server${host ? ` · ${host.replace(/^https?:\/\//, "")}` : ""}`, disabled: !!statuses && !statuses.host.available && source !== "host" },
  ];
  return (
    <>
      <SectionHeader
        right={
          <button onClick={() => void checkApkUpdate()} disabled={busy || s.kind === "off"} className="g-lnk text-sm min-h-[44px] px-2 disabled:opacity-50">
            Check now
          </button>
        }
      >
        App update
      </SectionHeader>
      <div className="px-4 space-y-2">
        <div className="g-card px-4 py-3 space-y-3">
          <label className="block space-y-1">
            <span className="text-sm gm-mut">Updates from</span>
            <select
              value={source}
              disabled={busy}
              onChange={(e) => void switchApkSource(e.target.value as UpdateSource)}
              className="g-field gm-field w-full"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="gm-mut">GitHub Releases</dt>
            <dd className="break-words tabular-nums">{sourceLine(statuses?.github, source === "github")}</dd>
            <dt className="gm-mut">This server</dt>
            <dd className="break-words tabular-nums">{sourceLine(statuses?.host, source === "host")}</dd>
          </dl>
        </div>
        <div className="g-card px-4 py-3 space-y-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className={`font-medium ${d.tone === "error" ? "text-error" : d.tone === "ok" ? "text-success" : ""}`}>{d.title}</div>
              {d.sub && <div className="text-sm gm-mut break-words">{d.sub}</div>}
            </div>
            {s.kind === "checking" && (
              <span className="shrink-0 mt-1 inline-block w-4 h-4 border-2 border-gold border-t-transparent rounded-full animate-spin" aria-hidden="true" />
            )}
          </div>
          {s.kind === "downloading" && <Progress s={s} />}
          <Actions s={s} full />
          <div className="text-xs gm-mut tabular-nums">This app: {current ?? "—"}</div>
        </div>
        {source === "github" && (
          <div className="g-card px-4 py-1">
            <Toggle
              label="Check GitHub for new versions"
              value={githubOn}
              onChange={(v) => {
                setGithubChecksOn(v);
                void checkApkUpdate(); // on: ask now; off: show "off", with no request
              }}
            />
            <div className="text-xs gm-mut pb-2">Off, this app never contacts GitHub.</div>
          </div>
        )}
      </div>
    </>
  );
}
