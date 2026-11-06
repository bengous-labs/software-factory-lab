import { describe, expect, test } from "bun:test";

import type { Answer, Ask, Question } from "../lib/ask.ts";
import { AUTHOR_MARK } from "../thread.ts";
import {
  codeReview,
  commentOf,
  findingsOf,
  MODEL,
  NIT_CAP,
  promptOf,
  rejectedOf,
  SCHEMA,
  severityOfBody,
} from "./code-review.ts";
import type { ReviewThread } from "./code-review.ts";

const out = (findings: readonly unknown[]) => ({ findings });

const finding = (severity: string, summary: string) => ({
  file: "app/src/cli.ts",
  line: 3,
  severity,
  summary,
  failure_scenario: "todo done 0 marks nothing",
});

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

describe("findingsOf", () => {
  test("the schema's answer reads into findings, Nits capped by REVIEW.md, Important and Pre-existing kept", () => {
    const findings = findingsOf(
      out([
        finding("important", "a"),
        ...["1", "2", "3", "4", "5"].map((n) => finding("nit", n)),
        finding("pre_existing", "p"),
      ]),
    );

    expect(findings?.filter((found) => found.severity === "nit")).toHaveLength(NIT_CAP);
    expect(findings?.map((found) => found.severity)).toEqual(["important", "pre_existing", "nit", "nit", "nit"]);
  });

  test("an answer without a findings array does not read", () => {
    expect(findingsOf({ result: "looks good" })).toBeNull();
    expect(findingsOf(null)).toBeNull();
    expect(findingsOf("not an object")).toBeNull();
    expect(findingsOf({ findings: [null] })).toBeNull();
  });
});

describe("codeReview", () => {
  test("the Review depth picks the model, the schema goes with the prompt, and the answer reads into findings", async () => {
    const { ask, questions } = asking({
      kind: "answered",
      structured: out([finding("important", "a")]),
      costUsd: 0.02,
      model: "claude-opus-5-5",
    });

    const result = await codeReview(ask, "/repo", "deep", "the prompt", () => 0);

    expect(questions).toEqual([
      { model: MODEL.deep, prompt: "the prompt", schema: SCHEMA, cwd: "/repo", timeoutMs: 900_000 },
    ]);
    expect(result).toEqual({
      findings: [expect.objectContaining({ severity: "important", summary: "a" })],
      costUsd: 0.02,
      model: "claude-opus-5-5",
      ms: 0,
      error: null,
    });
  });

  test("a failed call gives no findings, with its cost, its model and its error", async () => {
    const { ask } = asking({ kind: "failed", error: "timed out after 900000 ms", costUsd: null, model: null });

    expect(await codeReview(ask, "/repo", "light", "p", () => 0)).toEqual({
      findings: null,
      costUsd: null,
      model: null,
      ms: 0,
      error: "timed out after 900000 ms",
    });
  });

  test("an answer that does not read gives no findings, and says so", async () => {
    const { ask } = asking({
      kind: "answered",
      structured: { verdict: "fine" },
      costUsd: 0.01,
      model: "claude-sonnet-5-5",
    });

    const result = await codeReview(ask, "/repo", "light", "p", () => 0);

    expect(result.findings).toBeNull();
    expect(result.error).toBe("the answer does not read");
  });
});

describe("comments", () => {
  test("a posted finding names its severity and carries the marker the Merge bot reads back", () => {
    const body = commentOf({ file: "a.ts", line: 1, severity: "important", summary: "s", failureScenario: "f" });

    expect(body.startsWith("**Important**: s")).toBe(true);
    expect(severityOfBody(body)).toBe("important");
    expect(severityOfBody("a human comment")).toBeNull();
  });
});

describe("promptOf", () => {
  test("review round 2 reads only the patch delta, whatever review round 1 found, and carries the author's rejections", () => {
    const prompt = promptOf("guide", "diff", 2, [{ where: "a.ts:1", finding: "x", reply: "intended" }]);

    expect(prompt).toContain("only the patch delta since review round 1");
    expect(prompt).not.toContain("found an Important");
    expect(prompt).toContain("Author: intended");
    expect(promptOf("guide", "diff", 1, [])).not.toContain("round 2");
  });
});

describe("rejectedOf", () => {
  const APP = "bengous-labs-agents";

  const thread = (
    replies: ReadonlyArray<readonly [string, string]>,
    { isResolved = true, by = APP } = {},
  ): ReviewThread => ({
    isResolved,
    path: "a.ts",
    line: 3,
    comments: {
      nodes: [
        { author: { login: by }, body: "**Important**: off by one\n\nwhy" },
        ...replies.map(([login, body]) => ({ author: { login }, body })),
      ],
    },
  });

  test("a resolved finding counts as rejected only when the Author's reply gives a reason, never when it reports a fix", () => {
    const rows: Array<[string, boolean]> = [
      [`Fixed in c2a404d: every event keys on the PR number.\n\n${AUTHOR_MARK}`, false],
      ["Fixed in #46 (7988824): ask takes the stream as a parameter.", false],
      ["fixed in abc", false],
      ["Rejected: the issue asked for no new test.", true],
      ["Partly rejected, partly fixed in 15b3bee. The single-PR endpoint is already read.", true],
      ["Checked, and partly rejected: no code after the record step reassigns next.", true],
    ];

    for (const [reply, rejected] of rows) {
      expect(rejectedOf(APP, [thread([["bengous", reply]])])).toHaveLength(rejected ? 1 : 0);
    }
  });

  test("the Author's last reply decides, the App's own replies aside", () => {
    expect(
      rejectedOf(APP, [
        thread([
          ["bengous", "Rejected: intended"],
          [APP, "re-checked"],
        ]),
      ]),
    ).toHaveLength(1);
    expect(
      rejectedOf(APP, [
        thread([
          ["bengous", "Fixed in abc: done"],
          [APP, "re-checked"],
        ]),
      ]),
    ).toHaveLength(0);
    expect(
      rejectedOf(APP, [
        thread([
          ["bengous", "Rejected: intended"],
          ["bengous", "Fixed in abc: done after all"],
        ]),
      ]),
    ).toHaveLength(0);
    expect(
      rejectedOf(APP, [
        thread([
          ["bengous", "Fixed in abc: done"],
          ["bengous", "Rejected after all: the old line was right"],
        ]),
      ]),
    ).toHaveLength(1);
  });

  test("an open thread, a thread a human opened and a thread with no reply are never rejections", () => {
    expect(rejectedOf(APP, [thread([["bengous", "Rejected: intended"]], { isResolved: false })])).toEqual([]);
    expect(rejectedOf(APP, [thread([["bengous", "Rejected: intended"]], { by: "bengous" })])).toEqual([]);
    expect(rejectedOf(APP, [thread([])])).toEqual([]);
  });

  test("a rejection carries its place, the finding's first line and the Author's replies", () => {
    expect(
      rejectedOf(APP, [
        thread([
          ["bengous", "Rejected: intended"],
          [APP, "noted"],
        ]),
      ]),
    ).toEqual([{ where: "a.ts:3", finding: "**Important**: off by one", reply: "Rejected: intended" }]);
  });
});
