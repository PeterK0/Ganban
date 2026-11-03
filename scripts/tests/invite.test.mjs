import assert from 'node:assert/strict';
import { extractEnrollToken, inviteLink, enrollQr, parseInviteLink, parseTailscaleShareLink } from '../../.test-build/invite.mjs';

// A Join screen takes WHATEVER the person was given. The owner's UI hands out
// links and QR codes; a member's "Pair another device" hands out a code, a link
// and a QR. All of them must land as the one token.
const T = 'a544c210db8f6e1c9b2d4f7e3a1c5b9d0e2f4a6c8b1d3f5e7a9c2b4d6f8e0a1c';
const HOST = 'http://100.84.224.92:8765';

let n = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); n++; };

eq(extractEnrollToken(T), T, 'bare code');
eq(extractEnrollToken(`  ${T}\n`), T, 'bare code, surrounding whitespace');
eq(extractEnrollToken(inviteLink(HOST, T)), T, 'invite/pairing link');
eq(extractEnrollToken(inviteLink(HOST, T, 'https://login.tailscale.com/admin/invite/abc')), T, 'two-step link with &ts=');
eq(extractEnrollToken(`${HOST}/?invite=${T}`), T, 'query-form link');
eq(extractEnrollToken(`https://studio.tail1234.ts.net/#invite=${T}`), T, 'MagicDNS https link');
eq(extractEnrollToken(enrollQr(HOST, T)), T, 'QR payload text');
eq(extractEnrollToken(''), null, 'empty');
eq(extractEnrollToken('   '), null, 'blank');
eq(extractEnrollToken(HOST), null, 'a link with no token in it');
eq(extractEnrollToken(`${HOST}/#invite=`), null, 'a link with an empty token');
eq(extractEnrollToken('two words'), null, 'prose is not a code');
eq(extractEnrollToken('http://[bad'), null, 'unparseable url');

// The desktop's "Join a project" needs HOST + TOKEN. A pairing link minted on a
// phone (Your devices → Pair another device) must round-trip through it — that
// is how a phone and a fresh laptop become one account.
const deep = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
deep(parseInviteLink(inviteLink(HOST, T)), { u: HOST, t: T }, 'pairing link → host + token');
deep(parseInviteLink(inviteLink(HOST, T, 'https://login.tailscale.com/admin/invite/abc')), { u: HOST, t: T, ts: 'https://login.tailscale.com/admin/invite/abc' }, 'two-step link keeps the share');
deep(parseInviteLink(enrollQr(HOST, T)), { u: HOST, t: T }, 'QR payload');
deep(parseInviteLink(`https://studio.tail1234.ts.net/#invite=${T}`), { u: 'https://studio.tail1234.ts.net', t: T }, 'MagicDNS https');
eq(parseInviteLink(T), null, 'a bare code has no host — the desktop needs the link');
eq(parseInviteLink('hello'), null, 'prose');

// A machine-share link made by hand in the Tailscale admin console — the path
// that needs no API token and so can't expire under the owner.
eq(parseTailscaleShareLink('https://login.tailscale.com/admin/invite/AbC123_-xyz'), 'https://login.tailscale.com/admin/invite/AbC123_-xyz', 'admin console share link');
eq(parseTailscaleShareLink('  https://login.tailscale.com/invite/AbC123\n'), 'https://login.tailscale.com/invite/AbC123', 'API-shaped share link, trimmed');
eq(parseTailscaleShareLink('http://login.tailscale.com/admin/invite/x'), null, 'must be https');
eq(parseTailscaleShareLink('https://evil.example/admin/invite/x'), null, 'must be Tailscale');
eq(parseTailscaleShareLink('https://login.tailscale.com/admin/machines'), null, 'not an invite');
eq(parseTailscaleShareLink(''), null, 'empty');

console.log(`✓ invite parsing — ${n} assertions`);
