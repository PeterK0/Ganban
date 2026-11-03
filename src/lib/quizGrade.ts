// Quiz grading — pure, mirrors QuizForge's semantics (src/types/question.ts +
// ExamResultsPage scoring in the QuizForge repo): single-answer types are
// all-or-nothing; multi-part types (blanks, dropdown blanks, matching pairs,
// ordering positions, calculation answers) earn partial credit per part, and
// "correct" means every part. Kept free of React so it can be tested by the
// esbuild + node:assert harness (npm run test:reports).

import type { QuizQuestion, QuizQuestionType } from '../types';

export type Option = { optionText: string; isCorrect: boolean };
/** acceptableAnswers: an array here; QuizForge's own DB kept a comma string —
 * grading accepts both so imported banks score the same. */
export type Blank = { correctAnswer: string; acceptableAnswers?: string[] | string };
export type DropdownBlank = { index?: number; options: string[]; correctAnswer: string };
export type MatchPair = { leftItem: string; rightItem: string };
export type OrderItem = { itemText: string; correctPosition: number };
export type CalcVariable = { name: string; value: number; unit?: string };
export type CalcAnswer = { label: string; correctValue: number; tolerance?: number; unit?: string };

export const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const alternates = (b: Blank): string[] =>
  Array.isArray(b.acceptableAnswers) ? b.acceptableAnswers : String(b.acceptableAnswers ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** The choice types share one widget; IMAGE_IDENTIFICATION is a single choice with a picture. */
export const isChoice = (t: QuizQuestionType) => t === 'SINGLE_CHOICE' || t === 'MULTIPLE_CHOICE' || t === 'IMAGE_IDENTIFICATION';
/** Ordering items in their correct order, whatever order they were stored in. */
export const orderedItems = (items: OrderItem[]) => [...items].sort((a, b) => a.correctPosition - b.correctPosition);

export function parseData(q: Pick<QuizQuestion, 'data_json'>): Record<string, unknown> {
  try {
    return JSON.parse(q.data_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function grade(q: Pick<QuizQuestion, 'question_type' | 'points' | 'data_json'>, response: unknown): { correct: boolean; earned: number } {
  const data = parseData(q);
  const full = { correct: true, earned: q.points };
  const zero = { correct: false, earned: 0 };
  /** QuizForge partial credit: points × right/total, 2 dp; correct = all right. */
  const partial = (right: number, total: number) =>
    total === 0 ? zero : { correct: right === total, earned: Math.round((q.points * right) / total * 100) / 100 };
  const within = (val: number, target: number, tol: number) => !isNaN(val) && Math.abs(val - target) <= tol;

  switch (q.question_type) {
    case 'SINGLE_CHOICE':
    case 'IMAGE_IDENTIFICATION': {
      const opts = (data.options as Option[]) ?? [];
      const pick = response as number | null;
      return pick != null && opts[pick]?.isCorrect ? full : zero;
    }
    case 'MULTIPLE_CHOICE': {
      const opts = (data.options as Option[]) ?? [];
      const picks = new Set((response as number[]) ?? []);
      const ok = opts.every((o, i) => (o.isCorrect ? picks.has(i) : !picks.has(i)));
      return ok ? full : zero;
    }
    case 'FILL_BLANK': {
      const blanks = (data.blanks as Blank[]) ?? [];
      const answers = (response as string[]) ?? [];
      const right = blanks.filter((b, i) => {
        const got = norm(answers[i]);
        return !!got && (got === norm(b.correctAnswer) || alternates(b).some((a) => norm(a) === got));
      }).length;
      return partial(right, blanks.length);
    }
    case 'FILL_BLANK_MULTIPLE': {
      const blanks = (data.blanks as DropdownBlank[]) ?? [];
      const answers = (response as string[]) ?? [];
      const right = blanks.filter((b, i) => norm(answers[i]) !== '' && norm(answers[i]) === norm(b.correctAnswer)).length;
      return partial(right, blanks.length);
    }
    case 'NUMERIC_INPUT': {
      const val = parseFloat(String(response ?? ''));
      const correct = data.correctAnswer as number;
      const tol = (data.tolerance as number) ?? 0;
      const tolType = (data.toleranceType as string) ?? 'ABSOLUTE';
      const margin = tolType === 'PERCENTAGE' ? Math.abs(correct) * (tol / 100) : tol;
      return within(val, correct, margin) ? full : zero;
    }
    case 'MATCHING': {
      // Pairs are stored aligned (left[i] ↔ right[i]); the response maps each
      // left index to the ORIGINAL index of the right item the person chose.
      const pairs = (data.matches as MatchPair[]) ?? [];
      const picks = (response as Record<number, number>) ?? {};
      const right = pairs.filter((_, i) => picks[i] === i).length;
      return partial(right, pairs.length);
    }
    case 'ORDERING': {
      // Response: original indices in the person's order. Credit per position.
      const items = (data.items as OrderItem[]) ?? [];
      const order = (response as number[]) ?? [];
      if (order.length !== items.length) return partial(0, items.length);
      const right = order.filter((orig, pos) => items[orig]?.correctPosition === pos + 1).length;
      return partial(right, items.length);
    }
    case 'CALCULATION': {
      const answers = (data.answers as CalcAnswer[]) ?? [];
      const given = (response as string[]) ?? [];
      const right = answers.filter((a, i) => within(parseFloat(String(given[i] ?? '')), a.correctValue, a.tolerance ?? 0)).length;
      return partial(right, answers.length);
    }
    default:
      return zero;
  }
}
