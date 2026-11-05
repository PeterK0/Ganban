// The phone's self-update (ADR 0007, docs/design/UPDATES.md § The phone): the states and
// the decisions, with no I/O, so scripts/test-apk-update.mjs can test them.
import { compareCodes, releaseVersionCode } from "./updateSource.pure";

/** `get_client_builds().android` on the host. */
export interface AndroidBuild {
  version: string;
  versionCode: number;
  pubDate: string;
  size: number;
  /** Empty: not checked (a GitHub asset without a digest). */
  sha256: string;
  /** Where to download it; absent means the host's `/updates/android/apk`. */
  url?: string;
  /** The SHA-256 of its signing certificate, when the source says (absent: unknown). */
  certSha256?: string | null;
}

/** What the update looks like right now. `failed.during` says whether asking the
 * host failed ("check") or the update itself did ("update"): only the latter
 * interrupts the user with a banner. */
export type ApkUpdateState =
  | { kind: "idle" }
  | { kind: "off"; current: string }
  | { kind: "checking" }
  | { kind: "no-build"; current: string }
  /** `older`: the source's build has a smaller version code, which Android won't install. */
  | { kind: "up-to-date"; current: string; host: string; older?: boolean }
  /** The source's build can't install over this app (another signing certificate). */
  | { kind: "unavailable"; current: string; why: string }
  | { kind: "available"; current: string; build: AndroidBuild }
  | { kind: "downloading"; current: string; build: AndroidBuild; downloaded: number; total: number }
  | { kind: "needs-permission"; current: string; build: AndroidBuild; path: string }
  | { kind: "install-started"; current: string; build: AndroidBuild; path: string }
  | { kind: "failed"; during: "check" | "update"; why: string; current?: string; build?: AndroidBuild };

/** Compare the installed version code with a source's Android build. Codes only grow
 * (ops/version-code.mjs), so newer means larger; a smaller one is `older`, which Android
 * never installs over this app. */
export function compareBuild(currentCode: number, build: AndroidBuild | null | undefined): "no-build" | "up-to-date" | "available" | "older" {
  return compareCodes(currentCode, build?.versionCode);
}

/** Download progress in whole percent, or null when the size isn't known. */
export function progressPct(downloaded: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((downloaded / total) * 100)));
}

/** "48.2 MB", for the update's size and progress. */
export function fmtMB(bytes: number): string {
  if (!(bytes > 0)) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** Whether a resume (the app coming back to the foreground) should ask the host
 * again. Not mid-download, and not while the user is away granting the install
 * permission or answering Android's prompt: those states wait for a tap. */
export function shouldRecheckOnResume(s: ApkUpdateState): boolean {
  return !(s.kind === "checking" || s.kind === "downloading" || s.kind === "needs-permission");
}

/** The banner shows only what needs the user: a newer build, an update under way,
 * a step for them to take, or an update that failed. A failed check stays in
 * Settings. `dismissedCode` ("Later") hides an offer or a failure for that build
 * until a newer one. */
export function bannerVisible(s: ApkUpdateState, dismissedCode: number | null): boolean {
  switch (s.kind) {
    case "available":
      return s.build.versionCode !== dismissedCode;
    case "downloading":
    case "needs-permission":
    case "install-started":
      return true;
    case "failed":
      return s.during === "update" && s.build?.versionCode !== dismissedCode;
    default:
      return false;
  }
}

// ---- The GitHub channel (ADR 0008) --------------------------------------------
// A phone on GitHub Releases asks the repo's latest release (no token), compares
// the tag's version code with its own, and takes the release's `.apk` asset.

/** The fields of GitHub's "latest release" answer this uses. */
export interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string | null }[];
}

/** An APK on a GitHub release: where it is and, when GitHub gives one, its sha256. */
export interface GithubApk extends AndroidBuild {
  url: string;
}


/** -1, 0 or 1. Dotted numbers; a leading "v" and a -prerelease/+build suffix are ignored. */
export function cmpSemver(a: string, b: string): number {
  const norm = (v: string) => v.trim().replace(/^v/i, "").split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = norm(a), pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A release's Android version code (ops/version-code.mjs's formula, which the release
 * workflow sets explicitly). */
export const versionCodeFor = releaseVersionCode;

/** The release's installable APK, or null: a draft, a prerelease, a tag that isn't a
 * version, or no signed `.apk` asset (an unsigned one can't be installed). */
export function githubApk(release: GithubRelease | null | undefined): GithubApk | null {
  if (!release || release.draft || release.prerelease) return null;
  const tag = (release.tag_name ?? "").trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) return null;
  const apk = (release.assets ?? []).find((a) => {
    const n = (a.name ?? "").toLowerCase();
    return n.endsWith(".apk") && !n.includes("unsigned") && /^https:\/\//.test(a.browser_download_url ?? "");
  });
  if (!apk) return null;
  const version = tag.replace(/^v/i, "");
  const m = /^sha256:([0-9a-f]{64})$/i.exec((apk.digest ?? "").trim());
  return {
    version,
    versionCode: versionCodeFor(version),
    pubDate: "",
    size: apk.size ?? 0,
    // Empty when GitHub gives no digest: the download is then not checked, and
    // Android still refuses an APK signed by another key.
    sha256: m ? m[1].toLowerCase() : "",
    url: apk.browser_download_url!,
  };
}

/** The installed app against the release's APK, by version code (a host build's
 * `1.0.<count>` name doesn't compare with a release's). */
export function compareGithub(currentCode: number, apk: GithubApk | null): "no-build" | "up-to-date" | "available" | "older" {
  return compareCodes(currentCode, apk?.versionCode);
}
