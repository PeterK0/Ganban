#!/usr/bin/env node
// Unit test for PDF Studio's section kinds and chapter numbering
// (src/tabs/pdf/sectionKinds.ts).  node scripts/test-pdf-sections.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'pdfsec-')), 'sec.mjs');
execSync(`npx esbuild src/tabs/pdf/sectionKinds.ts --format=esm --outfile=${out}`, { cwd: root, stdio: 'inherit' });
const { numberSections, guessSectionKind } = await import(out);

let pass = 0, fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.log('FAIL:', m)));
const row = (title, level = 0, kind) => ({ title, level, kind });
const nums = (rows) => numberSections(rows).map((n) => `${n.kind[0]}${n.chapterNum}`).join(' ');

// The reported bug: a cover and an index before chapter 1.
ok(nums([row('Cover'), row('Index'), row('Introduction'), row('The second one')]) === 'f0 f0 c1 c2',
  `cover + index → chapter 1, got ${nums([row('Cover'), row('Index'), row('Introduction'), row('The second one')])}`);

// Front matter of every common sort, then back matter.
const book = [row('Title page'), row('Table of Contents'), row('Preface to the Third Edition'), row('Acknowledgements'),
  row('Chapter 1 Sea Transport'), row('Chapter 2 Ships'), row('Appendix A'), row('Bibliography'), row('Index')];
ok(nums(book) === 'f0 f0 f0 f0 c1 c2 b0 b0 b0', `full book, got ${nums(book)}`);

// Nested rows inherit their top-level parent's kind and number.
const nested = [row('Contents'), row('1 Getting started'), row('1.1 Install', 1), row('1.2 Run', 1),
  row('2 Advanced'), row('2.1 Tuning', 1)];
ok(nums(nested) === 'f0 c1 c1 c1 c2 c2', `nested, got ${nums(nested)}`);

// The user's choice wins over the guess, both ways.
ok(nums([row('Cover', 0, 'chapter'), row('Intro', 0, 'front'), row('Body')]) === 'c1 f0 c2',
  `overrides, got ${nums([row('Cover', 0, 'chapter'), row('Intro', 0, 'front'), row('Body')])}`);

// "Index" depends on position; numbered prefixes don't hide a preface.
ok(guessSectionKind('Index', false) === 'front', 'index before chapters is front');
ok(guessSectionKind('Index', true) === 'back', 'index after chapters is back');
ok(guessSectionKind('Indice', false) === 'front', 'Italian indice is front');
ok(guessSectionKind('i. Preface', false) === 'front', 'roman-numbered preface is front');
ok(guessSectionKind('Indexing strategies', false) === 'chapter', 'a title that starts with "Index" as a word is a chapter');
ok(guessSectionKind('Covering the basics', false) === 'chapter', '"Covering" is not a cover');

// Words that are a section only as the whole title, and leading numbers.
ok(guessSectionKind('Abstract Algebra', false) === 'chapter', '"Abstract Algebra" is a chapter');
ok(guessSectionKind('Notes on Method', true) === 'chapter', '"Notes on Method" is a chapter');
ok(guessSectionKind('Notes', true) === 'back', '"Notes" alone is back matter');
ok(guessSectionKind('References.', true) === 'back', 'trailing punctuation is ignored');
ok(guessSectionKind('Civil Notes', true) === 'chapter', '"Civil" is not a roman numeral');
ok(guessSectionKind('IV. Appendix', true) === 'back', 'a roman-numbered appendix is back matter');
ok(guessSectionKind('1.2 Preface', false) === 'front', 'a dotted number is stripped');
ok(guessSectionKind('Index of Names', true) === 'back', '"Index of Names" after chapters is back matter');

// Empty list, and a first row that is nested (the editor clamps it to level 0).
ok(numberSections([]).length === 0, 'empty');
ok(nums([row('Body', 1)]) === 'c1', `first nested row still starts a section, got ${nums([row('Body', 1)])}`);

console.log(`pdf sections: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
