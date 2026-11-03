#!/usr/bin/env node
// Checks that the repo's doc references resolve (npm run test:doclinks).
//
//  1. Markdown links in tracked *.md files: [text](target) and [ref]: target. Relative targets resolve from the file's
//     folder; web links, mailto and same-page anchors are skipped, and so are fenced code blocks.
//  2. Repo paths to docs, `docs/…` (in Markdown, code comments, scripts and ops), resolve from the repo root. A path
//     that's part of a longer one (`~/Dev/other/docs/HANDOFF.md`, `https://…/docs/…`) is someone else's and skipped.
//
// Exits 1 and lists every broken reference as file:line.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

// Text files whose `docs/…` paths are checked. Test fixtures name made-up `docs/…` files, so tests are skipped.
const TEXT = /\.(md|mjs|js|cjs|ts|tsx|rs|sh|css|html|toml|json|kt|py|yml|yaml)$/;
const SKIP = [/^crates\/[^/]+\/tests\//, /^package-lock\.json$/, /^TASK\.md$/, /^REPORT\.md$/];

const broken = [];
const exists = (p) => existsSync(p);

for (const file of tracked) {
  if (!TEXT.test(file) || SKIP.some((re) => re.test(file))) continue;
  const abs = join(root, file);
  if (!existsSync(abs)) continue; // deleted in the working tree
  const lines = readFileSync(abs, "utf8").split("\n");
  const isMd = file.endsWith(".md");
  let fenced = false;

  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    if (isMd && /^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;

    if (isMd) {
      const targets = [];
      for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]);
      const ref = line.match(/^\s*\[[^\]]+\]:\s*(\S+)/);
      if (ref) targets.push(ref[1]);
      for (const t of targets) {
        if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t)) continue; // web, mailto, anchors
        const path = decodeURIComponent(t.split("#")[0].split("?")[0]);
        if (!path) continue;
        const target = path.startsWith("/") ? join(root, path) : resolve(dirname(abs), path);
        if (!exists(target)) broken.push(`${where}  link ${t}`);
      }
    }

    for (const m of line.matchAll(/(?<![\w~./@:-])docs\/[\w./-]*[\w/]/g)) {
      let path = m[0].replace(/\.$/, "");
      // A glob (`docs/design/mockups/oracle_*.html`): its folder has to exist.
      if (line[m.index + m[0].length] === "*") path = dirname(path);
      if (!exists(join(root, path))) broken.push(`${where}  path ${path}`);
    }
  });
}

if (broken.length) {
  console.error(`check-doc-links: ${broken.length} broken reference(s)\n`);
  for (const b of broken) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`check-doc-links: ok (${relative(process.cwd(), root) || "."})`);
