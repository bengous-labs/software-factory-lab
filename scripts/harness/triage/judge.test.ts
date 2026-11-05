import { describe, expect, test } from "bun:test";

import type { Run } from "../lib/run.ts";
import { judge, TRIAGE_MODEL, triageOf } from "./judge.ts";

const answer = JSON.stringify({
  structured_output: { land: "auto", review: "none", second_round: false, reason: "docs" },
  modelUsage: { "claude-haiku-5-5": { costUSD: 0.001 } },
});

describe("triageOf", () => {
  test("the answer carries the exact model that gave it", () => {
    expect(triageOf(answer)).toEqual({ land: "auto", review: "none", secondRound: false, reason: "docs", model: "claude-haiku-5-5" });
  });

  test("an answer outside the schema does not read", () => {
    expect(triageOf(JSON.stringify({ structured_output: { land: "maybe", review: "none" } }))).toBeNull();
  });
});

describe("judge", () => {
  test("a failed run answers land:human and review:deep, named after the model asked, never the floor", async () => {
    const run: Run = async () => ({ code: 1, stdout: "", stderr: "rate limited" });
    const triage = await judge(run, "/repo", "stat", "diff", false);

    expect(triage.land).toBe("human");
    expect(triage.review).toBe("deep");
    expect(triage.model).toBe(TRIAGE_MODEL);
    expect(triage.reason).toContain("rate limited");
  });
});
