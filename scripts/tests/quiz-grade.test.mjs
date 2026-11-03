import assert from 'node:assert/strict';
import { grade, alternates } from '../../.test-build/quizGrade.mjs';

// QuizForge semantics: single-answer types all-or-nothing; multi-part types
// partial credit per part; "correct" = every part right. Points are 2 dp.
let n = 0;
const q = (question_type, data, points = 4) => ({ question_type, points, data_json: JSON.stringify(data) });
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// ---- single choice / image identification
const sc = q('SINGLE_CHOICE', { options: [{ optionText: 'a', isCorrect: false }, { optionText: 'b', isCorrect: true }] });
eq(grade(sc, 1), { correct: true, earned: 4 }, 'right pick');
eq(grade(sc, 0), { correct: false, earned: 0 }, 'wrong pick');
eq(grade(sc, null), { correct: false, earned: 0 }, 'unanswered');
eq(grade({ ...sc, question_type: 'IMAGE_IDENTIFICATION' }, 1), { correct: true, earned: 4 }, 'image id = single choice with a picture');

// ---- multiple choice: exact set
const mc = q('MULTIPLE_CHOICE', { options: [{ optionText: 'a', isCorrect: true }, { optionText: 'b', isCorrect: true }, { optionText: 'c', isCorrect: false }] });
eq(grade(mc, [0, 1]), { correct: true, earned: 4 }, 'exact set');
eq(grade(mc, [0]), { correct: false, earned: 0 }, 'missing one');
eq(grade(mc, [0, 1, 2]), { correct: false, earned: 0 }, 'one too many');

// ---- fill blank: alternates as array OR comma string; partial per blank; case/space-insensitive
const fb = q('FILL_BLANK', { blanks: [{ correctAnswer: 'Margin', acceptableAnswers: ['collateral', 'initial margin'] }, { correctAnswer: 'clearing house', acceptableAnswers: 'CCP, clearer' }] });
eq(grade(fb, ['margin', 'CCP']), { correct: true, earned: 4 }, 'exact + comma-string alternate');
eq(grade(fb, [' Collateral ', 'clearer']), { correct: true, earned: 4 }, 'array alternate, trimmed, case-insensitive');
eq(grade(fb, ['margin', 'broker']), { correct: false, earned: 2 }, 'one of two blanks → half the points, not correct');
eq(grade(fb, ['', '']), { correct: false, earned: 0 }, 'empty');
eq(alternates({ correctAnswer: 'x', acceptableAnswers: 'a, b ,, c' }), ['a', 'b', 'c'], 'comma string parsing drops empties');
eq(alternates({ correctAnswer: 'x' }), [], 'no alternates');

// ---- dropdown blanks
const dd = q('FILL_BLANK_MULTIPLE', { blanks: [{ index: 0, options: ['long', 'short'], correctAnswer: 'long' }, { index: 1, options: ['call', 'put'], correctAnswer: 'put' }] }, 3);
eq(grade(dd, ['long', 'put']), { correct: true, earned: 3 }, 'both dropdowns');
eq(grade(dd, ['long', 'call']), { correct: false, earned: 1.5 }, 'one dropdown');

// ---- numeric: absolute and percentage tolerance
eq(grade(q('NUMERIC_INPUT', { correctAnswer: 100, tolerance: 2 }), '101.5'), { correct: true, earned: 4 }, 'within absolute tolerance');
eq(grade(q('NUMERIC_INPUT', { correctAnswer: 100, tolerance: 2 }), '103'), { correct: false, earned: 0 }, 'outside');
eq(grade(q('NUMERIC_INPUT', { correctAnswer: 200, tolerance: 5, toleranceType: 'PERCENTAGE' }), '209'), { correct: true, earned: 4 }, 'within 5%');
eq(grade(q('NUMERIC_INPUT', { correctAnswer: 1 }), 'abc'), { correct: false, earned: 0 }, 'not a number');

// ---- matching: response maps left index → ORIGINAL right index; partial per pair
const mt = q('MATCHING', { matches: [{ leftItem: 'call', rightItem: 'right to buy' }, { leftItem: 'put', rightItem: 'right to sell' }, { leftItem: 'future', rightItem: 'obligation' }] }, 3);
eq(grade(mt, { 0: 0, 1: 1, 2: 2 }), { correct: true, earned: 3 }, 'all pairs');
eq(grade(mt, { 0: 0, 1: 2, 2: 1 }), { correct: false, earned: 1 }, 'one pair of three');
eq(grade(mt, {}), { correct: false, earned: 0 }, 'nothing matched');

// ---- ordering: response = original indices in the person's order; credit per position
const od = q('ORDERING', { items: [{ itemText: 'B', correctPosition: 2 }, { itemText: 'A', correctPosition: 1 }, { itemText: 'C', correctPosition: 3 }] }, 3);
eq(grade(od, [1, 0, 2]), { correct: true, earned: 3 }, 'A B C');
eq(grade(od, [0, 1, 2]), { correct: false, earned: 1 }, 'B A C — only C in place');
eq(grade(od, [1, 0]), { correct: false, earned: 0 }, 'wrong length is no credit');

// ---- calculation: per answer, absolute tolerance; 2 dp rounding
const calc = q('CALCULATION', { variables: [{ name: 'S', value: 100, unit: '$' }], answers: [{ label: 'PV', correctValue: 95.24, tolerance: 0.05 }, { label: 'r', correctValue: 5, tolerance: 0 }, { label: 'n', correctValue: 1 }] }, 10);
eq(grade(calc, ['95.2', '5', '1']), { correct: true, earned: 10 }, 'all within tolerance');
eq(grade(calc, ['95.2', '4', '']), { correct: false, earned: 3.33 }, 'one of three → 3.33 (2 dp)');

// ---- unknown type never crashes
eq(grade({ question_type: 'WHATEVER', points: 1, data_json: 'not json' }, 'x'), { correct: false, earned: 0 }, 'garbage in, zero out');

console.log(`✓ quiz grading — ${n} assertions`);
