#!/usr/bin/env node
// Unit test for the update source (src/lib/updateSource.pure.ts): the choice and its default,
// the desktop's host key pin, the phone's certificate match, and the Android version codes,
// checked against ops/version-code.mjs (the formula the builds use).
//   node scripts/test-update-source.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'updsrc-')), 'src.mjs');
execSync(`npx esbuild src/lib/updateSource.pure.ts --bundle --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const S = await import(out);
const V = await import(pathToFileURL(join(root, 'ops/version-code.mjs')).href);

let pass = 0, fail = 0;
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? pass++ : (fail++, console.log('FAIL:', m, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b))));

const host = { kind: 'host' }, gh = { kind: 'github', repo: 'o/r' }, broken = { kind: 'github-broken' }, none = { kind: 'none' };

// ----- the choice: the device's, else the channel's; a dev build has none
eq(S.chosenSource(null, host), 'host', 'a host build defaults to This server');
eq(S.chosenSource(null, gh), 'github', 'a GitHub build defaults to GitHub Releases');
eq(S.chosenSource(null, broken), 'github', 'even without its repo');
eq(S.chosenSource('host', gh), 'host', "the device's choice wins over the channel");
eq(S.chosenSource('github', host), 'github', 'either way');
eq(S.chosenSource('bogus', host), 'host', 'a bad stored value falls back to the default');
eq(S.chosenSource('github', none), null, 'a dev build has no source');
eq(S.isCrossSource('github', host), true, 'a host build on GitHub is across');
eq(S.isCrossSource('host', host), false, 'its own source is not');
eq(S.isCrossSource('host', gh), true, 'a GitHub build on This server is across');

// ----- the desktop's key pin
const mkKey = (id) => Buffer.from(`untrusted comment: minisign public key: ${id}\nRWS...\n`).toString('base64');
const projectKey = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUyQUFCQTU4NTdEQjkyQkYKUldTL2t0dFhXTHFxNG1QTkZ0WHE2ZDZWOXZ6SjNZYm5IRG1WaTlnaDNjSm5Tdnh4SEFtbmtZd0gK';
eq(S.keyFingerprint(projectKey), 'E2AABA5857DB92BF', "the project key's id (src-tauri/updater/github.pub)");
eq(S.keyFingerprint('not base64 at all!'), null, 'not a key');
eq(S.keyFingerprint(''), null, 'no key');
const A = mkKey('AAAAAAAAAAAAAAAA'), B = mkKey('BBBBBBBBBBBBBBBB');
eq(S.decideHostKey(null, A), { kind: 'first', key: A }, 'nothing pinned: pin it on the first switch');
eq(S.decideHostKey(A, A), { kind: 'trusted', key: A }, 'the pinned key is trusted');
eq(S.decideHostKey(A + '\n', ' ' + A), { kind: 'trusted', key: A }, 'whitespace is no change');
eq(S.decideHostKey(A, B), { kind: 'changed', key: B, was: A }, 'a different key asks first');
eq(S.decideHostKey(A, null), { kind: 'trusted', key: A }, 'an older host that advertises nothing: the pin stands');
eq(S.decideHostKey(null, ''), { kind: 'unknown' }, 'no pin and nothing advertised');

// ----- the phone's certificate match
const c1 = 'ab'.repeat(32), c2 = 'cd'.repeat(32);
const colons = c1.toUpperCase().match(/../g).join(':');
eq(S.normCert(colons), c1, "keytool's colon form");
eq(S.normCert('xyz'), null, 'not a fingerprint');
eq(S.certMatch([c1], colons), 'match', 'same certificate, any spelling');
eq(S.certMatch([c2, c1], c1), 'match', 'one of the signing history');
eq(S.certMatch([c1], c2), 'mismatch', 'another certificate');
eq(S.certMatch([c1], null), 'unknown', 'the source does not say');
eq(S.certMatch([], c1), 'unknown', 'the app does not say (an older plugin)');
eq(S.certReason('match', 'host'), null, 'a match has no reason');
eq(/one-time reinstall/.test(S.certReason('mismatch', 'github')), true, 'a mismatch explains the reinstall');
eq(/update the server/.test(S.certReason('unknown', 'host')), true, 'an older server says to update it');

// ----- Android version codes, the same as ops/version-code.mjs
const host109 = S.hostVersionCode('1.0.9', 42);
eq(S.releaseVersionCode('1.0.9'), 1000009, '1.0.9 keeps its old code');
eq(S.releaseVersionCode('1.0.9') < host109 && host109 < S.releaseVersionCode('1.0.10'), true, '1.0.9 (old code) < a host build after 1.0.9 < 1.0.10 (new code)');
eq(S.hostVersionCode('1.0.9', 5000) < S.releaseVersionCode('1.0.10'), true, 'the commits are capped, so a host build never passes the next release');
eq(S.hostVersionCode('1.0.10', 0) <= S.releaseVersionCode('1.0.10') && S.releaseVersionCode('1.0.10') < S.hostVersionCode('1.0.10', 1), true, 'a host build after 1.0.10 sorts after it');
eq(S.hostVersionCode('1.0.9', 999) < S.hostVersionCode('1.0.10', 0), true, 'host builds grow across a release');
eq(S.releaseVersionCode('1.1.0') > S.hostVersionCode('1.0.99', 999), true, 'a minor release passes every host build before it');
eq(S.releaseVersionCode('2.99.999') <= V.MAX_CODE, true, "major 2 still fits Android's ceiling");
let threw = false;
try { V.releaseCode('3.0.0'); } catch { threw = true; }
eq(threw, true, 'major 3 is past the ceiling: the build script refuses it');
for (const v of ['1.0.2', '1.0.9', '1.0.10', '1.2.3', '2.0.0', 'v1.0.11']) eq(S.releaseVersionCode(v), V.releaseCode(v), `release ${v}: the app and the build agree`);
for (const [v, n] of [['1.0.9', 0], ['1.0.9', 42], ['1.0.10', 999], ['1.0.10', 1234], ['2.3.1', 975]]) eq(S.hostVersionCode(v, n), V.hostCode(v, n), `host ${v}+${n}: the app and the build agree`);
eq(S.compareCodes(1000009, host109), 'available', 'GitHub 1.0.9 → a host build: installs');
eq(S.compareCodes(host109, S.releaseVersionCode('1.0.9')), 'older', "a host build → GitHub 1.0.9: Android can't go back");
eq(S.compareCodes(host109, S.releaseVersionCode('1.0.10')), 'available', 'a host build → GitHub 1.0.10: installs');
eq(S.compareCodes(host109, host109), 'up-to-date', 'the same code');
eq(S.compareCodes(host109, 0), 'no-build', 'no build');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
