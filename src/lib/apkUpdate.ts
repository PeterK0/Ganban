// The phone updates itself (ADR 0007, docs/design/UPDATES.md § The phone) from the
// device's update source: This server (the host's Android build, `get_client_builds`)
// or GitHub Releases (the repo's latest release, no token, and nothing at all while
// "Check GitHub for new versions" is off). The build's channel only sets the default.
//
// A source is offered only when its APK's signing certificate is one the installed app is
// signed with (Android refuses any other), and only when its version code is larger.
// The download goes through the native apk-updater plugin (which checks the sha256), then
// Android's installer. One module-level state, shared by the banner and Settings.
//
// QA off-Android: `?apkstub=1` (with `?mobile=1`) fakes the plugin and the
// host's build (or GitHub's release). Variants: `apkstub=perm` (asks for the install permission
// first), `apkstub=fail` (the checksum fails), `apkstub=nobuild`, `apkstub=current`,
// `apkstub=othercert` (the source is signed with another certificate).
import { useSyncExternalStore } from "react";
import { currentDaemonUrl, daemonFetch, getDeviceToken, isTauri } from "./daemon";
import {
  compareBuild,
  githubApk,
  shouldRecheckOnResume,
  type AndroidBuild,
  type ApkUpdateState,
  type GithubRelease,
} from "./apkUpdate.pure";
import { GITHUB_BROKEN, githubLatestReleaseApi } from "./update.pure";
import { GITHUB_REPO, UPDATE_CHANNEL, githubRepoToAsk, setUpdateSource, updateSource } from "./updateChannel";
import { certMatch, certReason, isCrossSource, type SourceStatus, type UpdateSource } from "./updateSource.pure";

export type { AndroidBuild, ApkUpdateState } from "./apkUpdate.pure";

/** `get_client_builds` (any member). Only the Android half matters here. */
interface ClientBuilds {
  android: AndroidBuild | null;
}

interface ApkVersion {
  versionCode: number;
  versionName: string;
  /** The installed app's signing certificates (SHA-256, hex); absent on an older plugin. */
  certSha256?: string[];
}
interface DownloadProgress {
  downloaded: number;
  total: number;
}

function stubScenario(): string | null {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("mobile") === "1" ? q.get("apkstub") : null;
  } catch {
    return null;
  }
}

/** The installed Android app (or the QA stub). Hidden everywhere else, iOS included. */
export function apkUpdateSupported(): boolean {
  if (stubScenario()) return true;
  return isTauri() && /android/i.test(navigator.userAgent);
}

// ---- the native plugin (or its stub) ----

async function pluginInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(`plugin:apk-updater|${cmd}`, args);
}

const STUB_CERT = "ab".repeat(32);
const STUB_BUILD: AndroidBuild = {
  version: "1.0.1100",
  versionCode: 1000009042,
  pubDate: "2026-11-02T08:00:00Z",
  size: 48_600_000,
  sha256: "0".repeat(64),
  certSha256: STUB_CERT,
};
let stubPermissionAsked = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const native = {
  version(): Promise<ApkVersion> {
    if (stubScenario()) {
      const current = stubScenario() === "current";
      return Promise.resolve({
        versionCode: current ? 1000009042 : 1000009,
        versionName: current ? "1.0.1100" : "1.0.9",
        certSha256: [stubScenario() === "othercert" ? "cd".repeat(32) : STUB_CERT],
      });
    }
    return pluginInvoke<ApkVersion>("apk_version");
  },
  async download(url: string, token: string | null, sha256: string, onProgress: (p: DownloadProgress) => void): Promise<string> {
    if (stubScenario()) {
      const total = STUB_BUILD.size;
      for (let done = 0; done < total; done += total / 25) {
        onProgress({ downloaded: Math.floor(done), total });
        await sleep(120);
      }
      onProgress({ downloaded: total, total });
      if (stubScenario() === "fail") throw new Error("The download is damaged (its sha256 doesn't match the host's).");
      return "/stub/cache/updates/ganban-update.apk";
    }
    const { Channel } = await import("@tauri-apps/api/core");
    const ch = new Channel<DownloadProgress>();
    ch.onmessage = onProgress;
    const res = await pluginInvoke<{ path: string; size: number }>("apk_download", { url, token, sha256, onProgress: ch });
    return res.path;
  },
  async install(path: string, openSettings: boolean): Promise<"started" | "needs_permission"> {
    if (stubScenario()) {
      if (stubScenario() === "perm" && !stubPermissionAsked) {
        stubPermissionAsked = openSettings;
        return "needs_permission";
      }
      return "started";
    }
    const res = await pluginInvoke<{ status: "started" | "needs_permission" }>("apk_install", { path, openSettings });
    return res.status;
  },
};

const STUB_RELEASE: GithubRelease = {
  tag_name: "v1.0.10",
  assets: [{ name: "Ganban_1.0.10_universal.apk", browser_download_url: "https://example.invalid/Ganban_1.0.10_universal.apk", size: 48_600_000 }],
};

/** GitHub Releases' APK certificate, compiled in (vite.config.ts); the stub's in QA. */
function githubCert(): string {
  return stubScenario() ? STUB_CERT : __GITHUB_ANDROID_CERT__;
}

/** GitHub's latest release of `repo`: no token, no cookies. */
async function fetchGithubRelease(repo: string): Promise<GithubRelease> {
  if (stubScenario()) return stubScenario() === "nobuild" ? { tag_name: "v1.0.10", assets: [] } : STUB_RELEASE;
  const res = await fetch(githubLatestReleaseApi(repo), {
    headers: { Accept: "application/vnd.github+json" },
    credentials: "omit",
    cache: "no-store",
  });
  if (res.status === 404) return {}; // no release yet
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  return (await res.json()) as GithubRelease;
}

async function fetchClientBuilds(): Promise<ClientBuilds> {
  if (stubScenario()) return { android: stubScenario() === "nobuild" ? null : STUB_BUILD };
  return daemonFetch<ClientBuilds>("/invoke", {
    method: "POST",
    body: JSON.stringify({ command: "get_client_builds", args: {} }),
  });
}

// ---- the shared state ----

let state: ApkUpdateState = { kind: "idle" };
const listeners = new Set<() => void>();
function set(next: ApkUpdateState) {
  state = next;
  listeners.forEach((l) => l());
}
/** The APK already downloaded and checked this session, so a cancelled
 * install prompt doesn't cost a second download. */
let downloaded: { versionCode: number; path: string } | null = null;
/** Bumped by every update step, so a check that was slower than the user's tap
 * doesn't overwrite what the tap started. */
let flow = 0;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

export function getApkUpdateState(): ApkUpdateState {
  return state;
}

export function useApkUpdate(): ApkUpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}

/** The source this phone updates from: its choice, else the build's channel (else the host). */
export function apkSource(): UpdateSource {
  return updateSource() ?? "host";
}

/** One source, asked: its build when it can install over this app, else why not. */
type SourceAnswer =
  | { kind: "off" }
  | { kind: "no-build" }
  | { kind: "unavailable"; why: string; build: AndroidBuild }
  | { kind: "available" | "up-to-date" | "older"; build: AndroidBuild };

async function askSource(source: UpdateSource, me: ApkVersion): Promise<SourceAnswer> {
  let build: AndroidBuild | null;
  let cert: string | null | undefined;
  if (source === "github") {
    if (!GITHUB_REPO) throw new Error(UPDATE_CHANNEL.kind === "github-broken" ? GITHUB_BROKEN : "This build doesn't know its GitHub repository.");
    const repo = githubRepoToAsk();
    if (!repo) return { kind: "off" };
    build = githubApk(await fetchGithubRelease(repo));
    cert = githubCert();
  } else {
    build = (await fetchClientBuilds())?.android ?? null;
    cert = build?.certSha256;
  }
  if (!build) return { kind: "no-build" };
  // Android installs only over the same certificate. Across sources that must be known; on
  // the build's own source an unknown certificate is let through, as before (Android still
  // refuses a stranger).
  const match = certMatch(me.certSha256, cert);
  if (match === "mismatch" || (match === "unknown" && isCrossSource(source, UPDATE_CHANNEL))) {
    return { kind: "unavailable", why: certReason(match, source)!, build };
  }
  const cmp = compareBuild(me.versionCode, build);
  return cmp === "no-build" ? { kind: "no-build" } : { kind: cmp, build };
}

/** Ask the device's update source whether it has a newer Android build. Never throws. */
export async function checkApkUpdate(): Promise<void> {
  if (!apkUpdateSupported()) return;
  if (state.kind === "checking" || state.kind === "downloading") return;
  const source = apkSource();
  // Keep showing the last answer while asking again; only a first check spins.
  if (state.kind === "idle" || state.kind === "failed" || state.kind === "off" || state.kind === "unavailable") set({ kind: "checking" });
  const started = flow;
  let current = "";
  try {
    const me = await native.version();
    current = me.versionName;
    const answer = await askSource(source, me);
    // An update started meanwhile owns the state now.
    if (flow !== started) return;
    switch (answer.kind) {
      case "off":
        // An install already handed to Android keeps its state.
        if (state.kind !== "needs-permission" && state.kind !== "install-started") set({ kind: "off", current });
        return;
      case "no-build":
        return set({ kind: "no-build", current });
      case "unavailable":
        return set({ kind: "unavailable", current, why: answer.why });
      case "up-to-date":
      case "older":
        return set({ kind: "up-to-date", current, host: answer.build.version, older: answer.kind === "older" });
      case "available":
        return set({ kind: "available", current, build: answer.build });
    }
  } catch (e) {
    if (flow !== started) return;
    const from = source === "github" ? "GitHub for its latest release" : "the host for its Android build";
    set({ kind: "failed", during: "check", why: `Couldn't ask ${from}: ${errText(e)}`, current: current || undefined });
  }
}

/** Switch where this phone updates from, then ask there now. */
export async function switchApkSource(source: UpdateSource): Promise<void> {
  if (state.kind === "downloading") return;
  setUpdateSource(source);
  flow++;
  downloaded = null;
  set({ kind: "idle" });
  await checkApkUpdate();
}

/** Both sources as Settings shows them: their latest version and, when one can't be
 * chosen, why. GitHub is asked only while its switch is on. */
export async function apkSourceStatuses(): Promise<Record<UpdateSource, SourceStatus>> {
  const me = await native.version().catch(() => null);
  const one = async (source: UpdateSource): Promise<SourceStatus> => {
    if (!me) return { available: false, latest: null, why: "Couldn't read this app's version." };
    try {
      const a = await askSource(source, me);
      switch (a.kind) {
        case "off":
          return { available: true, latest: null, why: apkSource() === "github" ? "Checking GitHub is off." : "Asked once you choose it." };
        case "no-build":
          return { available: true, latest: null, why: source === "github" ? "The latest release has no app." : "The server has no Android build yet." };
        case "unavailable":
          return { available: false, latest: a.build.version, why: a.why };
        default:
          return { available: true, latest: a.build.version, why: null };
      }
    } catch (e) {
      return { available: false, latest: null, why: errText(e) };
    }
  };
  const [github, host] = await Promise.all([one("github"), one("host")]);
  return { github, host };
}

/** Download the host's build (unless this session already has it), then start
 * Android's install prompt. */
export async function startApkUpdate(): Promise<void> {
  const s = state;
  if (s.kind !== "available" && s.kind !== "failed" && s.kind !== "install-started") return;
  const build = s.build;
  const current = s.current ?? "";
  if (!build) return;
  flow++;
  let path = downloaded?.versionCode === build.versionCode ? downloaded.path : null;
  if (!path) {
    // A GitHub asset: its own https URL, no token. Else the host's build, with this device's token.
    let url: string, token: string | null;
    if (build.url) {
      // Switched off since the offer: no request to GitHub.
      if (!githubRepoToAsk()) return void checkApkUpdate();
      if (!build.url?.startsWith("https://")) return set({ kind: "failed", during: "update", why: "The release has no download address.", current, build });
      url = build.url;
      token = null;
    } else {
      const base = currentDaemonUrl();
      if (!base) return set({ kind: "failed", during: "update", why: "Not connected to a host.", current, build });
      url = `${base}/updates/android/apk`;
      token = getDeviceToken();
    }
    set({ kind: "downloading", current, build, downloaded: 0, total: build.size });
    try {
      path = await native.download(url, token, build.sha256, (p) => {
        if (state.kind === "downloading") set({ ...state, downloaded: p.downloaded, total: p.total > 0 ? p.total : build.size });
      });
      downloaded = { versionCode: build.versionCode, path };
    } catch (e) {
      return set({ kind: "failed", during: "update", why: errText(e), current, build });
    }
  }
  await installApk(current, build, path);
}

/** Start the install again (after allowing installs from Ganban). With
 * `openSettings` false, a device that still doesn't allow it stays put instead
 * of reopening Android's setting. */
export async function retryApkInstall(openSettings = true): Promise<void> {
  const s = state;
  if (s.kind !== "needs-permission" && s.kind !== "install-started") return;
  flow++;
  await installApk(s.current, s.build, s.path, openSettings);
}

async function installApk(current: string, build: AndroidBuild, path: string, openSettings = true): Promise<void> {
  try {
    const status = await native.install(path, openSettings);
    set(status === "needs_permission" ? { kind: "needs-permission", current, build, path } : { kind: "install-started", current, build, path });
  } catch (e) {
    // The cached file is gone (the cache was cleared): download it again next time.
    downloaded = null;
    set({ kind: "failed", during: "update", why: errText(e), current, build });
  }
}

/** Check at launch and whenever the app comes back to the foreground. Returns
 * the cleanup. */
export function watchApkUpdates(): () => void {
  if (!apkUpdateSupported()) return () => {};
  void checkApkUpdate();
  const onVis = () => {
    if (document.visibilityState !== "visible") return;
    // Back from "Allow from this source": install now if it was allowed.
    if (state.kind === "needs-permission") void retryApkInstall(false);
    else if (shouldRecheckOnResume(state)) void checkApkUpdate();
  };
  document.addEventListener("visibilitychange", onVis);
  return () => document.removeEventListener("visibilitychange", onVis);
}
