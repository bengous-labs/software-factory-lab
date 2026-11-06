import { describe, expect, test } from "bun:test";

import type { Answer, Ask, Question } from "../lib/ask.ts";
import { codeReview, commentOf, findingsOf, MODEL, NIT_CAP, promptOf, SCHEMA, severityOfBody } from "./code-review.ts";

const out = (findings: object[]): object => ({ findings });

const finding = (severity: string, summary: string): object => ({
  file: "app/src/cli.ts",
  line: 3,
  severity,
  summary,
  failure_scenario: "todo done 0 marks nothing",
});

describe("findingsOf", () => {
  test("the schema's answer reads into findings, Nits capped by REVIEW.md, Important and Pre-existing kept", () => {
    const findings = findingsOf(
      out([finding("important", "a"), ...["1", "2", "3", "4", "5"].map((n) => finding("nit", n)), finding("pre_existing", "p")]),
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
  const asking = (answer: Answer): { ask: Ask; questions: Question[] } => {
    const questions: Question[] = [];

    return {
      ask: async (question) => {
        questions.push(question);

        return answer;
      },
      questions,
    };
  };

  test("the Review depth picks the model, the schema goes with the prompt, and the answer reads into findings", async () => {
    const { ask, questions } = asking({ kind: "answered", structured: out([finding("important", "a")]), costUsd: 0.02, model: "claude-opus-5-5" });
    const result = await codeReview(ask, "/repo", "deep", "the prompt", () => 0);

    expect(questions).toEqual([{ model: MODEL.deep, prompt: "the prompt", schema: SCHEMA, cwd: "/repo", timeoutMs: 900_000 }]);
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

    expect(await codeReview(ask, "/repo", "light", "p", () => 0)).toEqual({ findings: null, costUsd: null, model: null, ms: 0, error: "timed out after 900000 ms" });
  });

  test("an answer that does not read gives no findings, and says so", async () => {
    const { ask } = asking({ kind: "answered", structured: { verdict: "fine" }, costUsd: 0.01, model: "claude-sonnet-5-5" });
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
  test("review round 2 hunts nothing new and carries the author's rejections", () => {
    const prompt = promptOf("guide", "diff", 2, [{ where: "a.ts:1", finding: "x", reply: "intended" }]);

    expect(prompt).toContain("hunt for nothing new");
    expect(prompt).toContain("Author: intended");
    expect(promptOf("guide", "diff", 1, [])).not.toContain("round 2");
  });
});
