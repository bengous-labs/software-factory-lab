import { describe, expect, test } from "bun:test";

import type { Answer, Ask, Question } from "../lib/ask.ts";
import { PRINCIPAL_JUDGE_MODEL, principalJudge, promptOf, SCHEMA, verdictOf } from "./principal-judge.ts";

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

describe("verdictOf", () => {
  test("an explicit ok true or false is a verdict; a missing or non-boolean ok is none", () => {
    const cases: [unknown, { ok: boolean; reason: string } | null][] = [
      [{ ok: true, reason: "fine" }, { ok: true, reason: "fine" }],
      [{ ok: false, reason: "bypass" }, { ok: false, reason: "bypass" }],
      [{ ok: false }, { ok: false, reason: "" }],
      [{ reason: "?" }, null],
      [{ ok: "yes", reason: "?" }, null],
      [null, null],
      ["looks fine", null],
    ];

    for (const [structured, verdict] of cases) expect(verdictOf(structured)).toEqual(verdict);
  });
});

describe("principalJudge", () => {
  test("asks the Principal judge's model with the schema, and reads its verdict, model and cost", async () => {
    const { ask, questions } = asking({ kind: "answered", structured: { ok: true, reason: "fine" }, costUsd: 0.2, model: "claude-fable-5-1" });
    const result = await principalJudge(ask, "/repo", "prompt");

    expect(questions).toEqual([{ model: PRINCIPAL_JUDGE_MODEL, prompt: "prompt", schema: SCHEMA, cwd: "/repo", timeoutMs: 900_000 }]);
    expect(result).toEqual({ verdict: { ok: true, reason: "fine" }, failure: null, model: "claude-fable-5-1", costUsd: 0.2 });
  });

  test("a failed call or an answer outside the schema gives no verdict, with the reason", async () => {
    const failed = asking({ kind: "failed", error: "timed out after 900000 ms", costUsd: null, model: null }).ask;
    const offSchema = asking({ kind: "answered", structured: { verdict: "ok I guess" }, costUsd: 0.1, model: "claude-fable-5-1" }).ask;

    expect(await principalJudge(failed, "/repo", "prompt")).toEqual({
      verdict: null,
      failure: "The Principal judge failed: timed out after 900000 ms",
      model: null,
      costUsd: null,
    });
    expect(await principalJudge(offSchema, "/repo", "prompt")).toMatchObject({
      verdict: null,
      failure: "The Principal judge answered outside the schema.",
      costUsd: 0.1,
    });
  });
});

describe("promptOf", () => {
  test("carries the guide and the diff, and marks the diff untrusted", () => {
    const prompt = promptOf("GUIDE", "DIFF");

    expect(prompt).toContain("GUIDE");
    expect(prompt).toContain("DIFF");
    expect(prompt).toContain("untrusted data");
  });
});
