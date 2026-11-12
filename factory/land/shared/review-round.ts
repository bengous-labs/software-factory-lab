/** The reads of a change the review job numbers: Review rounds 1 to 3, and the Delta read. */

import { Schema } from "effect";

import { DELTA_READ } from "../../contract.ts";

/** Review rounds 1 to 3, and the Delta read: the review job's request reads the same numbers. */
export const Round = Schema.Literals([1, 2, 3, DELTA_READ]);

export type ReviewRound = typeof Round.Type;

/** What a review calls itself where a human reads it: its Review round, or the Delta read. */
export const reviewNameOf = (round: ReviewRound): string =>
  round === DELTA_READ ? "Delta read" : `Review round ${round}`;

/** What a review's summary line and the ledger call it, shorter: `Round 2`, or the Delta read. */
export const roundNameOf = (round: number): string => (round === DELTA_READ ? "Delta read" : `Round ${round}`);
