#!/usr/bin/env node
// Tests for the host service scripts in ops/: install.sh in a sandbox (fake launchctl, lsof and
// tailscale, a stand-in /health), backup.sh on a throwaway database, update.sh --dry-run, and
// update.sh in a fake repo with stub builds, including the client builds (fake npx/tauri).
// Nothing here touches the real LaunchAgents, app data or database.
//   node scripts/test-ops.mjs
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uid = execFileSync('id', ['-u']).toString().trim();
const sqlite3 = existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => (c ? pass++ : (fail++, console.log('FAIL:', m, extra ? `\n${extra}` : '')));
const dirs = [];

/** A sandbox: fake launchctl (logs its calls; `loaded` and `list.txt` say what's running), fake lsof
 *  (prints lsof.txt), fake tailscale, and the service's folders with a throwaway gansty.db. */
function sandbox({ db = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ganban-ops-test-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const data = join(dir, 'data');
  mkdirSync(bin);
  mkdirSync(data);
  mkdirSync(join(dir, 'agents'));
  const script = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\nd="$(dirname "$0")"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script('launchctl', [
    'echo "$*" >> "$d/launchctl.log"',
    'case "$1" in',
    '  print) grep -qxF "${2##*/}" "$d/loaded" 2>/dev/null ;;',
    '  list) cat "$d/list.txt" 2>/dev/null; true ;;',
    '  bootout) grep -vxF "${2##*/}" "$d/loaded" > "$d/loaded.tmp" 2>/dev/null; mv "$d/loaded.tmp" "$d/loaded" ;;',
    '  *) true ;;',
    'esac',
  ].join('\n'));
  script('lsof', 'cat "$d/lsof.txt" 2>/dev/null; true');
  script('tailscale', '[ "$1 $2" = "ip -4" ] && echo 100.64.0.1');
  if (db) execFileSync(sqlite3, [join(data, 'gansty.db'), 'create table t(x); insert into t values (42);']);
  const env = {
    ...process.env,
    LAUNCHCTL: join(bin, 'launchctl'),
    LSOF: join(bin, 'lsof'),
    TAILSCALE: join(bin, 'tailscale'),
    AGENTS_DIR: join(dir, 'agents'),
    GANBAN_APP_DIR: data,
    GANBAN_LOGS: join(dir, 'logs'),
    GANBAN_SKIP_BUILD: '1',
    GANBAN_HEALTH_WAIT: '5',
  };
  // The host's own settings never leak into a sandbox.
  for (const k of ['GANBAN_CLIENT_BUILDS', 'GANBAN_UPDATER_KEY', 'GANBAN_UPDATER_KEY_PASSWORD', 'GANBAN_ANDROID_KEYSTORE_PROPS', 'GANBAN_CLIENT_FULL', 'CARGO_TARGET_DIR', 'NDK_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT'])
    delete env[k];
  const run = (script, ...args) =>
    new Promise((done) =>
      execFile('/bin/bash', [join(root, 'ops', script), ...args], { env, timeout: 60_000 }, (e, out, err) =>
        done({ code: e ? (e.code ?? 1) : 0, out, err, all: `${out}\n${err}` })
      )
    );
  const read = (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : '');
  return { dir, bin, data, env, run, read, put: (p, s) => writeFileSync(join(dir, p), s) };
}

// A stand-in for the service's /health on a free loopback port.
const health = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(req.url === '/health' ? '{"status":"ok","service":"ganban-server","build":"test"}' : '{}');
});
await new Promise((r) => health.listen(0, '127.0.0.1', r));
const PORT = health.address().port;
const deadPort = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

// ── install.sh ──
{
  const s = sandbox();
  const r = await s.run('install.sh', '--addr', `0.0.0.0:${PORT}`, '--dry-run');
  ok(r.code === 0, 'install --dry-run succeeds', r.all);
  ok(r.out.includes('(dry run)') && r.out.includes('bootstrap'), 'install --dry-run prints what it would run', r.out);
  ok(readdirSync(join(s.dir, 'agents')).length === 0 && !existsSync(join(s.data, 'install.env')), 'install --dry-run changes nothing');
}
{
  const s = sandbox();
  s.put('agents/com.scs.gansty.headless.plist', '<plist/>');
  s.put('bin/loaded', 'com.scs.gansty.headless\n');
  const r = await s.run('install.sh', '--addr', `0.0.0.0:${PORT}`);
  ok(r.code === 0, 'install succeeds in the sandbox', r.all);
  const plist = s.read('agents/com.ganban.server.plist');
  ok(plist.includes(`<string>0.0.0.0:${PORT}</string>`), 'the server plist listens on --addr', plist);
  ok(plist.includes(`<string>${root}/live/ganban-server</string>`), 'the server plist runs live/ganban-server');
  ok(plist.includes(`<string>${root}/live/dist</string>`) && plist.includes('GANBAN_WEB_DIR'), 'the server plist serves live/dist');
  ok(plist.includes(`<string>${s.data}/gansty.db</string>`), "the server plist serves the app's gansty.db");
  ok(/<key>PATH<\/key>\s*<string>[^<]*\/usr\/bin[^<]*<\/string>/.test(plist), 'the server plist sets a PATH');
  ok(plist.includes('<key>KeepAlive</key>') && plist.includes('<key>RunAtLoad</key>'), 'the server stays up');
  ok(s.read('agents/com.ganban.backup.plist').includes(`${root}/ops/backup.sh`), 'the backup plist runs ops/backup.sh');
  ok(plist.includes(`<key>GANBAN_LOGS</key>\n    <string>${s.dir}/logs</string>`) && plist.includes('<key>GANBAN_APP_DIR</key>'), 'the server knows where update.sh writes', plist);
  const upd = s.read('agents/com.ganban.updater.plist');
  ok(upd.includes(`<string>${root}/ops/update.sh</string>`), 'the updater plist runs ops/update.sh', upd);
  ok(!upd.includes('<key>KeepAlive</key>') && /<key>RunAtLoad<\/key>\s*<false\/>/.test(upd), 'the updater runs only when kickstarted', upd);
  ok(upd.includes(`<string>${s.data}</string>`) && /<key>PATH<\/key>\s*<string>[^<]*\/usr\/bin/.test(upd), "the updater gets the server's environment", upd);
  ok(!/@[A-Z_]+@/.test(upd), 'the updater plist has every field filled');
  ok(s.read('data/install.env').includes("GANBAN_CLIENT_BUILDS='desktop,android'"), 'install.env says which clients update.sh builds');
  ok(s.read('data/install.env').includes(`GANBAN_INSTALL_ADDR='0.0.0.0:${PORT}'`), 'install.env keeps the address');
  ok(s.read('data/install.env').includes(`GANBAN_INSTALL_HEALTH='http://127.0.0.1:${PORT}/health'`), '0.0.0.0 is checked on 127.0.0.1');
  const lc = s.read('bin/launchctl.log');
  ok(lc.includes(`bootout gui/${uid}/com.scs.gansty.headless`), 'the old headless agent is stopped', lc);
  ok(!existsSync(join(s.dir, 'agents/com.scs.gansty.headless.plist')) && existsSync(join(s.data, 'retired-com.scs.gansty.headless.plist')), "the old agent's plist is moved aside");
  ok(lc.includes(`bootstrap gui/${uid} ${s.dir}/agents/com.ganban.server.plist`) && lc.includes('com.ganban.backup.plist') && lc.includes('com.ganban.updater.plist'), 'the three agents are bootstrapped', lc);
  ok(r.out.includes('up: {"status":"ok"') && r.out.includes(`http://100.64.0.1:${PORT}`), 'it waits on /health and says where clients connect', r.out);

  // Again, with no --addr: the last install's address.
  s.put('bin/loaded', 'com.ganban.server\ncom.ganban.backup\n');
  const r2 = await s.run('install.sh');
  ok(r2.code === 0 && r2.out.includes(`address: 0.0.0.0:${PORT}`), 'a second install keeps the address', r2.all);
  ok(s.read('bin/launchctl.log').includes(`bootout gui/${uid}/com.ganban.server`), 'a reinstall takes the old service down first');
  ok(!s.read('agents/com.ganban.server.plist').includes('<key>GANBAN_SHARE'), 'no share door unless asked for');

  // The owner's choice of clients survives a reinstall; a bad one is refused.
  s.put('data/install.env', s.read('data/install.env').replace("GANBAN_CLIENT_BUILDS='desktop,android'", "GANBAN_CLIENT_BUILDS='android'"));
  const r3 = await s.run('install.sh');
  ok(r3.code === 0 && s.read('data/install.env').includes("GANBAN_CLIENT_BUILDS='android'"), 'a reinstall keeps GANBAN_CLIENT_BUILDS', r3.all);
  const bad = await new Promise((done) => execFile('/bin/bash', [join(root, 'ops', 'install.sh')], { env: { ...s.env, GANBAN_CLIENT_BUILDS: 'ios' } }, (e, out, err) => done({ code: e ? 1 : 0, all: `${out}\n${err}` })));
  ok(bad.code === 1 && bad.all.includes('GANBAN_CLIENT_BUILDS (or --client-builds) must be'), 'a bad GANBAN_CLIENT_BUILDS is refused', bad.all);

  // --client-builds sets it (over the environment and the last install's); a bad one is refused.
  const nb = await s.run('install.sh', '--client-builds', 'none');
  ok(nb.code === 0 && s.read('data/install.env').includes("GANBAN_CLIENT_BUILDS='none'") && nb.out.includes('client builds: none (devices update from GitHub Releases)'), '--client-builds none goes into install.env', nb.all);
  ok(!nb.out.includes('--client-keys once'), 'and a host that builds no clients is not told to make keys', nb.out);
  const kept = await s.run('install.sh');
  ok(kept.code === 0 && s.read('data/install.env').includes("GANBAN_CLIENT_BUILDS='none'"), 'a reinstall keeps --client-builds', kept.all);
  const flagWins = await new Promise((done) => execFile('/bin/bash', [join(root, 'ops', 'install.sh'), '--client-builds', 'desktop,android'], { env: { ...s.env, GANBAN_CLIENT_BUILDS: 'android' } }, (e, out, err) => done({ code: e ? 1 : 0, all: `${out}\n${err}` })));
  ok(flagWins.code === 0 && s.read('data/install.env').includes("GANBAN_CLIENT_BUILDS='desktop,android'"), '--client-builds wins over the environment', flagWins.all);
  const badFlag = await s.run('install.sh', '--client-builds', 'ios');
  ok(badFlag.code === 1 && badFlag.all.includes('must be desktop,android, desktop, android or none'), 'a bad --client-builds is refused', badFlag.all);
  const noVal = await s.run('install.sh', '--client-builds');
  ok(noVal.code === 1 && noVal.all.includes('--client-builds needs a value'), '--client-builds needs a value', noVal.all);

  // The updater's PATH has node (update.sh's first need after its status) and the tools it runs.
  const updPlist = s.read('agents/com.ganban.updater.plist');
  const updPath = (updPlist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/) || [])[1] || '';
  ok(updPath.split(':').includes(dirname(execFileSync('/bin/bash', ['-c', 'command -v node']).toString().trim())), "the updater's PATH has node's folder", updPath);
  ok(/<key>StandardErrorPath<\/key>\s*<string>[^<]*\/logs\/updater\.out\.log<\/string>/.test(updPlist), "launchd keeps the updater's own output in <LOGS>/updater.out.log", updPlist);

  // A reinstall would take the updater down: not while it runs an update.
  s.put('bin/list.txt', `PID\tStatus\tLabel\n4242\t0\tcom.ganban.updater\n`);
  const busy = await s.run('install.sh');
  ok(busy.code === 1 && busy.err.includes('an update is running'), 'no reinstall while an update runs', busy.all);
}

// ── install.sh --client-keys ──
{
  const s = sandbox();
  // Fake npx (tauri signer generate -w <key>) and keytool (-keystore <file>), logging their calls.
  writeFileSync(join(s.bin, 'npx'), [
    '#!/bin/bash', 'echo "npx $*" >> "$(dirname "$0")/keys.log"',
    'if [ "$1 $2 $3" = "tauri signer generate" ]; then',
    '  while [ $# -gt 0 ]; do [ "$1" = -w ] && k="$2"; shift; done',
    '  echo "SECRET" > "$k"; echo "PUBLIC" > "$k.pub"; chmod 644 "$k" "$k.pub"',
    'fi',
  ].join('\n'));
  writeFileSync(join(s.bin, 'keytool'), [
    '#!/bin/bash', 'echo "keytool $*" >> "$(dirname "$0")/keys.log"',
    'case "$1" in -genkeypair) while [ $# -gt 0 ]; do [ "$1" = -keystore ] && f="$2"; shift; done; [ -n "$GANBAN_KS_PW" ] && echo ks > "$f" ;;',
    '  -list) [ "$GANBAN_KS_PW" = right ] ;; esac',
  ].join('\n'));
  chmodSync(join(s.bin, 'npx'), 0o755);
  chmodSync(join(s.bin, 'keytool'), 0o755);
  s.env.PATH = `${s.bin}:${process.env.PATH}`;
  const mode = (p) => (statSync(join(s.data, p)).mode & 0o777).toString(8);

  const r = await s.run('install.sh', '--client-keys');
  ok(r.code === 0, 'install --client-keys succeeds', r.all);
  ok(s.read('data/keys/updater.key') === 'SECRET\n' && s.read('data/keys/updater.key.pub') === 'PUBLIC\n', 'it makes the updater key pair', r.all);
  ok(/^[0-9a-f]{48}\n$/.test(s.read('data/keys/updater.pass')) && mode('keys/updater.pass') === '600' && mode('keys/updater.key') === '600', 'with a random password, both mode 600');
  ok(s.read('bin/keys.log').includes(`signer generate -w ${s.data}/keys/updater.key --ci -p `), 'through tauri signer generate', s.read('bin/keys.log'));
  ok(r.out.includes('storeFile=') && r.out.includes('uninstall') && !existsSync(join(s.data, 'keys/keystore.properties')), 'without a keystore it explains, and makes none unasked', r.out);
  ok(!readdirSync(join(s.dir, 'agents')).length && !s.read('bin/launchctl.log').includes('bootstrap'), '--client-keys installs no agents');

  const pass = s.read('data/keys/updater.pass');
  const again = await s.run('install.sh', '--client-keys', '--new-keystore');
  ok(again.code === 0 && again.out.includes('never overwritten') && s.read('data/keys/updater.pass') === pass, 'a second run keeps the key', again.all);
  ok((s.read('bin/keys.log').match(/signer generate/g) || []).length === 1, 'and never generates again');
  const props = s.read('data/keys/keystore.properties');
  ok(/^keyAlias=ganban\npassword=[0-9a-f]{48}\nstoreFile=.*\/keys\/ganban-release\.jks\n$/.test(props) && mode('keys/keystore.properties') === '600', '--new-keystore makes the keystore and its properties', props);
  ok(s.read('bin/keys.log').includes('-genkeypair') && !s.read('bin/keys.log').includes(props.split('\n')[1].slice(9)), 'keytool gets the password from the environment, not argv');
  ok(again.err.includes('uninstall it once'), 'it warns that phones signed with another key must uninstall once', again.err);

  // An existing keystore is checked.
  s.put('data/keys/keystore.properties', 'keyAlias=mine\npassword=wrong\nstoreFile=ganban-release.jks\n');
  const wrong = await s.run('install.sh', '--client-keys');
  ok(wrong.code === 1 && wrong.err.includes("can't open the key 'mine'"), 'a keystore the password does not open is reported', wrong.all);
  s.put('data/keys/keystore.properties', 'keyAlias=mine\npassword=right\nstoreFile=ganban-release.jks\n');
  chmodSync(join(s.data, 'keys/keystore.properties'), 0o644);
  const right = await s.run('install.sh', '--client-keys');
  ok(right.code === 0 && right.out.includes("ok: key 'mine'") && right.err.includes('readable by others'), 'a good keystore is ok (and a loose mode is flagged)', right.all);
  s.put('data/keys/keystore.properties', 'keyAlias=mine\npassword=right\nstoreFile=/nowhere.jks\n');
  const gone = await s.run('install.sh', '--client-keys');
  ok(gone.code === 1 && gone.err.includes("which isn't there"), 'a missing keystore file is reported', gone.all);
}
// The share door (ADR 0006): its address and public URL reach the plist and are kept.
{
  const s = sandbox();
  const r = await s.run('install.sh', '--addr', `0.0.0.0:${PORT}`, '--share-addr', '127.0.0.1:8770', '--share-url', 'https://mac.tail1234.ts.net/');
  ok(r.code === 0, 'install with a share door succeeds', r.all);
  const plist = s.read('agents/com.ganban.server.plist');
  ok(/<key>GANBAN_SHARE_ADDR<\/key>\s*<string>127\.0\.0\.1:8770<\/string>/.test(plist), 'the plist passes GANBAN_SHARE_ADDR', plist);
  ok(/<key>GANBAN_SHARE_URL<\/key>\s*<string>https:\/\/mac\.tail1234\.ts\.net<\/string>/.test(plist), 'the plist passes GANBAN_SHARE_URL without a trailing slash', plist);
  ok(r.out.includes('tailscale funnel --bg 8770'), 'it says how to publish the door', r.out);
  ok(s.read('data/install.env').includes("GANBAN_INSTALL_SHARE_ADDR='127.0.0.1:8770'"), 'install.env keeps the share door');
  s.put('bin/loaded', 'com.ganban.server\ncom.ganban.backup\n');
  const r2 = await s.run('install.sh');
  ok(r2.code === 0 && s.read('agents/com.ganban.server.plist').includes('GANBAN_SHARE_URL'), 'a second install keeps the share door', r2.all);
  const r3 = await s.run('install.sh', '--share-addr', 'off');
  ok(r3.code === 0 && !s.read('agents/com.ganban.server.plist').includes('<key>GANBAN_SHARE'), '--share-addr off closes it', r3.all);
  const env = { ...s.env, GANBAN_SHARE_ADDR: '127.0.0.1:8771', GANBAN_SHARE_URL: 'https://x.ts.net' };
  const r4 = await new Promise((done) => execFile('/bin/bash', [join(root, 'ops', 'install.sh')], { env, timeout: 60_000 }, (e, out, err) => done({ code: e ? 1 : 0, all: `${out}\n${err}` })));
  ok(r4.code === 0 && s.read('agents/com.ganban.server.plist').includes('127.0.0.1:8771'), 'GANBAN_SHARE_ADDR in the environment is passed on', r4.all);
  const bad = await s.run('install.sh', '--share-addr', `127.0.0.1:${PORT}`);
  ok(bad.code === 1 && bad.err.includes('another port'), 'the door needs its own port', bad.all);
  const badUrl = await s.run('install.sh', '--share-addr', '127.0.0.1:8770', '--share-url', 'mac.ts.net/x');
  ok(badUrl.code === 1 && badUrl.err.includes('--share-url must be'), 'a bad share URL is refused', badUrl.all);
  const quoted = await s.run('install.sh', '--share-addr', '127.0.0.1:8770', '--share-url', "https://a';touch${IFS}x;'");
  ok(quoted.code === 1 && !s.read('data/install.env').includes('touch'), 'a share URL with quotes is refused', quoted.all);
}
{
  const s = sandbox();
  s.put('bin/lsof.txt', `${process.pid}\n`);
  const r = await s.run('install.sh', '--addr', `127.0.0.1:${PORT}`);
  ok(r.code === 1 && r.err.includes('another process holds port') && r.err.includes('Quit the desktop app'), 'a foreign holder of the port or database is refused', r.all);
  ok(r.err.includes(`pid ${process.pid}: `) && !s.read('bin/launchctl.log').includes('bootstrap'), 'it names the holder and starts nothing', r.all);
  const f = await s.run('install.sh', '--addr', `127.0.0.1:${PORT}`, '--force');
  ok(f.code === 0 && f.err.includes('going on: --force'), '--force installs anyway', f.all);
}
{
  const s = sandbox();
  s.put('bin/lsof.txt', `${process.pid}\n`);
  s.put('bin/list.txt', `PID\tStatus\tLabel\n${process.pid}\t0\tcom.ganban.server\n`);
  const r = await s.run('install.sh', '--addr', `127.0.0.1:${PORT}`);
  ok(r.code === 0, "the service's own process doesn't count as a holder", r.all);
}
{
  const s = sandbox();
  const r = await s.run('install.sh', '--addr', '8765');
  ok(r.code === 1 && r.err.includes('must be IP:PORT'), 'a bare port is refused', r.all);
}
{
  const s = sandbox({ db: false });
  const r = await s.run('install.sh', '--addr', `127.0.0.1:${PORT}`);
  ok(r.code === 1 && r.err.includes('no database at'), 'no database is refused', r.all);
}
{
  const s = sandbox();
  s.env.GANBAN_HEALTH_WAIT = '1';
  const r = await s.run('install.sh', '--addr', `127.0.0.1:${deadPort}`);
  ok(r.code === 1 && r.err.includes('no answer from'), 'no /health answer fails the install', r.all);
}

// ── backup.sh ──
{
  const s = sandbox();
  mkdirSync(join(s.data, 'backups'));
  for (const old of ['gansty-20200101-000000.db.gz', 'gansty-20200102-000000.db.gz', 'unrelated.txt'])
    s.put(`data/backups/${old}`, 'x');
  const r = await s.run('backup.sh', '--keep', '2');
  ok(r.code === 0 && /^backup \S+\.db\.gz \S+\n$/.test(r.out), 'backup prints one line', r.all);
  const file = r.out.split(' ')[1];
  const left = readdirSync(join(s.data, 'backups')).sort();
  ok(left.length === 3 && left.includes('gansty-20200102-000000.db.gz') && left.includes('unrelated.txt'), 'backup keeps the newest N and nothing else is touched', left.join(' '));
  const copy = join(s.dir, 'restored.db');
  writeFileSync(copy, execFileSync('gunzip', ['-c', file]));
  ok(execFileSync(sqlite3, [copy, 'select x from t;']).toString().trim() === '42', 'the backup holds the data');
  const n = await sandbox({ db: false }).run('backup.sh');
  ok(n.code === 1 && n.err.includes('no database'), 'backup without a database fails');
}

// ── update.sh ──
{
  const s = sandbox();
  const r = await s.run('update.sh', '--dry-run');
  ok(r.code === 1 && r.err.includes('run ops/install.sh first'), 'update needs an install first', r.all);
  s.put('data/install.env', `GANBAN_INSTALL_HEALTH='http://127.0.0.1:${PORT}/health'\n`);
  const d = await s.run('update.sh', '--dry-run');
  ok(d.code === 0, 'update --dry-run succeeds', d.all);
  for (const want of ['git pull --ff-only', 'cargo test -p ganban-core -p ganban-server', 'ops/build.sh live.next', 'ops/smoke.sh live.next', 'ops/backup.sh', 'mv live.next live', `kickstart -k gui/${uid}/com.ganban.server`])
    ok(d.out.includes(want), `update --dry-run runs ${want}`, d.out);
  ok(/ganban updated \S+ → \S+: build \(dry run\), healthy/.test(d.out), 'update ends on one summary line', d.out);
  ok(d.out.includes('client apps') && d.out.includes('desktop: skipped: no updater key'), 'update --dry-run goes through the client builds', d.out);
  ok(!existsSync(join(s.data, 'update-status.json')) && !existsSync(join(s.dir, 'logs/update.log')), 'update --dry-run writes no status and no log');
  const bad = await s.run('update.sh', '--now');
  ok(bad.code === 2, 'update refuses unknown arguments');
}

/** A real update.sh run in a fake repo: the real update.sh beside stub build/smoke/backup scripts,
 *  fake git, npm, npx and cargo on the PATH, and a /health that reports live/BUILD (500 while
 *  live/BAD exists), like a service that runs whatever live/ holds. */
/** Client builds (`clients`): 'none' (GANBAN_CLIENT_BUILDS=none), 'nokeys' (no keys: both skipped),
 *  'built' (keys, a fake tauri that makes the artifacts), 'failed' (keys, a tauri that fails). */
async function fakeUpdate({ newBuild, bad = false, holder = false, buildFails = false, slowStart = 0, clients = 'none', prior = false, status = null, before = null, appVersion = '1.0.0', tabSuite = true }) {
  const s = sandbox();
  const repo = join(s.dir, 'repo');
  mkdirSync(join(repo, 'ops'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  // A private build's tab suite; the public tree has none and the gate skips it.
  if (tabSuite) writeFileSync(join(repo, 'scripts/test-extra-tabs.mjs'), '');
  mkdirSync(join(repo, 'live'));
  mkdirSync(join(repo, 'src-tauri/gen/android'), { recursive: true });
  writeFileSync(join(repo, 'live/BUILD'), 'old1');
  writeFileSync(join(repo, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'Ganban', version: appVersion }, null, 2));
  for (const f of ['update.sh', 'build-clients.sh', 'json.mjs']) writeFileSync(join(repo, 'ops', f), readFileSync(join(root, 'ops', f)));
  const stub = (name, body) => writeFileSync(join(repo, 'ops', name), `#!/bin/bash\n${body}\n`);
  stub('build.sh', buildFails ? 'echo "cargo: error" >&2; exit 101' : `mkdir -p "$1" && echo ${newBuild} > "$1/BUILD"${bad ? ' && touch "$1/BAD"' : ''}`);
  stub('smoke.sh', 'echo "smoke ok: server $(cat "$1/BUILD"), web x"');
  stub('backup.sh', 'echo "backup /backups/gansty-1.db.gz 1K"');
  for (const tool of ['npm', 'cargo', 'java']) {
    writeFileSync(join(s.bin, tool), `#!/bin/bash\necho "${tool} $*" >> "$(dirname "$0")/tools.log"\n`);
    chmodSync(join(s.bin, tool), 0o755);
  }
  // A fake tauri: `tauri build` makes the signed bundle, `tauri android build` the APK (and notes
  // whether the keystore's properties were where gradle reads them); FAKE_TAURI=fail fails both.
  writeFileSync(join(s.bin, 'npx'), [
    '#!/bin/bash', 'echo "npx $*" >> "$(dirname "$0")/tools.log"',
    'if [ "$1" = tauri ]; then',
    '  echo "$2 channel=${VITE_UPDATE_CHANNEL-unset} repo=${VITE_UPDATE_REPO-unset}" >> "$(dirname "$0")/channel.seen"',
    '  echo "   Compiling noisy-crate v1.0.0"',
    '  if [ "$FAKE_TAURI" = fail ]; then echo "error: linking with cc failed: exit status: 1" >&2; exit 1; fi',
    '  if [ "$2" = build ]; then',
    '    [ -n "$TAURI_SIGNING_PRIVATE_KEY" ] && [ -n "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ] || exit 3',
    '    d=target/release/bundle/macos; mkdir -p $d; echo bundle > $d/Ganban.app.tar.gz; echo SIGNATURE > $d/Ganban.app.tar.gz.sig',
    '  elif [ "$2" = android ]; then',
    '    cat src-tauri/gen/android/keystore.properties >> "$(dirname "$0")/props.seen"',
    '    d=src-tauri/gen/android/app/build/outputs/apk/universal/release; mkdir -p $d; echo apk > $d/app-universal-release.apk',
    '  fi',
    '  while [ $# -gt 0 ]; do [ "$1" = --config ] && cat "$2" >> "$(dirname "$0")/configs.seen"; shift; done',
    'fi',
  ].join('\n'));
  chmodSync(join(s.bin, 'npx'), 0o755);
  writeFileSync(join(s.bin, 'git'), '#!/bin/bash\necho "git $*" >> "$(dirname "$0")/tools.log"\n[ "$1" = rev-parse ] && echo abc1234\n[ "$1" = rev-list ] && echo 975\ntrue\n');
  chmodSync(join(s.bin, 'git'), 0o755);
  if (clients === 'built' || clients === 'failed') {
    mkdirSync(join(s.data, 'keys'));
    s.put('data/keys/updater.key', 'SECRET');
    s.put('data/keys/updater.key.pub', 'PUBKEY');
    s.put('data/keys/updater.pass', 'pw');
    s.put('data/keys/release.jks', 'ks');
    s.put('data/keys/keystore.properties', 'keyAlias=ganban\npassword=kpw\nstoreFile=release.jks\n');
    mkdirSync(join(s.dir, 'sdk/ndk/27.0.1'), { recursive: true });
    s.env.ANDROID_HOME = join(s.dir, 'sdk');
    s.env.JAVA_HOME = '';
    if (clients === 'failed') s.env.FAKE_TAURI = 'fail';
    writeFileSync(join(repo, 'src-tauri/gen/android/keystore.properties'), 'mine\n');
  }
  if (prior) {
    for (const [dir, file, extra] of [['desktop/darwin-aarch64', 'Ganban_0.5.900.app.tar.gz', ''], ['android', 'Ganban_0.5.900.apk', ',"versionCode":500900']]) {
      mkdirSync(join(s.data, 'client-builds', dir), { recursive: true });
      s.put(`data/client-builds/${dir}/${file}`, 'old');
      s.put(`data/client-builds/${dir}/manifest.json`, `{"version":"0.5.900","file":"${file}"${extra}}`);
    }
  }
  if (status) s.put('data/update-status.json', JSON.stringify(status));
  let starting = slowStart; // health answers 500 this many times once the new build is live (a slow start)
  const srv = createServer((req, res) => {
    const live = join(repo, 'live');
    if (existsSync(join(live, 'BAD'))) { res.statusCode = 500; res.end('{}'); return; }
    if (starting > 0 && readFileSync(join(live, 'BUILD'), 'utf8').trim() === newBuild) { starting--; res.statusCode = 500; res.end('{}'); return; }
    res.end(`{"status":"ok","build":"${readFileSync(join(live, 'BUILD'), 'utf8').trim()}"}`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  s.put('data/install.env', `GANBAN_INSTALL_ADDR='127.0.0.1:${port}'\nGANBAN_INSTALL_HEALTH='http://127.0.0.1:${port}/health'\n${clients === 'none' ? "GANBAN_CLIENT_BUILDS='none'\n" : ''}`);
  if (holder) s.put('bin/lsof.txt', `${process.pid}\n`);
  s.env.PATH = `${s.bin}:${process.env.PATH}`;
  s.env.GANBAN_HEALTH_WAIT = slowStart ? String(slowStart + 3) : '2';
  if (before) await before(s);
  const r = await new Promise((done) =>
    // A GitHub channel left in the environment: the host's builds must still be on `host`.
    execFile('/bin/bash', [join(repo, 'ops/update.sh')], { env: { ...s.env, VITE_UPDATE_CHANNEL: 'github', VITE_UPDATE_REPO: 'someone/fork' }, timeout: 60_000 }, (e, out, err) =>
      done({ code: e ? (e.code ?? 1) : 0, out, err, all: `${out}\n${err}` })
    )
  );
  srv.close();
  const build = (d) => (existsSync(join(repo, d, 'BUILD')) ? readFileSync(join(repo, d, 'BUILD'), 'utf8').trim() : '');
  const st = existsSync(join(s.data, 'update-status.json')) ? JSON.parse(s.read('data/update-status.json')) : null;
  const manifest = (d) => (existsSync(join(s.data, 'client-builds', d, 'manifest.json')) ? JSON.parse(s.read(`data/client-builds/${d}/manifest.json`)) : null);
  return { ...r, s, repo, build, st, manifest, log: s.read('logs/update.log'), tools: s.read('bin/tools.log'), lc: s.read('bin/launchctl.log') };
}
{
  const u = await fakeUpdate({ newBuild: 'new1' });
  ok(u.code === 0, 'update: a real run succeeds', u.all);
  ok(u.build('live') === 'new1' && u.build('live.prev') === 'old1' && !existsSync(join(u.s.dir, 'repo/live.next')), 'update swaps the new build in and keeps the old as live.prev');
  ok(u.lc.includes(`kickstart -k gui/${uid}/com.ganban.server`), 'update restarts the service', u.lc);
  ok(u.out.includes('ganban updated abc1234 → abc1234: build new1, healthy; backup /backups/gansty-1.db.gz'), 'update ends on one summary line with the new build', u.out);
  ok(['git pull --ff-only', 'npm ci', 'npx tsc --noEmit -p .', 'cargo test -p ganban-core -p ganban-server', 'npm run -s test:extra-tabs'].every((t) => u.tools.includes(t)), 'update runs the gate', u.tools);
}
{
  const u = await fakeUpdate({ newBuild: 'pub1', tabSuite: false });
  ok(u.code === 0 && u.build('live') === 'pub1', 'update: a tree without the private tab suite still updates', u.all);
  ok(u.tools.includes('cargo test -p ganban-core -p ganban-server') && !u.tools.includes('test:extra-tabs'), 'and skips that suite', u.tools);
}
{
  // 2026-11-02, on a real host: the new build took a few seconds to answer /health, and every failed
  // probe printed "stopped at health" (set -E hands the ERR trap to the probe's command substitution)
  // although the update then finished healthy.
  const u = await fakeUpdate({ newBuild: 'new5', slowStart: 2 });
  ok(u.code === 0 && u.out.includes('build new5, healthy'), 'update: a slow-starting build still succeeds', u.all);
  ok(!u.err.includes('stopped at'), 'update: waiting for /health prints no false "stopped at"', u.err);
}
{
  const u = await fakeUpdate({ newBuild: 'new2', bad: true });
  ok(u.code === 1, 'update: a build that never gets healthy fails', u.all);
  ok(u.err.includes('rolling back') && u.err.includes('rolled back: build old1 serves again'), 'update rolls back to the previous build', u.err);
  ok(u.build('live') === 'old1' && u.build('live.bad') === 'new2', 'the failed build is kept as live.bad');
  ok((u.lc.match(/kickstart/g) || []).length === 2, 'the rollback restarts the service again', u.lc);
}
{
  const u = await fakeUpdate({ newBuild: 'new4', buildFails: true });
  ok(u.code !== 0 && u.err.includes('stopped at "build into live.next/"; nothing swapped'), 'update: a failed build stops before the swap', u.all);
  ok(u.build('live') === 'old1' && !u.lc.includes('kickstart'), 'and the service is untouched', u.lc);
}
{
  const u = await fakeUpdate({ newBuild: 'new3', holder: true });
  ok(u.code === 1 && u.err.includes('another process holds port') && u.err.includes('Nothing was changed'), 'update stops first when the desktop app holds the port or database', u.all);
  ok(!u.tools.includes('git pull') && u.build('live') === 'old1' && !u.lc.includes('kickstart'), 'and changes nothing', u.tools);
}

// ── update.sh: the status file and the log ──
{
  const u = await fakeUpdate({ newBuild: 'new6' });
  ok(u.code === 0 && u.st?.state === 'succeeded', 'update: the status says succeeded', JSON.stringify(u.st));
  ok(u.st.step.startsWith('client apps') && u.st.fromBuild === 'old1' && u.st.toBuild === 'new6', 'with the last step and the from and to builds', JSON.stringify(u.st));
  ok(/^\d{4}-\d\d-\d\dT/.test(u.st.startedAt) && /^\d{4}-\d\d-\d\dT/.test(u.st.finishedAt) && Number.isInteger(u.st.pid), 'its times and pid', JSON.stringify(u.st));
  ok(u.st.logOffset === 0 && u.log.includes('== git pull --ff-only') && u.log.includes('ganban updated abc1234'), 'everything printed is in update.log', u.log);
  ok(u.st.clients.desktop === 'skipped: not in GANBAN_CLIENT_BUILDS' && u.out.includes('android: skipped: not in GANBAN_CLIENT_BUILDS'), "GANBAN_CLIENT_BUILDS='none' skips both", u.out);
}
{
  const u = await fakeUpdate({ newBuild: 'new7', buildFails: true });
  ok(u.st?.state === 'failed' && u.st.step === 'build into live.next/' && u.st.finishedAt, 'update: a failed update says where it stopped', JSON.stringify(u.st));
}
{
  const u = await fakeUpdate({ newBuild: 'new8', bad: true });
  ok(u.st?.state === 'failed' && u.st.step.includes('rolled back to build old1'), 'update: a rollback says so in the status', JSON.stringify(u.st));
}
{
  const u = await fakeUpdate({ newBuild: 'new9', holder: true });
  ok(u.st?.state === 'failed' && u.st.step === 'check the port and the database', 'update: a held port fails at its own step', JSON.stringify(u.st));
}
{
  // A crash left "running" with a dead pid: cleared.
  const u = await fakeUpdate({ newBuild: 'n10', status: { state: 'running', step: 'npm ci', pid: 999999999 } });
  ok(u.code === 0 && u.out.includes('clearing a stale "running" status (pid 999999999 is gone)') && u.st.state === 'succeeded', 'update clears a stale running status', u.all);
  // The server's own mark (no pid yet) is taken over silently.
  const v = await fakeUpdate({ newBuild: 'n11', status: { state: 'running', step: 'starting', pid: null } });
  ok(v.code === 0 && !v.out.includes('stale') && v.st.state === 'succeeded', "update takes over the server's starting mark", v.all);
}
{
  // Another update.sh that is alive: refused, and its status left alone.
  let other;
  const u = await fakeUpdate({
    newBuild: 'n12',
    before: async (s) => {
      other = spawn('/bin/bash', ['-c', 'sleep 30; true', 'update.sh'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 200));
      s.put('data/update-status.json', JSON.stringify({ state: 'running', step: 'npm ci', pid: other.pid }));
    },
  });
  other.kill();
  ok(u.code === 1 && u.err.includes(`another update is running (pid ${other.pid}, step "npm ci")`), 'update refuses while another runs', u.all);
  ok(u.st.pid === other.pid && u.st.state === 'running' && !u.tools.includes('git pull'), "and touches neither the other's status nor anything else", JSON.stringify(u.st));
}

// ── update.sh: its first write, before node, install.env or the network ──
{
  // No install.env: a real (not dry) run still writes its status first, and says why it stopped.
  const s = sandbox();
  const r = await s.run('update.sh');
  const st = existsSync(join(s.data, 'update-status.json')) ? JSON.parse(s.read('data/update-status.json')) : null;
  ok(r.code === 1 && r.err.includes('run ops/install.sh first'), 'update: no install.env stops it', r.all);
  ok(st?.state === 'failed' && st.step.startsWith('starting: no ') && st.step.includes('install.env') && st.finishedAt && Number.isInteger(st.pid) && Number.isInteger(st.launchdLogOffset), 'and the status says so, at the starting step (with where its launchd log begins)', JSON.stringify(st));
  ok(s.read('logs/update.log').includes('run ops/install.sh first'), 'and so does update.log');
}
{
  // node missing from launchd's PATH: the status (plain shell) attributes it, and names the fix.
  // A quote, a backslash and a control character in the PATH still make valid JSON.
  const odd = '/nowhere/q"b\\c\td';
  const u = await fakeUpdate({ newBuild: 'e1', before: async (s) => { s.env.PATH = `${s.bin}:${odd}:/usr/bin:/bin:/usr/sbin:/sbin`; } });
  if (!['/usr/bin/node', '/bin/node'].some((p) => existsSync(p))) {
    ok(u.code === 1 && u.err.includes("node not found on the updater's PATH"), 'update: no node on the PATH stops it', u.all);
    ok(u.st?.state === 'failed' && u.st.step.startsWith("starting: node not found on the updater's PATH") && u.st.step.includes('ops/install.sh'), 'and the status says so, written without node', u.s.read('data/update-status.json'));
    ok(u.st?.step.includes(odd.replace('\t', ' ')), 'the plain-shell status escapes quotes and backslashes, and blanks control characters', u.s.read('data/update-status.json'));
    ok(!u.tools.includes('git pull') && u.build('live') === 'old1', 'and nothing else ran', u.tools);
  }
}
{
  // The status's first write is a run's own (with its pid) before any other step.
  const u = await fakeUpdate({ newBuild: 'e3', buildFails: true });
  ok(u.st?.pid && u.st.startedAt && u.st.state === 'failed' && u.st.step === 'build into live.next/', 'a later failure still names its step', JSON.stringify(u.st));
}

// ── update.sh: the client builds (ops/build-clients.sh with a fake tauri) ──
{
  const u = await fakeUpdate({ newBuild: 'c1', clients: 'nokeys' });
  ok(u.code === 0 && u.out.includes('desktop: skipped: no updater key at') && u.out.includes('android: skipped: no keystore at'), 'update: missing keys skip the clients and say why', u.out);
  ok(u.st.clients.desktop.startsWith('skipped: no updater key') && u.st.clients.android.startsWith('skipped: no keystore'), 'and the status has their lines', JSON.stringify(u.st));
}
{
  const u = await fakeUpdate({ newBuild: 'c2', clients: 'built', prior: true });
  ok(u.code === 0 && u.out.includes('desktop: built 1.0.975') && u.out.includes('android: built 1.0.975'), 'update: the clients are built', u.all);
  ok(u.out.includes('ganban updated abc1234 → abc1234: build c2, healthy;'), 'the summary line is unchanged', u.out);
  ok(u.st.state === 'succeeded' && u.st.clients.desktop === 'built 1.0.975' && u.st.clients.android === 'built 1.0.975', 'the status has both lines', JSON.stringify(u.st));
  const d = u.manifest('desktop/darwin-aarch64');
  ok(d?.version === '1.0.975' && d.signature === 'SIGNATURE' && d.file === 'Ganban_1.0.975.app.tar.gz' && d.target === 'darwin' && d.arch === 'aarch64' && d.size === 7, 'the desktop manifest', JSON.stringify(d));
  const a = u.manifest('android');
  ok(a?.versionCode === 500975 && a.file === 'Ganban_1.0.975.apk' && /^[0-9a-f]{64}$/.test(a.sha256) && a.size === 4, 'the Android manifest (versionCode 500000 + count, sha256)', JSON.stringify(a));
  ok(readdirSync(join(u.s.data, 'client-builds/android')).sort().join(' ') === 'Ganban_1.0.975.apk manifest.json', 'the previous build is replaced, nothing left over');
  ok(readdirSync(join(u.s.data, 'client-builds/desktop/darwin-aarch64')).sort().join(' ') === 'Ganban_1.0.975.app.tar.gz Ganban_1.0.975.app.tar.gz.sig manifest.json', 'the desktop folder holds the bundle, its .sig and the manifest');
  const conf = u.s.read('bin/configs.seen');
  ok(conf.includes('"version": "1.0.975"') && conf.includes('"createUpdaterArtifacts": true') && conf.includes('"pubkey": "PUBKEY"') && conf.includes('"versionCode": 500975'), 'the version, updater artifacts, public key and version code go in through --config', conf);
  ok(u.s.read('bin/channel.seen') === 'build channel=host repo=unset\nandroid channel=host repo=unset\n', 'both clients build on the host update channel, with no GitHub repo', u.s.read('bin/channel.seen'));
  ok(u.s.read('bin/props.seen').includes(`storeFile=${u.s.data}/keys/release.jks`), 'gradle saw the keystore properties, with an absolute storeFile', u.s.read('bin/props.seen'));
  ok(readFileSync(join(u.repo, 'src-tauri/gen/android/keystore.properties'), 'utf8') === 'mine\n', "and the checkout's own properties are put back after");
  ok(u.tools.includes('npx tauri build --bundles app --ci --config') && u.tools.includes('npx tauri android build --apk --target aarch64 --ci --config'), 'the right tauri commands', u.tools);
  ok(u.log.includes('Compiling noisy-crate') && !u.out.includes('noisy-crate'), "the builds' output goes to the log, not the terminal", u.out);
}
{
  const u = await fakeUpdate({ newBuild: 'c3', clients: 'failed', prior: true });
  ok(u.code === 0 && u.out.includes('desktop: failed: error: linking with cc failed') && u.out.includes('android: failed:'), 'update: failed client builds are reported with why', u.all);
  ok(u.st.state === 'succeeded' && u.build('live') === 'c3' && (u.lc.match(/kickstart/g) || []).length === 1, 'and never fail or roll back the server', JSON.stringify(u.st));
  ok(u.manifest('desktop/darwin-aarch64')?.version === '0.5.900' && u.manifest('android')?.version === '0.5.900', 'the previous client builds are kept');
  ok(readFileSync(join(u.repo, 'src-tauri/gen/android/keystore.properties'), 'utf8') === 'mine\n', 'the properties are put back after a failure too');
}
{
  // A copy a killed run left behind (marked) is swept at the next start; the build then runs.
  const u = await fakeUpdate({
    newBuild: 'c4', clients: 'nokeys',
    before: async (s) => writeFileSync(join(s.dir, 'repo/src-tauri/gen/android/keystore.properties'), '# written by ops/build-clients.sh for one build; removed after it\npassword=x\n'),
  });
  ok(u.code === 0 && !existsSync(join(u.repo, 'src-tauri/gen/android/keystore.properties')), "a killed run's keystore properties are swept", u.all);
}
{
  // The clients take major.minor from tauri.conf.json; the patch stays the commit count.
  const u = await fakeUpdate({ newBuild: 'c5', clients: 'built', appVersion: '2.3.1' });
  ok(u.out.includes('desktop: built 2.3.975') && u.manifest('android')?.versionCode === 500975, 'the client version follows tauri.conf.json (2.3.<count>), the version code still 500000 + count', u.all);
}
{
  const u = await fakeUpdate({ newBuild: 'c6', clients: 'built', appVersion: 'oops' });
  ok(u.code === 0 && u.all.includes('no major.minor version in src-tauri/tauri.conf.json') && u.st.state === 'succeeded' && u.build('live') === 'c6', 'a bad app version stops the client builds, not the server update', u.all);
}

health.close();
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
