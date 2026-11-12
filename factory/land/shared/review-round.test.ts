import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { DELTA_READ } from "../../contract.ts";
import { reviewNameOf, Round, roundNameOf } from "./review-round.ts";

describe("the reads the review job numbers", () => {
  test("a number is a Review round 1 to 3 or the Delta read, nothing else", () => {
    const isRound = Schema.is(Round);

    expect([1, 2, 3, DELTA_READ].map((round) => isRound(round))).toEqual([true, true, true, true]);
    expect([0, 5, "1", null].map((round) => isRound(round))).toEqual([false, false, false, false]);
  });

  test("a read is named by its round where a human reads it, and the Delta read by its own name", () => {
    expect([reviewNameOf(1), reviewNameOf(3), reviewNameOf(DELTA_READ)]).toEqual([
      "Review round 1",
      "Review round 3",
      "Delta read",
    ]);
    expect([roundNameOf(2), roundNameOf(DELTA_READ)]).toEqual(["Round 2", "Delta read"]);
  });
});
