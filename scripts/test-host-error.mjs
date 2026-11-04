#!/usr/bin/env node
// Unit test for host error codes (src/lib/hostError.pure.ts): the client matches a
// refusal by its code, over HTTP (DaemonError.code) and from the desktop's run_command.
// Transpiles the real source with esbuild and asserts against it.  node scripts/test-host-error.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'host-error-')), 'hostError.mjs');
execSync(`npx esbuild src/lib/hostError.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });

const H = await import(out);
let pass = 0, fail = 0;
const eq = (got, want, m) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else (fail++, console.log(`FAIL: ${m}\n  got  ${g}\n  want ${w}`));
};

class DaemonError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
const msg = 'Invalid input: This file is 380 MB, over the 50 MB limit for the AI overview.';

eq(H.AI_FILE_TOO_LARGE, 'AI_FILE_TOO_LARGE', 'the code matches the host’s');
eq(H.hostErrorCode(new DaemonError(msg, 400, H.AI_FILE_TOO_LARGE)), H.AI_FILE_TOO_LARGE, 'over HTTP: the DaemonError carries it');
eq(H.hostErrorCode(new DaemonError(msg, 400)), undefined, 'the English text alone is not a refusal code');
eq(H.hostErrorCode(new Error(msg)), undefined, 'a plain error has no code');
eq(H.hostErrorCode(msg), undefined, 'a string has no code');
eq(H.hostErrorCode(null), undefined, 'null');
eq(H.hostErrorCode({ error: msg, code: H.AI_FILE_TOO_LARGE }), H.AI_FILE_TOO_LARGE, 'a local run_command refusal');

eq(H.localErrorParts('Not found: task'), { message: 'Not found: task' }, 'local: a plain message');
eq(H.localErrorParts({ error: msg, code: 'AI_FILE_TOO_LARGE' }), { message: msg, code: 'AI_FILE_TOO_LARGE' }, 'local: a coded refusal');
eq(H.localErrorParts(new Error('x')), null, 'an Error is left alone');
eq(H.localErrorParts(42), null, 'anything else is left alone');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
