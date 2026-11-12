import { describe, expect, test } from "bun:test";

import { CODE_REVIEW } from "./code-review.actor.ts";

describe("the Code review's settings", () => {
  test("a light review runs /code-review medium on Sonnet, a deep one /code-review high on Opus", () => {
    expect(CODE_REVIEW.depths).toEqual({
      light: { model: "sonnet", effort: "medium" },
      deep: { model: "opus", effort: "high" },
    });
  });

  test("its session reads with the read-only tools and the two its native skill runs through, and no other", () => {
    expect(CODE_REVIEW.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Agent", "Skill"]);
  });

  test("one session has twenty minutes: two fit under the job's fifty", () => {
    expect(CODE_REVIEW.timeoutMs).toBe(20 * 60_000);
    expect(2 * CODE_REVIEW.timeoutMs).toBeLessThan(50 * 60_000);
  });
});
