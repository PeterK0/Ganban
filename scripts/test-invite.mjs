#!/usr/bin/env node
// Re-runnable unit test for the invite/pairing payload logic (the pure,
// dependency-free src/lib/invite.pure.ts). Transpiles the REAL source with
// esbuild and asserts against it — no mirror, no drift.
//
//   node scripts/test-invite.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'inv-')), 'inv.mjs');
execSync(`npx esbuild src/lib/invite.pure.ts --format=esm --outfile=${out}`, { cwd: root, stdio: 'inherit' });

const { inviteLink, enrollQr, parseInviteLink, parseEnrollPayload, isTailnetUrl, diagnoseUnreachable } = await import(out);
let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));

const U = 'http://100.64.1.2:8765';
const T = 'abc123';
const TS = 'https://login.tailscale.com/admin/invite/XYZ?foo=bar'; // has reserved chars

// ---- link round-trips ----
{
  const link = inviteLink(U, T);
  const p = parseInviteLink(link);
  ok(p?.u === U && p?.t === T && p?.ts === undefined, 'link without ts round-trips, ts absent');
  ok(link === `${U}/#invite=${T}`, 'link shape unchanged when no ts (backward compatible)');
}
{
  const link = inviteLink(U, T, TS);
  const p = parseInviteLink(link);
  ok(p?.u === U && p?.t === T, 'link with ts: u/t still parse');
  ok(p?.ts === TS, 'link with ts: ts decoded exactly (incl reserved chars)');
  ok(link.includes('&ts='), 'ts rides as a &ts= param');
}

// ---- backward compat: an OLD link (no ts) from a prior build ----
ok(parseInviteLink('http://h:1/#invite=tok')?.t === 'tok', 'legacy link parses');
ok(parseInviteLink('http://h:1/?invite=tok')?.t === 'tok', 'legacy query-param link parses');
ok(parseInviteLink('not a link') === null, 'garbage -> null');

// ---- QR round-trips ----
{
  const p = parseEnrollPayload(enrollQr(U, T));
  ok(p?.u === U && p?.t === T && p?.ts === undefined, 'QR without ts round-trips');
}
{
  const p = parseEnrollPayload(enrollQr(U, T, TS));
  ok(p?.ts === TS, 'QR with ts round-trips');
}
ok(parseEnrollPayload('{"u":"x"}') === null, 'QR missing token -> null');
ok(parseEnrollPayload('{"u":"x","t":"y","ts":""}')?.ts === undefined, 'blank ts ignored');
// parseInviteLink also accepts a raw QR JSON string (its first branch):
ok(parseInviteLink(enrollQr(U, T, TS))?.ts === TS, 'parseInviteLink falls through to QR JSON');

// ---- tailnet detection + diagnosis ----
ok(isTailnetUrl(U) && !isTailnetUrl('http://192.168.1.5:8765'), 'isTailnetUrl: 100.x yes, LAN no');
// MagicDNS FQDNs are tailnet-only too (we now prefer them in invites).
ok(isTailnetUrl('http://host.tail1234.ts.net:8765'), 'isTailnetUrl: MagicDNS FQDN with port');
ok(isTailnetUrl('http://host.tail1234.ts.net'), 'isTailnetUrl: MagicDNS FQDN no port');
ok(isTailnetUrl('http://host.tail1234.ts.net:8765/#invite=tok'), 'isTailnetUrl: MagicDNS FQDN with link fragment');
ok(!isTailnetUrl('http://example.com:8765') && !isTailnetUrl('http://notts.net.evil.com/'), 'isTailnetUrl: non-ts.net hosts no');
ok(/accept the shared machine/i.test(diagnoseUnreachable(U)), 'tailnet diagnosis mentions accepting the machine');
ok(/accept the shared machine/i.test(diagnoseUnreachable('http://host.tail1234.ts.net:8765')), 'MagicDNS diagnosis mentions accepting the machine');
ok(/local-network/i.test(diagnoseUnreachable('http://192.168.1.5:8765')), 'LAN diagnosis names the local network');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
