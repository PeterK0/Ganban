#!/usr/bin/env node
// The GitHub channel's `latest.json` (ADR 0008, docs/design/UPDATES.md § GitHub Releases): composed once
// every desktop build has uploaded its signed bundle to the draft release, so parallel builds can't
// overwrite each other's platforms (tauri-action's own latest.json is read-modify-write per job).
//
//   node scripts/updater-json.mjs --repo owner/name --tag v1.0.2 --assets assets.json --sigs <dir> \
//        --out latest.json [--require darwin-aarch64,darwin-x86_64,linux-x86_64,windows-x86_64]
//
// assets.json is GitHub's asset list (`[{name}]`, or `{assets: [{name}]}`); <dir> holds the release's
// downloaded *.sig files. Each signed bundle gets `<os>-<arch>-<installer>` (the updater picks the one
// matching how the app was installed) and the first per platform also `<os>-<arch>`: the .app on macOS,
// the MSI on Windows (tauri-action's updaterJsonPreferNsis default) and the AppImage on Linux.
// Exits 1 when a required platform has no signed bundle, so the release stays a draft.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCH = { aarch64: 'aarch64', arm64: 'aarch64', x64: 'x86_64', amd64: 'x86_64', x86_64: 'x86_64', x86: 'i686', i386: 'i686' };

/** What a bundle's file name says: os, arch and installer, or null for anything else. */
export function classify(name) {
  let m;
  if ((m = /_(aarch64|x64)\.app\.tar\.gz$/.exec(name))) return { os: 'darwin', arch: ARCH[m[1]], installer: 'app' };
  if ((m = /_(x64|arm64|x86)-setup\.exe$/.exec(name))) return { os: 'windows', arch: ARCH[m[1]], installer: 'nsis' };
  if ((m = /_(x64|arm64|x86)_[A-Za-z-]+\.msi$/.exec(name))) return { os: 'windows', arch: ARCH[m[1]], installer: 'msi' };
  if ((m = /_(amd64|aarch64|arm64|i386)\.AppImage$/.exec(name))) return { os: 'linux', arch: ARCH[m[1]], installer: 'appimage' };
  if ((m = /_(amd64|arm64|i386)\.deb$/.exec(name))) return { os: 'linux', arch: ARCH[m[1]], installer: 'deb' };
  if ((m = /\.(x86_64|aarch64|i386)\.rpm$/.exec(name))) return { os: 'linux', arch: ARCH[m[1]], installer: 'rpm' };
  return null;
}

const PRIMARY = { darwin: ['app'], windows: ['msi', 'nsis'], linux: ['appimage', 'deb', 'rpm'] };

/** The latest.json for a release: `assetNames` are its assets, `sigs` maps a .sig asset's name to its text. */
export function composeUpdaterJson({ repo, tag, version, notes = '', pubDate, assetNames, sigs }) {
  const names = new Set(assetNames);
  const found = [];
  for (const sigName of assetNames) {
    if (!sigName.endsWith('.sig')) continue;
    const bundle = sigName.slice(0, -4);
    const kind = classify(bundle);
    const signature = sigs[sigName];
    if (!kind || !names.has(bundle) || !signature?.trim()) continue;
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(bundle)}`;
    found.push({ ...kind, entry: { signature: signature.trim(), url } });
  }
  const platforms = {};
  for (const f of found) platforms[`${f.os}-${f.arch}-${f.installer}`] = f.entry;
  for (const f of found) {
    const key = `${f.os}-${f.arch}`;
    if (platforms[key]) continue;
    const best = PRIMARY[f.os].map((i) => platforms[`${key}-${i}`]).find(Boolean);
    if (best) platforms[key] = best;
  }
  return { version, notes, pub_date: pubDate, platforms };
}

/** The required platforms the JSON lacks. */
export function missingPlatforms(json, required) {
  return required.filter((p) => !json.platforms[p]);
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      console.error(`updater-json: bad argument ${argv[i]}`);
      process.exit(2);
    }
    opt[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['repo', 'tag', 'assets', 'sigs', 'out']) {
    if (!opt[k]) {
      console.error(`updater-json: --${k} is required`);
      process.exit(2);
    }
  }
  const raw = JSON.parse(readFileSync(opt.assets, 'utf8'));
  const assetNames = (Array.isArray(raw) ? raw : raw.assets ?? []).map((a) => a.name);
  const sigs = {};
  for (const f of readdirSync(opt.sigs)) if (f.endsWith('.sig')) sigs[f] = readFileSync(join(opt.sigs, f), 'utf8');
  const json = composeUpdaterJson({
    repo: opt.repo,
    tag: opt.tag,
    version: opt.tag.replace(/^v/, ''),
    notes: opt.notes ?? `Ganban ${opt.tag}`,
    pubDate: new Date().toISOString(),
    assetNames,
    sigs,
  });
  const missing = missingPlatforms(json, (opt.require ?? '').split(',').filter(Boolean));
  if (missing.length) {
    console.error(`updater-json: no signed bundle for ${missing.join(', ')}; found ${Object.keys(json.platforms).join(', ') || 'none'}`);
    process.exit(1);
  }
  writeFileSync(opt.out, JSON.stringify(json, null, 2) + '\n');
  console.log(`updater-json: ${opt.out} lists ${Object.keys(json.platforms).join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
