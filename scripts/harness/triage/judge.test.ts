import { describe, expect, test } from "bun:test";

import type { Answer, Ask, Question } from "../lib/ask.ts";
import { judge, SCHEMA, TRIAGE_MODEL, triageOf } from "./judge.ts";

const SAFE = { land: "human", review: "deep", secondRound: true };

function asking(answer: Answer): { ask: Ask; questions: Question[] } {
  const questions: Question[] = [];

  return {
    ask: async (question) => {
      questions.push(question);

      return answer;
    },
    questions,
  };
}

describe("triageOf", () => {
  test("the schema's answer reads into a triage", () => {
    expect(triageOf({ land: "auto", review: "light", second_round: false, reason: "small" })).toEqual({
      land: "auto",
      review: "light",
      secondRound: false,
      reason: "small",
    });
  });

  test("an answer outside the schema does not read", () => {
    expect(triageOf({ land: "maybe", review: "light", second_round: false, reason: "" })).toBeNull();
    expect(triageOf(null)).toBeNull();
    expect(triageOf("auto")).toBeNull();
  });
});

describe("judge", () => {
  test("Haiku gets the schema and the change, and its answer is the triage", async () => {
    const { ask, questions } = asking({ kind: "answered", structured: { land: "auto", review: "none", second_round: false, reason: "docs" }, costUsd: 0.003 });
    const triage = await judge(ask, "/repo", "1 file changed", "+docs", false);

    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual(expect.objectContaining({ model: TRIAGE_MODEL, schema: SCHEMA, cwd: "/repo" }));
    expect(questions[0]?.prompt).toContain("+docs");
    expect(triage).toEqual({ land: "auto", review: "none", secondRound: false, reason: "docs" });
  });

  test("a failed call answers the safe side, with the error as its reason", async () => {
    const { ask } = asking({ kind: "failed", error: "error_during_execution: overloaded", costUsd: null });
    const triage = await judge(ask, "/repo", "s", "p", true);

    expect(triage).toEqual(expect.objectContaining(SAFE));
    expect(triage.reason).toBe("the triage failed: error_during_execution: overloaded");
  });

  test("an answer that does not read answers the safe side", async () => {
    const { ask } = asking({ kind: "answered", structured: { land: "soon" }, costUsd: 0.003 });

    expect(await judge(ask, "/repo", "s", "p", false)).toEqual(expect.objectContaining(SAFE));
  });
});
