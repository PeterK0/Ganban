#!/usr/bin/env node
// Unit test for the in-flight save tracker (src/lib/inflightSaves.ts) that
// lets an editor's unload flush re-send a save the page would cut off.
// node scripts/test-inflight-saves.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'infl-')), 'infl.mjs');
execSync(`npx esbuild src/lib/inflightSaves.ts --format=esm --outfile=${out} --log-level=warning`, { cwd: root, stdio: 'inherit' });
const { inflightSaves } = await import(out);

let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

const t = inflightSaves();
const sent = [];
const first = deferred();
const p = t.track(() => (sent.push('A'), sent.length === 1 ? first.promise : Promise.resolve('again')));
ok(t.size === 1 && sent.join() === 'A', 'tracked while in flight');

// The page goes away with the save unanswered: it goes out again.
await t.resend();
ok(sent.join() === 'A,A', `resent once, sent ${sent.join()}`);
ok(t.size === 1, 'still tracked until the first copy settles');

first.resolve('done');
ok((await p) === 'done', 'the caller gets the first answer');
ok(t.size === 0, 'dropped once settled');
await t.resend();
ok(sent.length === 2, 'a settled save is not sent again');

// A failed save is dropped too, and the caller hears the failure.
const failing = t.track(() => Promise.reject(new Error('no')));
let heard = false;
await failing.catch(() => (heard = true));
ok(heard && t.size === 0, 'a failed save is dropped and the caller hears it');

// A save that throws before it returns a promise.
const sync = t.track(() => { throw new Error('sync'); });
heard = false;
await sync.catch(() => (heard = true));
ok(heard && t.size === 0, 'a synchronous throw rejects and is not tracked');

// A resend that fails doesn't reject the flush.
const t2 = inflightSaves();
let n = 0;
const never = new Promise(() => {});
t2.track(() => (++n === 1 ? never : Promise.reject(new Error('offline'))));
let threw = false;
await t2.resend().catch(() => (threw = true));
ok(!threw && n === 2, 'resend settles even when a resend fails');

// A filter keeps a superseded save out of the resend.
const t3 = inflightSaves();
const hits = [];
const hang = new Promise(() => {});
t3.track(() => (hits.push('form'), hang), { title: 'old' });
t3.track(() => (hits.push('pin'), hang), { pinned: true });
await Promise.race([t3.resend((m) => !('title' in m)), new Promise((r) => setTimeout(r, 10))]);
ok(hits.join() === 'form,pin,pin', `only the unfiltered save goes again, sent ${hits.join()}`);

console.log(`inflight saves: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
