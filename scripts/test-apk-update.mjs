#!/usr/bin/env node
// Unit test for the phone's self-update decisions (src/lib/apkUpdate.pure.ts):
// newer-or-not by version code, progress, sizes, when a resume re-checks and
// when the banner shows. Transpiles the real source with esbuild.
//   node scripts/test-apk-update.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'apkupd-')), 'apk.mjs');
execSync(`npx esbuild src/lib/apkUpdate.pure.ts --bundle --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const U = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};
const build = (versionCode, version = `0.5.${versionCode - 5000}`) => ({ version, versionCode, pubDate: '', size: 1, sha256: 'x' });

// ----- compareBuild
eq(U.compareBuild(5960, null), 'no-build', 'no build on the host');
eq(U.compareBuild(5960, undefined), 'no-build', 'no android key at all');
eq(U.compareBuild(5960, build(0)), 'no-build', 'a zero version code is no build');
eq(U.compareBuild(5960, build(5975)), 'available', 'a larger code is newer');
eq(U.compareBuild(5975, build(5975)), 'up-to-date', 'the same code is up to date');
eq(U.compareBuild(5980, build(5975)), 'older', 'an older build is never offered (Android refuses a smaller code)');

// ----- progress and sizes
eq(U.progressPct(0, 0), null, 'unknown total');
eq(U.progressPct(50, 200), 25, 'quarter');
eq(U.progressPct(300, 200), 100, 'clamped');
eq(U.fmtMB(0), '0 MB', 'zero');
eq(U.fmtMB(1.5 * 1024 * 1024), '1.5 MB', 'small');
eq(U.fmtMB(48.6 * 1024 * 1024), '49 MB', 'large rounds');

// ----- resume
const b = build(5975);
eq(U.shouldRecheckOnResume({ kind: 'idle' }), true, 'idle rechecks');
eq(U.shouldRecheckOnResume({ kind: 'available', current: '', build: b }), true, 'available rechecks');
eq(U.shouldRecheckOnResume({ kind: 'install-started', current: '', build: b, path: 'p' }), true, 'a cancelled prompt rechecks');
eq(U.shouldRecheckOnResume({ kind: 'downloading', current: '', build: b, downloaded: 0, total: 1 }), false, 'not mid-download');
eq(U.shouldRecheckOnResume({ kind: 'needs-permission', current: '', build: b, path: 'p' }), false, 'keeps the permission step');

// ----- banner
eq(U.bannerVisible({ kind: 'available', current: '', build: b }, null), true, 'offer shows');
eq(U.bannerVisible({ kind: 'available', current: '', build: b }, 5975), false, 'Later hides that build');
eq(U.bannerVisible({ kind: 'available', current: '', build: build(5976) }, 5975), true, 'a newer build shows again');
eq(U.bannerVisible({ kind: 'up-to-date', current: '', host: '' }, null), false, 'up to date is quiet');
eq(U.bannerVisible({ kind: 'no-build', current: '' }, null), false, 'no build is quiet');
eq(U.bannerVisible({ kind: 'failed', during: 'check', why: '' }, null), false, 'a failed check stays in Settings');
eq(U.bannerVisible({ kind: 'failed', during: 'update', why: '', build: b }, null), true, 'a failed update shows');
eq(U.bannerVisible({ kind: 'failed', during: 'update', why: '', build: b }, 5975), false, 'Later hides a failure');

// ----- the GitHub channel (ADR 0008)
eq(U.cmpSemver('1.0.2', '1.0.1'), 1, 'semver: patch');
eq(U.cmpSemver('v1.0.10', '1.0.9'), 1, 'semver: numeric, leading v');
eq(U.cmpSemver('1.0.1', '1.0.1'), 0, 'semver: equal');
eq(U.cmpSemver('1.0.975', '1.1.0'), -1, 'semver: minor beats a big patch');
eq(U.versionCodeFor('1.0.2'), 1000002, "releases before 1.0.10: Tauri's version code");
eq(U.versionCodeFor('v1.0.10'), 1000010000, 'from 1.0.10 on: x1000, so host builds fit between releases');
eq(U.versionCodeFor('v2.3.45'), 2003045000, 'version code with a v');
const apkAsset = (name, extra = {}) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/v1.0.2/${name}`, size: 9, ...extra });
const rel = (assets, extra = {}) => ({ tag_name: 'v1.0.2', assets, ...extra });
const digest = 'sha256:' + 'AB'.repeat(32);
const a = U.githubApk(rel([apkAsset('Ganban_1.0.2_aarch64.dmg'), apkAsset('Ganban_1.0.2_universal.apk', { digest })]));
eq(a && [a.version, a.versionCode, a.size, a.sha256, a.url], ['1.0.2', 1000002, 9, 'ab'.repeat(32), 'https://github.com/o/r/releases/download/v1.0.2/Ganban_1.0.2_universal.apk'], 'the release\'s APK, with its digest');
eq(U.githubApk(rel([apkAsset('x.apk', { digest: null })]))?.sha256, '', 'no digest: no check');
eq(U.githubApk(rel([apkAsset('x.apk', { digest: 'md5:00' })]))?.sha256, '', 'a digest of another kind: no check');
eq(U.githubApk(rel([apkAsset('Ganban_1.0.2_universal-unsigned.apk')])), null, 'an unsigned APK is no build');
eq(U.githubApk(rel([apkAsset('x.apk', { browser_download_url: 'http://plain/x.apk' })])), null, 'only https downloads');
eq(U.githubApk(rel([apkAsset('x.apk')], { tag_name: 'nightly' })), null, 'a tag that is not a version');
eq(U.githubApk(rel([apkAsset('x.apk')], { prerelease: true })), null, 'a prerelease');
eq(U.githubApk({}), null, 'no release at all');
eq(U.compareGithub(1000001, a), 'available', 'a newer release is available');
eq(U.compareGithub(1000002, a), 'up-to-date', 'the same release is up to date');
eq(U.compareGithub(1000003, a), 'older', 'an older release is never offered');
eq(U.compareGithub(1000002500, a), 'older', 'nor one older than a host build after it');
eq(U.compareGithub(1000001, null), 'no-build', 'no APK on the release');
eq(U.bannerVisible({ kind: 'off', current: '1.0.1' }, null), false, 'switched off is quiet');
eq(U.shouldRecheckOnResume({ kind: 'off', current: '1.0.1' }), true, 'off re-reads the switch on resume (no request while off)');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
