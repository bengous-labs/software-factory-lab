import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import type { Answer, Ask, Question } from "../ports/ask.ts";
import { ROUTING_JUDGE_MODEL, routingJudge, RoutingJudgeAnswer, routingOf, SCHEMA } from "./routing-judge.ts";

const SAFE = { land: "owner", review: "deep", secondRound: true };

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

describe("routingOf", () => {
  test("the schema's answer reads into a Routing answer that carries the exact model that gave it", () => {
    expect(
      routingOf({ land: "auto", review: "light", second_round: false, reason: "small" }, "claude-haiku-5-5"),
    ).toEqual({
      land: "auto",
      review: "light",
      secondRound: false,
      reason: "small",
      model: "claude-haiku-5-5",
    });
  });

  test("an answer outside the schema does not read", () => {
    const refused = [
      { land: "maybe", review: "light", second_round: false, reason: "" },
      { land: "auto", review: "light", reason: "" },
      { land: "auto", review: "light", second_round: "no", reason: "" },
      null,
      "auto",
    ];

    for (const structured of refused) {
      expect(Result.isFailure(Schema.decodeUnknownResult(RoutingJudgeAnswer)(structured))).toBe(true);
    }
  });
});

describe("routingJudge", () => {
  test("Haiku gets the schema and the change, and its answer is the Routing answer", async () => {
    const { ask, questions } = asking({
      kind: "answered",
      structured: { land: "auto", review: "none", second_round: false, reason: "docs" },
      costUsd: 0.003,
      model: "claude-haiku-5-5",
    });

    const routing = await routingJudge(ask, "/repo", "1 file changed", "+docs", false);

    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ model: ROUTING_JUDGE_MODEL, cwd: "/repo" });
    expect(questions[0]?.schema).toEqual(SCHEMA);
    expect(questions[0]?.prompt).toContain("+docs");
    expect(routing).toEqual({
      land: "auto",
      review: "none",
      secondRound: false,
      reason: "docs",
      model: "claude-haiku-5-5",
    });
  });

  test("a failed call answers the safe side, with the error as its reason, named after the model that ran", async () => {
    const { ask } = asking({
      kind: "failed",
      error: "error_during_execution: overloaded",
      costUsd: 0.001,
      model: "claude-haiku-5-5",
    });

    const routing = await routingJudge(ask, "/repo", "s", "p", true);

    expect(routing).toMatchObject({ ...SAFE, model: "claude-haiku-5-5" });
    expect(routing.reason).toBe("the Routing judge failed: error_during_execution: overloaded");
  });

  test("a call with no result is named after the model asked, never the Routing rules", async () => {
    const { ask } = asking({ kind: "failed", error: "timed out after 180000 ms", costUsd: null, model: null });

    expect(await routingJudge(ask, "/repo", "s", "p", false)).toMatchObject({ ...SAFE, model: ROUTING_JUDGE_MODEL });
  });

  test("an answer that does not read answers the safe side", async () => {
    const { ask } = asking({
      kind: "answered",
      structured: { land: "soon" },
      costUsd: 0.003,
      model: "claude-haiku-5-5",
    });

    const routing = await routingJudge(ask, "/repo", "s", "p", false);

    expect(routing).toMatchObject(SAFE);
    expect(routing.reason).toBe(
      'the Routing judge failed: its answer does not read: Expected "auto" | "owner"\n  at ["land"]',
    );
  });
});
