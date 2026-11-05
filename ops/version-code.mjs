#!/usr/bin/env node
// Android version codes, in one place (docs/design/UPDATES.md § Versions). Android installs an APK
// only over a smaller code, so releases and host builds share one order: a host build sorts after
// the release it follows (the version in tauri.conf.json) and before the next one, so a phone can
// move from GitHub Releases to its host's builds, and back once the next release is out.
//
//   node ops/version-code.mjs release <x.y.z>         a GitHub release's code
//   node ops/version-code.mjs host <x.y.z> <commits>  a host build after release x.y.z, <commits> later
//
// Releases from 1.0.10 on: (major·1000000 + minor·1000 + patch) · 1000. Before: without the · 1000
// (Tauri's own formula). A host build: release · 1000 + the commits since the release (at most 999).
// Android's ceiling (2100000000) caps this scheme below major version 3.
// src/lib/updateSource.pure.ts holds the same formulas; scripts/test-update-source.mjs checks both.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FIRST_SCALED = [1, 0, 10];
export const MAX_CODE = 2_100_000_000;

function parts(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) throw new Error(`not a version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const base = ([a, b, c]) => a * 1_000_000 + b * 1_000 + c;
const scaled = (p) => {
  for (let i = 0; i < 3; i++) if (p[i] !== FIRST_SCALED[i]) return p[i] > FIRST_SCALED[i];
  return true;
};

function checked(code, what) {
  if (!Number.isSafeInteger(code) || code <= 0 || code > MAX_CODE) throw new Error(`${what}: version code ${code} is outside Android's range`);
  return code;
}

export function releaseCode(version) {
  const p = parts(version);
  return checked(scaled(p) ? base(p) * 1000 : base(p), version);
}

export function hostCode(version, commits) {
  const n = Math.max(0, Math.min(999, Math.floor(Number(commits) || 0)));
  return checked(base(parts(version)) * 1000 + n, `${version} + ${n}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [mode, version, commits] = process.argv.slice(2);
  try {
    if (mode === 'release' && version) console.log(releaseCode(version));
    else if (mode === 'host' && version) console.log(hostCode(version, commits));
    else {
      console.error('usage: node ops/version-code.mjs release <x.y.z> | host <x.y.z> <commits>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`version-code: ${e.message}`);
    process.exit(1);
  }
}
