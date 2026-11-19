// Patch notes: what each version fixed and added, read from CHANGELOG.md (Keep a Changelog:
// `## [version] - date`, `### Added / Changed / Fixed / Security`, bullets with a bold lead).
// One parser for every place the notes show up: the app's bundled notes, the update offer
// (a GitHub release's section, a host build's notes), the release workflow and the host's
// client builds (scripts/patch-notes.mjs). Pure and dependency-free: no imports, only syntax
// Node can strip, so the scripts can load this file as it is. Tested by `npm run test:patchnotes`.

export interface PatchEntry {
  /** Stable for the entry's text: the same bullet under Unreleased and under its release has the same id. */
  id: string;
  /** The bullet's text, its wrapped lines joined (inline markdown kept). */
  text: string;
  /** Nested bullets under it. */
  sub: string[];
}

export interface PatchSection {
  /** "Added", "Changed", "Fixed", "Security"…; '' for bullets before any `###`. */
  kind: string;
  entries: PatchEntry[];
}

export interface PatchRelease {
  /** "Unreleased", or the version without a leading "v" ("1.0.11"). */
  version: string;
  date: string | null;
  /** A paragraph under the heading, before the first section. */
  intro: string | null;
  sections: PatchSection[];
}

/** "v1.0.12" and "[1.0.12]" → "1.0.12"; "unreleased" → "Unreleased". */
export function normVersion(v: string): string {
  const s = v.trim().replace(/^\[|\]$/g, '').trim().replace(/^v(?=\d)/i, '');
  return /^unreleased$/i.test(s) ? 'Unreleased' : s;
}

/** FNV-1a over the entry's text with its whitespace collapsed, as 8 hex digits. */
export function entryId(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const RELEASE = /^##\s+(.+?)\s*$/;
const SECTION = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*+]\s+(.*)$/;
const SUB_BULLET = /^\s+[-*+]\s+(.*)$/;

/** Split a release heading's text ("[1.0.11] - 2026-11-06") into version and date. */
function releaseHeading(h: string): { version: string; date: string | null } {
  const m = /^(\[[^\]]+\]|\S+)(?:\s+[-–—]\s+(.+))?$/.exec(h.trim());
  if (!m) return { version: normVersion(h), date: null };
  return { version: normVersion(m[1]), date: m[2]?.trim() || null };
}

/**
 * Parse a changelog, or a fragment of one: a release's section without its `## ` heading
 * (a GitHub release body, `latest.json`'s notes) counts as one release called `version`.
 * Odd input never throws: what isn't a heading or a bullet is skipped, and text with
 * neither gives no releases.
 */
export function parsePatchNotes(md: string | null | undefined, version = 'Unreleased'): PatchRelease[] {
  const out: PatchRelease[] = [];
  let rel: PatchRelease | null = null;
  let sec: PatchSection | null = null;
  // The entry being read, and whether its last line was a nested bullet (a wrapped line then continues that).
  let entry: { text: string; sub: string[] } | null = null;
  let inSub = false;
  let intro: string[] = [];

  const flush = () => {
    if (entry && sec) sec.entries.push({ id: entryId(entry.text), text: entry.text.trim(), sub: entry.sub.map((s) => s.trim()) });
    entry = null;
    inSub = false;
  };
  const release = (): PatchRelease => {
    if (!rel) {
      rel = { version: normVersion(version), date: null, intro: null, sections: [] };
      out.push(rel);
    }
    return rel;
  };
  const section = (): PatchSection => {
    const r = release();
    if (!sec) {
      sec = { kind: '', entries: [] };
      r.sections.push(sec);
    }
    return sec;
  };
  const endIntro = () => {
    if (rel && intro.length && rel.sections.length === 0 && !rel.intro) rel.intro = intro.join(' ').trim() || null;
    intro = [];
  };

  for (const raw of (md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m: RegExpExecArray | null;
    if ((m = RELEASE.exec(line)) && !line.startsWith('###')) {
      flush();
      endIntro();
      const h = releaseHeading(m[1]);
      rel = { version: h.version, date: h.date, intro: null, sections: [] };
      out.push(rel);
      sec = null;
      continue;
    }
    if ((m = SECTION.exec(line))) {
      flush();
      endIntro();
      const r = release();
      sec = { kind: m[1].trim(), entries: [] };
      r.sections.push(sec);
      continue;
    }
    if (/^#\s/.test(line) || /^\[[^\]]+\]:\s/.test(line)) {
      // The document's title, or a link reference at the bottom.
      flush();
      continue;
    }
    if ((m = BULLET.exec(line))) {
      flush();
      endIntro();
      section();
      entry = { text: m[1], sub: [] };
      continue;
    }
    if (entry && (m = SUB_BULLET.exec(line))) {
      entry.sub.push(m[1]);
      inSub = true;
      continue;
    }
    if (line === '') {
      if (!entry) endIntro();
      continue;
    }
    if (entry && /^\s/.test(line)) {
      // A wrapped line: it continues the nested bullet it follows, else the entry.
      if (inSub) entry.sub[entry.sub.length - 1] += ' ' + line.trim();
      else entry.text += ' ' + line.trim();
      continue;
    }
    // A paragraph: the release's intro when it comes before the first section; else skipped.
    flush();
    if (rel && !sec) intro.push(line.trim());
  }
  flush();
  endIntro();
  return out;
}

/** Whether a release has anything to show. */
export function hasEntries(r: PatchRelease): boolean {
  return r.sections.some((s) => s.entries.length > 0);
}

/** Every entry id, in order. */
export function allEntryIds(releases: PatchRelease[]): string[] {
  const ids: string[] = [];
  for (const r of releases) for (const s of r.sections) for (const e of s.entries) ids.push(e.id);
  return ids;
}

/**
 * The entries this device hasn't seen. `seen` null means it never recorded any: a first
 * install, which has nothing "new" (it starts by recording everything).
 */
export function unseenEntryIds(releases: PatchRelease[], seen: readonly string[] | null): string[] {
  if (seen == null) return [];
  const known = new Set(seen);
  return allEntryIds(releases).filter((id) => !known.has(id));
}

/** The entries in `offered` that `own` doesn't carry: what an update would bring. */
export function entriesNotIn(offered: PatchRelease[], own: PatchRelease[]): string[] {
  const have = new Set(allEntryIds(own));
  return allEntryIds(offered).filter((id) => !have.has(id));
}

/** Keep only the entries whose ids are listed, dropping what's left empty. */
export function onlyEntries(releases: PatchRelease[], ids: readonly string[]): PatchRelease[] {
  const want = new Set(ids);
  return releases
    .map((r) => ({ ...r, intro: null, sections: r.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => want.has(e.id)) })).filter((s) => s.entries.length) }))
    .filter(hasEntries);
}

/** The release this build is: the first one with entries (Unreleased on a build between releases). */
export function currentRelease(releases: PatchRelease[]): PatchRelease | null {
  for (const r of releases) if (hasEntries(r)) return r;
  return null;
}

// ---- Raw sections, for the release workflow and the host's builds -----------

/** Each `## ` section's raw lines, heading included, with its version. */
function rawSections(md: string): { version: string; text: string }[] {
  const out: { version: string; lines: string[] }[] = [];
  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const m = RELEASE.exec(line);
    if (m && !line.startsWith('###')) {
      out.push({ version: releaseHeading(m[1]).version, lines: [line] });
    } else if (out.length && !/^\[[^\]]+\]:\s/.test(line)) {
      out[out.length - 1].lines.push(line);
    }
  }
  return out.map((s) => ({ version: s.version, text: s.lines.join('\n').trim() }));
}

/** A section's body without its `## ` heading. */
function body(text: string): string {
  return text.split('\n').slice(1).join('\n').trim();
}

/**
 * One version's notes as markdown, without the `## ` heading (a GitHub release body, the
 * `notes` of `latest.json`). Null when the changelog has no section for it, or one with no
 * entries.
 */
export function releaseNotes(md: string, version: string): string | null {
  const want = normVersion(version);
  const s = rawSections(md).find((x) => x.version === want);
  if (!s) return null;
  const b = body(s.text);
  return parsePatchNotes(b, want).some(hasEntries) ? b : null;
}

/**
 * A host build's notes: the `## [Unreleased]` section (when it has entries) and the last
 * released version's, headings included, so the device can tell "new since" by entry.
 * '' when there's neither.
 */
export function hostBuildNotes(md: string): string {
  const parts: string[] = [];
  const sections = rawSections(md);
  const unreleased = sections.find((s) => s.version === 'Unreleased');
  if (unreleased && parsePatchNotes(unreleased.text).some(hasEntries)) parts.push(unreleased.text);
  const released = sections.find((s) => s.version !== 'Unreleased' && parsePatchNotes(s.text).some(hasEntries));
  if (released) parts.push(released.text);
  return parts.join('\n\n');
}

/** The last released version in the changelog ("1.0.11"), or null. */
export function lastReleasedVersion(md: string): string | null {
  return rawSections(md).find((s) => s.version !== 'Unreleased')?.version ?? null;
}

// ---- Inline text --------------------------------------------------------------

export type InlinePart = { kind: 'text' | 'bold' | 'code'; text: string };

/**
 * An entry's inline markdown as parts: `**bold**`, `` `code` ``, and links reduced to their
 * label (the notes link to files in the repository, which mean nothing in the app).
 */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const push = (kind: InlinePart['kind'], t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += t;
    else parts.push({ kind, text: t });
  };
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)\s]*\)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    push('text', text.slice(at, m.index));
    if (m[1] != null) {
      // Bold may hold code or a link: keep its text plain.
      push('bold', m[1].replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1'));
    } else if (m[2] != null) push('code', m[2]);
    else push('text', m[3]);
    at = m.index + m[0].length;
  }
  push('text', text.slice(at));
  return parts;
}
