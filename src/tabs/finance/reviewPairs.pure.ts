// The bulk actions of the transfer review list: which waiting pairs "all like this" and
// "all at ≥ N%" take. Pure, so scripts/test-finance-review-pairs.mjs can check it.

/** The matcher's bar for pairing without asking (`AUTO_SCORE` in crates/core/src/finance/pairing.rs), in percent. */
export const AUTO_PERCENT = 75;

/** The fields of a pair this needs. */
export interface ReviewPair {
  id: number;
  score: number;
  like_key: string;
}

/** The pairs like `p`: the same kind, the same two accounts and the same description patterns. */
export function pairsLike<T extends ReviewPair>(pairs: T[], p: ReviewPair): T[] {
  return pairs.filter((x) => x.like_key === p.like_key);
}

/** The pairs whose match is at least `percent`, as the list shows it (rounded). */
export function pairsAtLeast<T extends ReviewPair>(pairs: T[], percent: number): T[] {
  if (!Number.isFinite(percent)) return [];
  return pairs.filter((x) => Math.round(x.score * 100) >= percent);
}

/** A percentage typed into the bar's field, kept between 0 and 100; the auto bar when it isn't a number. */
export function clampPercent(text: string): number {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return AUTO_PERCENT;
  return Math.min(100, Math.max(0, n));
}
