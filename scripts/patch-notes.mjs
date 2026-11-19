#!/usr/bin/env node
// Patch notes from CHANGELOG.md, for the release workflow and the host's client builds. The parser is
// the app's own (src/lib/patchNotes.pure.ts), loaded as it is.
//
//   node scripts/patch-notes.mjs release <version> [CHANGELOG.md]
//       That version's notes as markdown (the GitHub release body, latest.json's notes). Exits 1 with a
//       clear message when the changelog has no section for it, or an empty one.
//   node scripts/patch-notes.mjs host [CHANGELOG.md]
//       A host build's notes: the Unreleased section and the last released version's. Never fails: on
//       any problem it prints nothing and exits 0, so a client build never stops over its notes.
//   node scripts/patch-notes.mjs last-release [CHANGELOG.md]
//       The last released version ("1.0.11"), or nothing.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src/lib/patchNotes.pure.ts');

/** The parser module: Node strips its types itself (22.18+), else esbuild transpiles it. */
async function parser() {
  try {
    return await import(pathToFileURL(SRC).href);
  } catch {
    const { transform } = await import('esbuild');
    const { code } = await transform(readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'esm' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  }
}

async function main([mode, ...args]) {
  if (mode === 'host' || mode === 'last-release') {
    try {
      const P = await parser();
      const md = readFileSync(args[0] ?? join(root, 'CHANGELOG.md'), 'utf8');
      const out = mode === 'host' ? P.hostBuildNotes(md) : P.lastReleasedVersion(md) ?? '';
      if (out) process.stdout.write(out + '\n');
    } catch {
      /* no notes: the build goes on without them */
    }
    return;
  }
  if (mode === 'release') {
    const [version, file = join(root, 'CHANGELOG.md')] = args;
    if (!version) {
      console.error('patch-notes: release needs a version');
      process.exit(2);
    }
    const P = await parser();
    let md;
    try {
      md = readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`patch-notes: can't read ${file}: ${e.message}`);
      process.exit(1);
    }
    const v = P.normVersion(version);
    const notes = P.releaseNotes(md, v);
    if (!notes) {
      console.error(
        `patch-notes: CHANGELOG.md has no patch notes for ${v}. Move the Unreleased entries under a "## [${v}] - <date>" heading (with ### Added / Changed / Fixed / Security and their bullets) before releasing.`,
      );
      process.exit(1);
    }
    process.stdout.write(notes + '\n');
    return;
  }
  console.error('usage: patch-notes.mjs release <version> [file] | host [file] | last-release [file]');
  process.exit(2);
}

await main(process.argv.slice(2));
