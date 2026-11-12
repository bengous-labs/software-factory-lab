import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import type { Answer, Ask, Question, Reader } from "../shared/ask.port.ts";
import { ROUTING_JUDGE_MODEL, routingJudge, RoutingJudgeAnswer, routingOf, SCHEMA } from "./routing-judge.ts";

const TOKENS = { input: 2, output: 58, cacheRead: 1568, cacheCreation: 6770 };

const SAFE = { land: "auto", review: "deep", secondRound: true };

const READER: Reader = {
  cwd: "/work/pr",
  guard: () => ({ kind: "deny", reason: "none" }),
  env: { PATH: "/usr/bin", HOME: "/home/runner" },
};

const CHECKED_OUT =
  "The change is checked out at its head in your working directory. You may read it with Read, Grep and Glob, and run one read-only git command per Bash call, to judge the change in its context. You change nothing.";

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
    expect(routingOf({ review: "light", second_round: false, reason: "small" }, "claude-haiku-5-5")).toEqual({
      land: "auto",
      review: "light",
      secondRound: false,
      reason: "small",
      model: "claude-haiku-5-5",
    });
  });

  test("an answer outside the schema does not read", () => {
    const refused = [
      { review: "maybe", second_round: false, reason: "" },
      { review: "light", reason: "" },
      { review: "light", second_round: "no", reason: "" },
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
      structured: { review: "none", second_round: false, reason: "docs" },
      tokens: TOKENS,
      model: "claude-haiku-5-5",
    });

    const { routing, tokens } = await routingJudge(ask, READER, "1 file changed", "+docs", false);

    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ model: ROUTING_JUDGE_MODEL, cwd: "/work/pr", env: READER.env });
    expect(questions[0]?.guard).toBe(READER.guard);
    expect(questions[0]?.prompt.split("\n")[1]).toBe(CHECKED_OUT);
    expect(questions[0]?.schema).toEqual(SCHEMA);
    expect(SCHEMA.required).toEqual(["review", "second_round", "reason"]);
    expect(Object.keys(SCHEMA.properties)).not.toContain("land");
    expect(questions[0]?.prompt).toContain("+docs");
    expect(questions[0]?.prompt).toContain("Answer these questions.");
    expect(questions[0]?.prompt).not.toContain("- land:");
    expect(routing).toEqual({
      land: "auto",
      review: "none",
      secondRound: false,
      reason: "docs",
      model: "claude-haiku-5-5",
    });
    expect(tokens).toEqual(TOKENS);
  });

  test("a failed call answers the safe side, with the error as its reason, named after the model that ran", async () => {
    const { ask } = asking({
      kind: "failed",
      error: "error_during_execution: overloaded",
      tokens: TOKENS,
      model: "claude-haiku-5-5",
    });

    const { routing, tokens } = await routingJudge(ask, READER, "s", "p", true);

    expect(routing).toMatchObject({ ...SAFE, model: "claude-haiku-5-5" });
    expect(routing.reason).toBe("the Routing judge failed: error_during_execution: overloaded");
    expect(tokens).toEqual(TOKENS);
  });

  test("a call with no result is named after the model asked, never the Routing rules", async () => {
    const { ask } = asking({ kind: "failed", error: "timed out after 180000 ms", tokens: null, model: null });

    expect(await routingJudge(ask, READER, "s", "p", false)).toMatchObject({
      routing: { ...SAFE, model: ROUTING_JUDGE_MODEL },
      tokens: null,
    });
  });

  test("an answer that does not read answers the safe side", async () => {
    const { ask } = asking({
      kind: "answered",
      structured: { review: "soon", second_round: false, reason: "" },
      tokens: TOKENS,
      model: "claude-haiku-5-5",
    });

    const { routing } = await routingJudge(ask, READER, "s", "p", false);

    expect(routing).toMatchObject(SAFE);
    expect(routing.reason).toBe(
      'the Routing judge failed: its answer does not read: Expected "none" | "light" | "deep"\n  at ["review"]',
    );
  });
});
