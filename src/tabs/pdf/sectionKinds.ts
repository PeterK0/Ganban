// Section kinds for PDF Studio's structure: front matter (cover, contents,
// preface…), chapters and back matter (appendix, bibliography…). Only chapters
// take a number, so a book with a cover and a contents page still starts at
// chapter 1. Pure: no pdf.js, so the numbering is unit-tested
// (scripts/test-pdf-sections.mjs).

export type SectionKind = "front" | "chapter" | "back";

export const SECTION_KINDS: { value: SectionKind; label: string; short: string }[] = [
  { value: "front", label: "Front matter", short: "Front" },
  { value: "chapter", label: "Chapter", short: "Chapter" },
  { value: "back", label: "Back matter", short: "Back" },
];

/** Front matter when the title starts with one of these ("Preface to the Third Edition"). */
const FRONT =
  /^(title page|half[- ]title|copyright|dedication|(table of )?contents\b|preface|foreword|prologue|acknowledge?ments?|about this book|list of (figures|tables|illustrations|abbreviations))/i;
/** Back matter when the title starts with one of these. */
const BACK =
  /^(appendi(x|ces)|annex(es)?\b|bibliography|works cited|further reading|glossary|endnotes|afterword|epilogue|about the authors?|colophon)/i;
/** Words that are a section only as the whole title: "Notes" is back matter,
 * "Notes on Method" a chapter. */
const FRONT_EXACT = /^(cover|front cover|title|imprint|epigraph|abstract|abbreviations|toc)$/i;
const BACK_EXACT = /^(back cover|notes|references|sources)$/i;
/** "Index" means a contents page in many languages (indice, índice, Inhalt):
 * front matter before the first chapter, back matter after it. */
const EITHER = /^(index|indice|índice|indici|inhalt|inhaltsverzeichnis|sommaire|innehåll)( of .*)?$/i;

const ROMAN = "M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})";
/** A leading number: "1 ", "2.", "iv)" or "IV:" (a roman one needs its
 * punctuation, so "Mix" stays a word). */
const LEADING_NUMBER = new RegExp(`^(\\d+(\\.\\d+)*[.):]?\\s+|(?=[MDCLXVI])${ROMAN}[.):]\\s*)`, "i");

/** The title without a leading number and trailing punctuation, so "1 Preface"
 * still reads as a preface and "Notes." as notes. */
function bareTitle(title: string): string {
  return title.trim().replace(LEADING_NUMBER, "").replace(/[\s.:;]+$/, "");
}

/** The kind a title suggests, given whether a chapter has already appeared. */
export function guessSectionKind(title: string, afterChapter: boolean): SectionKind {
  const t = bareTitle(title);
  if (FRONT.test(t) || FRONT_EXACT.test(t)) return "front";
  if (BACK.test(t) || BACK_EXACT.test(t)) return "back";
  if (EITHER.test(t)) return afterChapter ? "back" : "front";
  return "chapter";
}

export interface SectionRow {
  title: string;
  level: number;
  /** The user's choice; absent means guess from the title. */
  kind?: SectionKind;
}

export interface NumberedSection {
  kind: SectionKind;
  /** 1-based chapter number, or 0 for front and back matter. */
  chapterNum: number;
}

/**
 * Resolve each row's kind and chapter number. Kinds apply to top-level rows;
 * a nested row inherits its top-level parent's kind and number, so extracting
 * "1.2" files under chapter 1. Only chapters count.
 */
export function numberSections(rows: SectionRow[]): NumberedSection[] {
  let chapters = 0;
  let current: NumberedSection = { kind: "front", chapterNum: 0 };
  return rows.map((row, i) => {
    if (row.level <= 0 || i === 0) {
      const kind = row.kind ?? guessSectionKind(row.title, chapters > 0);
      current = { kind, chapterNum: kind === "chapter" ? ++chapters : 0 };
    }
    return current;
  });
}
