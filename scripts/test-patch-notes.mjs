#!/usr/bin/env node
// Patch notes (src/lib/patchNotes.pure.ts and scripts/patch-notes.mjs): the parser on the real
// CHANGELOG.md and on odd input, "which entries are new", the release's and the host build's
// notes, and the script the release workflow and ops/build-clients.sh run.
//   node scripts/test-patch-notes.mjs
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pn-'));
const out = join(tmp, 'pn.mjs');
execSync(`npx esbuild src/lib/patchNotes.pure.ts --format=esm --outfile=${out} --log-level=error`, { cwd: root, stdio: 'inherit' });
const P = await import(out);
let pass = 0, fail = 0;
const ok = (c, m, extra) => (c ? pass++ : (fail++, console.log('FAIL:', m, extra ?? '')));

// ----- the real CHANGELOG.md
const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const all = P.parsePatchNotes(md);
ok(all.length >= 17 && all[0].version === 'Unreleased', 'the changelog parses, Unreleased first', all.map((r) => r.version).join(' '));
const r1011 = all.find((r) => r.version === '1.0.11');
ok(r1011?.date === '2026-11-06' && r1011.sections.map((s) => s.kind).join(',') === 'Fixed,Added', '1.0.11: its date and sections', JSON.stringify(r1011?.sections.map((s) => s.kind)));
const appimage = r1011.sections[0].entries[0];
ok(appimage.text.startsWith('**The Linux AppImage starts on rolling distributions') && appimage.text.includes('It now uses the system\'s.') && !appimage.text.includes('\n'), 'a wrapped bullet is one entry, its lines joined', appimage.text);
const r107 = all.find((r) => r.version === '1.0.7');
const finance = r107.sections[0].entries[0];
ok(finance.sub.length >= 5 && finance.sub[0].startsWith('Import statements from CSV or Excel.') && finance.sub[0].includes('Re-importing an overlapping export adds nothing.'), 'nested bullets are the entry\'s sub-items, wrapped lines joined', JSON.stringify(finance.sub.slice(0, 2)));
const r100 = all.find((r) => r.version === '1.0.0');
ok(r100.intro === 'The first public release. Ganban is now open source under the AGPL-3.0.', 'a paragraph under a heading is the release\'s intro', r100.intro);
const r106 = all.find((r) => r.version === '1.0.6');
ok(r106.sections.length === 1 && r106.sections[0].kind === '' && r106.sections[0].entries.length >= 3, 'bullets before any ### go in an unnamed section');
ok(!all.some((r) => r.sections.some((s) => s.entries.some((e) => e.text.startsWith('[') && e.text.includes('compare')))), 'the link references at the bottom are not entries');
ok(P.currentRelease(all)?.version === 'Unreleased' || P.currentRelease(all)?.version === all.find(P.hasEntries).version, 'this build is the first release with entries');

// ----- ids
const ids = P.allEntryIds(all);
ok(ids.every((id) => /^[0-9a-f]{8}$/.test(id)), 'ids are 8 hex digits');
ok(new Set(ids).size >= ids.length - 2, 'ids are (nearly all) distinct', `${new Set(ids).size}/${ids.length}`);
ok(P.entryId('**A fix.** Over\n  two lines.') === P.entryId('**A fix.** Over two lines.'), 'an id ignores how the text wraps');

// The same bullet moving from Unreleased to its release keeps its id: "seen" is by entry.
const before = P.parsePatchNotes('## [Unreleased]\n\n### Fixed\n\n- **A fix.** Here.\n\n## [1.0.11] - 2026-11-06\n\n### Added\n\n- **Old.**\n');
const after = P.parsePatchNotes('## [Unreleased]\n\n## [1.0.12] - 2026-11-12\n\n### Fixed\n\n- **A fix.**\n  Here.\n\n## [1.0.11] - 2026-11-06\n\n### Added\n\n- **Old.**\n');
ok(P.unseenEntryIds(after, P.allEntryIds(before)).length === 0, 'released, an Unreleased entry the device saw is still seen');

// ----- which entries are new
ok(P.unseenEntryIds(all, null).length === 0, 'a first install (nothing recorded) has nothing new');
ok(P.unseenEntryIds(all, ids).length === 0, 'everything seen: nothing new');
const seenAllButTwo = ids.slice(2);
ok(P.unseenEntryIds(all, seenAllButTwo).join() === ids.slice(0, 2).join(), 'the unseen entries, in order');
const grown = P.parsePatchNotes('## [Unreleased]\n\n### Added\n\n- **Brand new.**\n\n' + md.slice(md.indexOf('## [Unreleased]') + '## [Unreleased]'.length));
const fresh = P.unseenEntryIds(grown, ids);
ok(fresh.length === 1 && fresh[0] === P.entryId('**Brand new.**'), 'a host build with one more entry: that one is new', fresh.join());
ok(P.entriesNotIn(grown, all).join() === fresh.join(), 'and it is what the update brings');
const only = P.onlyEntries(grown, fresh);
ok(only.length === 1 && only[0].sections.length === 1 && only[0].sections[0].entries[0].text === '**Brand new.**', 'onlyEntries keeps just those, dropping empty sections and releases');

// ----- a release's notes (the GitHub release body, latest.json)
const n1011 = P.releaseNotes(md, '1.0.11');
ok(n1011?.startsWith('### Fixed') && n1011.includes('### Added') && !n1011.includes('## [1.0.10]') && !n1011.includes('## [1.0.11]'), "a version's notes, without its heading or the next version", n1011?.slice(0, 80));
ok(P.releaseNotes(md, 'v1.0.11') === n1011, 'a leading v is ignored');
ok(P.releaseNotes(md, '9.9.9') === null, 'no section: null');
ok(P.releaseNotes('## [1.0.12] - 2026-11-12\n\n### Fixed\n\n## [1.0.11] - x\n\n- a\n', '1.0.12') === null, 'an empty section: null');
const frag = P.parsePatchNotes(n1011, '1.0.11');
ok(frag.length === 1 && frag[0].version === '1.0.11' && P.allEntryIds(frag).join() === P.allEntryIds([r1011]).join(), 'a fragment parses as that version, with the same ids');
const body = n1011 + '\n\n---\n\nDownload the installer for your OS below. Builds are not notarised.\n';
const bodyParsed = P.parsePatchNotes(body, '1.0.11');
ok(bodyParsed.length === 1 && P.allEntryIds(bodyParsed).join() === P.allEntryIds([r1011]).join(), "the release body's install text is not an entry, nor a release");

// ----- a host build's notes
const host = P.hostBuildNotes(md);
ok(host.startsWith('## [Unreleased]') && host.includes('\n## [1.0.11] - 2026-11-06') && !host.includes('## [1.0.10]'), 'a host build: Unreleased and the last release', host.split('\n').filter((l) => l.startsWith('## ')).join(' | '));
ok(P.hostBuildNotes('## [Unreleased]\n\n## [1.0.11] - x\n\n- a\n') === '## [1.0.11] - x\n\n- a', 'an empty Unreleased is left out');
ok(P.hostBuildNotes('nothing') === '' && P.hostBuildNotes('') === '', 'no sections: empty');
ok(P.lastReleasedVersion(md) === '1.0.11', 'the last released version');

// ----- odd input never throws
for (const odd of [null, undefined, '', '\n\n', '# Title only', '###', '## ', '- a bullet, nothing else', '   indented text', '## [1.0.1]\n  continuation with no entry', '* star bullet\n+ plus bullet', '## [x] - \r\n### Fixed\r\n- crlf\r\n']) {
  let r;
  try {
    r = P.parsePatchNotes(odd, '1.0.0');
    ok(Array.isArray(r), `odd input ${JSON.stringify(odd)} parses`);
  } catch (e) {
    ok(false, `odd input ${JSON.stringify(odd)} threw`, e.message);
  }
}
const lone = P.parsePatchNotes('- a bullet, nothing else', '1.0.12');
ok(lone.length === 1 && lone[0].version === '1.0.12' && lone[0].sections[0].entries[0].text === 'a bullet, nothing else', 'a lone bullet is the given version\'s');
ok(P.parsePatchNotes('* star\n+ plus').flatMap((r) => r.sections[0].entries.map((e) => e.text)).join() === 'star,plus', '* and + bullets count');
ok(P.parsePatchNotes('## [x] - \r\n### Fixed\r\n- crlf\r\n')[0].sections[0].entries[0].text === 'crlf', 'CRLF line ends');
ok(P.parsePatchNotes('Ganban v1.0.11').length === 0, "the old notes (\"Ganban v1.0.11\") have no entries");
ok(P.normVersion('[v1.0.2]') === '1.0.2' && P.normVersion('unreleased') === 'Unreleased', 'versions normalise');

// ----- inline text
const parts = P.inlineParts('**Bold `code` lead.** Then `npm run x` and [ADR 0007](docs/README.md).');
ok(JSON.stringify(parts) === JSON.stringify([
  { kind: 'bold', text: 'Bold code lead.' },
  { kind: 'text', text: ' Then ' },
  { kind: 'code', text: 'npm run x' },
  { kind: 'text', text: ' and ADR 0007.' },
]), 'bold, code and links (as their label)', JSON.stringify(parts));
ok(JSON.stringify(P.inlineParts('plain ** not bold')) === JSON.stringify([{ kind: 'text', text: 'plain ** not bold' }]), 'an unclosed ** stays text');

// ----- the script
const cli = (...args) => spawnSync(process.execPath, [join(root, 'scripts/patch-notes.mjs'), ...args], { encoding: 'utf8' });
let r = cli('release', '1.0.11');
ok(r.status === 0 && r.stdout.trim() === n1011, 'release <version> prints its notes', r.stderr);
r = cli('release', '9.9.9');
ok(r.status === 1 && /no patch notes for 9\.9\.9/.test(r.stderr) && r.stdout === '', 'a release without notes fails, saying so', r.stderr);
const empty = join(tmp, 'empty.md');
writeFileSync(empty, '## [Unreleased]\n\n## [1.0.12] - 2026-11-12\n\n### Fixed\n\n## [1.0.11] - x\n\n- a\n');
r = cli('release', '1.0.12', empty);
ok(r.status === 1 && /no patch notes for 1\.0\.12/.test(r.stderr), 'an empty section fails too', r.stderr);
r = cli('release');
ok(r.status === 2, 'release without a version is misuse');
r = cli('host');
ok(r.status === 0 && r.stdout.trim() === host, 'host prints the host build\'s notes', r.stderr);
r = cli('host', join(tmp, 'missing.md'));
ok(r.status === 0 && r.stdout === '', 'host never fails: a missing changelog prints nothing');
r = cli('last-release');
ok(r.status === 0 && r.stdout.trim() === '1.0.11', 'last-release prints the version');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
