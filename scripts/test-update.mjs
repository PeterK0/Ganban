#!/usr/bin/env node
// Unit test for the pure version compare behind the host-served update check
// (src/lib/update.pure.ts). Transpiles the real source with esbuild.
//   node scripts/test-update.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'upd-')), 'upd.mjs');
execSync(`npx esbuild src/lib/update.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const U = await import(out);
const { cmpVersions } = U;
let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));

ok(cmpVersions('0.5.1', '0.5.0') === 1, '0.5.1 > 0.5.0');
ok(cmpVersions('0.5.0', '0.5.1') === -1, '0.5.0 < 0.5.1');
ok(cmpVersions('0.5.0', '0.5.0') === 0, 'equal');
ok(cmpVersions('0.5.10', '0.5.2') === 1, '0.5.10 > 0.5.2 (numeric, not lexical)');
ok(cmpVersions('1.0.0', '0.9.9') === 1, 'major beats minor/patch');
ok(cmpVersions('0.5', '0.5.0') === 0, 'missing patch counts as 0');
ok(cmpVersions('v0.5.1', '0.5.0') === 1, 'leading v ignored');
ok(cmpVersions('0.5.1-beta', '0.5.1') === 0, 'prerelease suffix ignored (no false update)');
ok(cmpVersions('0.6.0+build3', '0.5.9') === 1, 'build suffix ignored');

// ----- the desktop updater's state machine
const run = (events, from = U.initialUpdateState) => events.reduce(U.updateReducer, from);
const checked = (version, canUpdate = true) => ({ type: 'checked', version, canUpdate, at: 1, why: 'no key' });

ok(run([{ type: 'check' }]).kind === 'checking', 'a check starts from idle');
ok(run([{ type: 'check' }, checked(null)]).kind === 'up-to-date', 'no newer build: up to date');
let s = run([{ type: 'check' }, checked(null, false)]);
ok(s.kind === 'unsupported' && s.why === 'no key', 'a build without the key is unsupported');
ok(run([{ type: 'check' }], s) === s, 'an unsupported build never checks again');

s = run([{ type: 'check' }, checked('0.5.975')]);
ok(s.kind === 'downloading' && s.version === '0.5.975' && U.downloadPercent(s) === null, 'a newer build downloads; size unknown at first');
s = run([{ type: 'progress', received: 45, total: 100 }], s);
ok(U.downloadPercent(s) === 45 && U.describeUpdateState(s) === 'Downloading 0.5.975 45%', 'progress reads 45%');
ok(run([{ type: 'check' }], s) === s, 'no second check during a download');
const ready = run([{ type: 'downloaded', version: '0.5.975' }], s);
ok(ready.kind === 'ready' && ready.version === '0.5.975', 'downloaded: ready');
ok(run([{ type: 'check' }], ready) === ready, 'a ready build is not checked over');
ok(run([{ type: 'error', why: 'install failed' }], ready) === ready, 'a failed install keeps the downloaded build');

s = run([{ type: 'error', why: 'bad signature' }], s);
ok(s.kind === 'failed' && s.version === '0.5.975' && /bad signature/.test(U.describeUpdateState(s)), 'a failed download says why');
ok(run([{ type: 'check' }], s).kind === 'checking', 'a failed update can be checked again');
ok(run([{ type: 'check' }, { type: 'error', why: 'offline' }]).kind === 'failed', 'a failed check fails');
ok(run([{ type: 'progress', received: 1, total: 2 }]).kind === 'idle', 'stray progress is ignored');
ok(run([{ type: 'downloaded', version: 'x' }, { type: 'checked', version: 'y', canUpdate: true, at: 1 }]).kind === 'idle', 'stray results are ignored');

// ----- the host update's poll: restart grace
const t0 = 1_000_000;
let p = U.nextHostPoll({ kind: 'ok' }, false, t0);
ok(p.kind === 'restarting' && p.since === t0, 'a connection error starts the restart grace');
p = U.nextHostPoll(p, false, t0 + 2 * 60_000);
ok(p.kind === 'restarting' && p.since === t0, 'still restarting after 2 minutes');
ok(U.keepPolling('running', p), 'polling continues through the restart');
const lost = U.nextHostPoll(p, false, t0 + U.RESTART_GRACE_MS + 1);
ok(lost.kind === 'lost' && !U.keepPolling('running', lost), 'after 3 minutes the host is lost and polling stops');
ok(U.nextHostPoll(p, true, t0 + 60_000).kind === 'ok', 'the host coming back clears it');
ok(U.keepPolling('running', { kind: 'ok' }) && !U.keepPolling('succeeded', { kind: 'ok' }) && !U.keepPolling('failed', { kind: 'ok' }),
  'polling stops when the update finishes');

// ----- the update channel (ADR 0008)
const P = U.parseUpdateChannel;
ok(P(undefined, undefined).kind === 'none' && P('', 'a/b').kind === 'none', 'no channel: a dev build');
ok(P('host', 'PeterK0/Ganban').kind === 'host', 'host ignores a repo');
const gh = P('github', 'PeterK0/Ganban');
ok(gh.kind === 'github' && gh.repo === 'PeterK0/Ganban', 'github with its repo');
for (const bad of [undefined, '', 'PeterK0', 'a/b/c', '../x', 'a/..', 'a/b?x', 'evil.com/a b', 'a/b#c'])
  ok(P('github', bad).kind === 'github-broken' && U.isGithubBuild(P('github', bad)), `github without a usable repo can't update, and stays off the host (${bad})`);
ok(!U.isGithubBuild({ kind: 'host' }) && !U.isGithubBuild({ kind: 'none' }), 'host and dev builds are not GitHub builds');
ok(!U.mayAskGithub({ kind: 'github-broken' }, true), 'a broken github build asks nobody');
ok(U.githubLatestJsonUrl('PeterK0/Ganban') === 'https://github.com/PeterK0/Ganban/releases/latest/download/latest.json', 'the desktop endpoint');
ok(U.githubLatestReleaseApi('PeterK0/Ganban') === 'https://api.github.com/repos/PeterK0/Ganban/releases/latest', 'the phone endpoint');
ok(U.mayAskGithub(gh, true) && !U.mayAskGithub(gh, false), 'github asks only while the switch is on');
ok(!U.mayAskGithub({ kind: 'host' }, true) && !U.mayAskGithub({ kind: 'none' }, true), 'host and dev builds never ask GitHub');
ok(U.describeUpdateState({ kind: 'checking' }, 'GitHub') === 'Checking GitHub…' && U.describeUpdateState({ kind: 'checking' }) === 'Checking the host…', 'the check names its source');

// ----- the device switch (src/lib/updateChannel.ts), bundled per channel: off means no repo to ask
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
async function channelModule(channel, repo) {
  const f = join(mkdtempSync(join(tmpdir(), 'chan-')), 'chan.mjs');
  const defs = `--define:import.meta.env.VITE_UPDATE_CHANNEL='${JSON.stringify(channel)}' --define:import.meta.env.VITE_UPDATE_REPO='${JSON.stringify(repo)}'`;
  execSync(`npx esbuild src/lib/updateChannel.ts --bundle --format=esm --platform=node ${defs} --outfile=${f} --log-level=error`, { cwd: root, stdio: 'inherit' });
  return import(f);
}
{
  const C = await channelModule('github', 'PeterK0/Ganban');
  store.clear();
  ok(C.githubChecksOn() && C.githubRepoToAsk() === 'PeterK0/Ganban', 'a github build asks GitHub by default');
  C.setGithubChecksOn(false);
  ok(!C.githubChecksOn() && C.githubRepoToAsk() === null, 'switched off, there is nothing to ask');
  C.setGithubChecksOn(true);
  ok(C.githubRepoToAsk() === 'PeterK0/Ganban' && !store.has('ganban.updates.github'), 'switched back on, the default again');
  const H = await channelModule('host', 'PeterK0/Ganban');
  ok(H.UPDATE_CHANNEL.kind === 'host' && H.githubRepoToAsk() === null, 'a host build never asks GitHub, switch or not');
  const B = await channelModule('github', '');
  ok(B.UPDATE_CHANNEL.kind === 'github-broken' && B.githubRepoToAsk() === null, 'a github build without its repo asks nobody');
}

// ----- which app lines the "Update the server" card shows
{
  ok(U.hostClientApps('none').length === 0, "'none': no app lines");
  ok(U.hostClientApps('desktop').join() === 'desktop' && U.hostClientApps('android').join() === 'android', 'one app: its line only');
  ok(U.hostClientApps('android,desktop').join() === 'desktop,android' && U.hostClientApps('desktop,android').join() === 'desktop,android', 'both, desktop first');
  ok(U.hostClientApps(null).join() === 'desktop,android' && U.hostClientApps(undefined).join() === 'desktop,android', "a host that doesn't say: both, as before");
}

// ----- latest.json from the release's assets (scripts/updater-json.mjs)
{
  const J = await import(join(root, 'scripts/updater-json.mjs'));
  const v = '1.0.2';
  const bundles = [
    'Ganban_aarch64.app.tar.gz', 'Ganban_x64.app.tar.gz',
    `Ganban_${v}_x64_en-US.msi`, `Ganban_${v}_x64-setup.exe`,
    `Ganban_${v}_amd64.AppImage`, `Ganban_${v}_amd64.deb`,
  ];
  const assetNames = [...bundles, ...bundles.map((b) => `${b}.sig`), `Ganban_${v}_aarch64.dmg`, `Ganban_${v}_universal.apk`, 'Ganban_orphan.app.tar.gz.sig'];
  const sigs = Object.fromEntries(assetNames.filter((n) => n.endsWith('.sig')).map((n) => [n, `SIG(${n})\n`]));
  const j = J.composeUpdaterJson({ repo: 'PeterK0/Ganban', tag: 'v1.0.2', version: v, pubDate: 'now', assetNames, sigs });
  ok(j.version === '1.0.2' && j.pub_date === 'now', 'the version and date');
  const url = (n) => `https://github.com/PeterK0/Ganban/releases/download/v1.0.2/${n}`;
  ok(j.platforms['darwin-aarch64']?.url === url('Ganban_aarch64.app.tar.gz') && j.platforms['darwin-aarch64'].signature === 'SIG(Ganban_aarch64.app.tar.gz.sig)', 'macOS arm64: its bundle, signature trimmed');
  ok(j.platforms['darwin-x86_64']?.url === url('Ganban_x64.app.tar.gz') && j.platforms['darwin-x86_64-app'], 'macOS Intel, with the installer key too');
  ok(j.platforms['windows-x86_64']?.url === url(`Ganban_${v}_x64_en-US.msi`), 'Windows defaults to the MSI (tauri-action\'s default)');
  ok(j.platforms['windows-x86_64-nsis']?.url === url(`Ganban_${v}_x64-setup.exe`) && j.platforms['windows-x86_64-msi'], 'an NSIS install updates with the NSIS installer');
  ok(j.platforms['linux-x86_64']?.url === url(`Ganban_${v}_amd64.AppImage`) && j.platforms['linux-x86_64-deb'], 'Linux defaults to the AppImage; a .deb install keeps its own');
  ok(!Object.values(j.platforms).some((p) => /orphan|dmg|apk/.test(p.url)), 'a .sig without its bundle, and unsigned assets, are left out');
  ok(J.missingPlatforms(j, ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']).length === 0, 'all four required platforms');
  const partial = J.composeUpdaterJson({ repo: 'a/b', tag: 'v1', version: '1', pubDate: '', assetNames: assetNames.filter((n) => !n.includes('x64.app')), sigs });
  ok(J.missingPlatforms(partial, ['darwin-x86_64', 'darwin-aarch64']).join() === 'darwin-x86_64', 'a missing build is named, so the release stays a draft');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
