import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import type { Answer, Ask, Question } from "../ports/ask.ts";
import { PRINCIPAL_JUDGE_MODEL, principalJudge, promptOf, SCHEMA, VerdictAnswer } from "./principal-judge.ts";

interface Asked {
  readonly ask: Ask;
  readonly questions: readonly Question[];
}

function asking(answer: Answer): Asked {
  const questions: Question[] = [];

  return {
    ask: (question) => {
      questions.push(question);

      return Promise.resolve(answer);
    },
    questions,
  };
}

describe("VerdictAnswer", () => {
  test("an explicit ok true or false with its reason is a verdict; anything else is none", () => {
    const decode = Schema.decodeUnknownResult(VerdictAnswer);

    expect(decode({ ok: true, reason: "fine" })).toEqual(Result.succeed({ ok: true, reason: "fine" }));
    expect(decode({ ok: false, reason: "bypass" })).toEqual(Result.succeed({ ok: false, reason: "bypass" }));

    for (const structured of [{ ok: false }, { reason: "?" }, { ok: "yes", reason: "?" }, null, "looks fine"]) {
      expect(Result.isFailure(decode(structured))).toBe(true);
    }
  });
});

describe("principalJudge", () => {
  test("asks the Principal judge's model with the schema, and reads its verdict, model and cost", async () => {
    const { ask, questions } = asking({
      kind: "answered",
      structured: { ok: true, reason: "fine" },
      costUsd: 0.2,
      model: "claude-fable-5-1",
    });

    const result = await principalJudge(ask, "/repo", "prompt");

    expect(questions).toEqual([
      { model: PRINCIPAL_JUDGE_MODEL, prompt: "prompt", schema: SCHEMA, cwd: "/repo", timeoutMs: 900_000 },
    ]);
    expect(result).toEqual({
      verdict: { ok: true, reason: "fine" },
      failure: null,
      model: "claude-fable-5-1",
      costUsd: 0.2,
    });
  });

  test("a failed call or an answer outside the schema gives no verdict, with the reason", async () => {
    const failed = asking({ kind: "failed", error: "timed out after 900000 ms", costUsd: null, model: null }).ask;

    const offSchema = asking({
      kind: "answered",
      structured: { verdict: "ok I guess" },
      costUsd: 0.1,
      model: "claude-fable-5-1",
    }).ask;

    expect(await principalJudge(failed, "/repo", "prompt")).toEqual({
      verdict: null,
      failure: "The Principal judge failed: timed out after 900000 ms",
      model: null,
      costUsd: null,
    });
    expect(await principalJudge(offSchema, "/repo", "prompt")).toMatchObject({
      verdict: null,
      failure: 'The Principal judge answered outside the schema: Missing key\n  at ["ok"]',
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
