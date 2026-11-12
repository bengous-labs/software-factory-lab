/**
 * A Judge reads, and writes nothing. Its settings live in an actor file beside it, and the test beside
 * that file pins them: read-only tools alone, never none, and a deadline. Each of its tool calls goes
 * through a guard whose own failure denies the call (`shared/ask.live.test.ts`,
 * `review/review-session.live.test.ts`, `stop/fork-guard.test.ts`). The lint rule `local/judges`
 * (`scripts/lint/judges.ts`) refuses a Judge's settings written anywhere else.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const FACTORY = join(import.meta.dir, "..");

describe("the Judges' settings", () => {
  test("the factory holds three, each in an actor file beside its Judge, with a test beside it", () => {
    const actors = [...new Bun.Glob("**/*.actor.ts").scanSync({ cwd: FACTORY })].toSorted();

    expect(actors).toEqual([
      "land/review/code-review.actor.ts",
      "land/routing/routing-judge.actor.ts",
      "land/stop/done-judge.actor.ts",
    ]);

    for (const actor of actors) {
      const tested = actor.replace(/\.ts$/u, ".test.ts");

      expect({ tested, exists: existsSync(join(FACTORY, tested)) }).toEqual({ tested, exists: true });
    }
  });
});
