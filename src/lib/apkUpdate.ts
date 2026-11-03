// The phone updates itself from the host (ADR 0007, docs/design/UPDATES.md § The phone).
//
// The installed Android app compares its version code with the host's Android
// build (`get_client_builds`), downloads the APK through the native apk-updater
// plugin (which checks its sha256), then hands it to Android's installer. One
// module-level state, shared by the banner and Settings.
//
// A phone app from GitHub Releases (a `github` build, ADR 0008) asks the repo's
// latest release instead, with no token, and nothing at all while "Check GitHub
// for new versions" is off. The download, the install prompt and the states are
// the same.
//
// QA off-Android: `?apkstub=1` (with `?mobile=1`) fakes the plugin and the
// host's build (or GitHub's release, on a `github` build). Variants: `apkstub=perm` (asks for the install permission
// first), `apkstub=fail` (the checksum fails), `apkstub=nobuild`, `apkstub=current`.
import { useSyncExternalStore } from "react";
import { currentDaemonUrl, daemonFetch, getDeviceToken, isTauri } from "./daemon";
import {
  compareBuild,
  compareGithub,
  githubApk,
  shouldRecheckOnResume,
  type AndroidBuild,
  type ApkUpdateState,
  type GithubRelease,
} from "./apkUpdate.pure";
import { GITHUB_BROKEN, githubLatestReleaseApi, isGithubBuild } from "./update.pure";
import { UPDATE_CHANNEL, githubRepoToAsk } from "./updateChannel";

export type { AndroidBuild, ApkUpdateState } from "./apkUpdate.pure";

/** `get_client_builds` (any member). Only the Android half matters here. */
interface ClientBuilds {
  android: AndroidBuild | null;
}

interface ApkVersion {
  versionCode: number;
  versionName: string;
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

const STUB_BUILD: AndroidBuild = {
  version: "0.5.975",
  versionCode: 5975,
  pubDate: "2026-11-02T08:00:00Z",
  size: 48_600_000,
  sha256: "0".repeat(64),
};
let stubPermissionAsked = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const native = {
  version(): Promise<ApkVersion> {
    if (stubScenario()) return Promise.resolve({ versionCode: stubScenario() === "current" ? 5975 : 5960, versionName: stubScenario() === "current" ? "0.5.975" : "0.5.960" });
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
  tag_name: "v1.0.2",
  assets: [{ name: "Ganban_1.0.2_universal.apk", browser_download_url: "https://example.invalid/Ganban_1.0.2_universal.apk", size: 48_600_000 }],
};

/** GitHub's latest release of `repo`: no token, no cookies. */
async function fetchGithubRelease(repo: string): Promise<GithubRelease> {
  if (stubScenario()) return stubScenario() === "nobuild" ? { tag_name: "v1.0.2", assets: [] } : STUB_RELEASE;
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

/** Whether this build updates from GitHub (else from its host). */
export const apkFromGithub = isGithubBuild(UPDATE_CHANNEL);

/** Ask the host (or GitHub, on a GitHub build) whether it has a newer Android build. Never throws. */
export async function checkApkUpdate(): Promise<void> {
  if (!apkUpdateSupported()) return;
  if (state.kind === "checking" || state.kind === "downloading") return;
  if (UPDATE_CHANNEL.kind === "github-broken") return set({ kind: "failed", during: "check", why: GITHUB_BROKEN });
  const repo = apkFromGithub ? githubRepoToAsk() : null;
  if (apkFromGithub && !repo) {
    // The switch is off: say so, and send GitHub nothing.
    const started = flow;
    const current = await native.version().then((v) => v.versionName, () => "");
    // An install already handed to Android keeps its state.
    if (flow === started && state.kind !== "needs-permission" && state.kind !== "install-started") set({ kind: "off", current });
    return;
  }
  // Keep showing the last answer while asking again; only a first check spins.
  if (state.kind === "idle" || state.kind === "failed" || state.kind === "off") set({ kind: "checking" });
  const started = flow;
  let current = "";
  try {
    const me = await native.version();
    current = me.versionName;
    if (repo) {
      const apk = githubApk(await fetchGithubRelease(repo));
      if (flow !== started) return;
      switch (compareGithub(current, apk)) {
        case "no-build":
          return set({ kind: "no-build", current });
        case "up-to-date":
          return set({ kind: "up-to-date", current, host: apk!.version });
        case "available":
          return set({ kind: "available", current, build: apk! });
      }
    }
    const builds = await fetchClientBuilds();
    // An update started meanwhile owns the state now.
    if (flow !== started) return;
    const build = builds?.android ?? null;
    switch (compareBuild(me.versionCode, build)) {
      case "no-build":
        return set({ kind: "no-build", current });
      case "up-to-date":
        return set({ kind: "up-to-date", current, host: build!.version });
      case "available":
        return set({ kind: "available", current, build: build! });
    }
  } catch (e) {
    if (flow !== started) return;
    const from = repo ? "GitHub for its latest release" : "the host for its Android build";
    set({ kind: "failed", during: "check", why: `Couldn't ask ${from}: ${errText(e)}`, current: current || undefined });
  }
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
    if (apkFromGithub) {
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
