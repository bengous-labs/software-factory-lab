import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import type { SessionAnswer } from "../ports/review.ts";
import { OUTPUT_SCHEMA, resultOf, ReviewInputs, ReviewResult, StructuredReport, summaryOf } from "./review-report.ts";
import type { ReviewRequest } from "./review-report.ts";

const HEAD = "e1249fc0000000000000000000000000000000aa";

const BASE = "6cf2698000000000000000000000000000000bbb";

const REQUEST: ReviewRequest = {
  pr: 80,
  head: HEAD,
  base: BASE,
  patch: "p1",
  round: 1,
  model: "sonnet",
  effort: "medium",
};

const RUN_URL = "https://github.com/o/r/actions/runs/1";

const FACTS = { model: "claude-sonnet-5-5", claudeCodeVersion: "2.1.318", costUsd: 0.03 };

const answered = (structured: Schema.Json): SessionAnswer => ({ kind: "answered", structured, ...FACTS });

const FINDING = {
  file: "app/src/task.ts",
  line: 22,
  severity: "important",
  summary: "rename accepts a blank title",
  failure_scenario: "rename 1 ' ' saves an empty title",
  breaks: { file: "app/src/commands/rename.ts", line: 5 },
};

describe("ReviewInputs", () => {
  test("the workflow's string inputs decode into a request", () => {
    const inputs = { pr: "80", head: HEAD, base: BASE, patch: "p1", round: "1", model: "sonnet", effort: "medium" };

    expect(Schema.decodeUnknownSync(ReviewInputs)(inputs)).toEqual(REQUEST);
  });

  test("a round outside 1 and 2, a number that is not one, a head that is not a SHA or an unknown effort is refused", () => {
    const inputs = { pr: "80", head: HEAD, base: BASE, patch: "p1", round: "1", model: "sonnet", effort: "medium" };

    for (const wrong of [
      { round: "3" },
      { pr: "eighty" },
      { pr: "8.5" },
      { head: "HEAD" },
      { base: "main" },
      { effort: "huge" },
    ]) {
      expect([wrong, Result.isFailure(Schema.decodeUnknownResult(ReviewInputs)({ ...inputs, ...wrong }))]).toEqual([
        wrong,
        true,
      ]);
    }
  });
});

describe("OUTPUT_SCHEMA", () => {
  test("it names the fields StructuredReport decodes, all required, and the same severities", () => {
    const items = OUTPUT_SCHEMA.properties.findings.items;

    expect(Object.keys(items.properties).toSorted()).toEqual(Object.keys(FINDING).toSorted());
    expect(items.required.toSorted()).toEqual(Object.keys(FINDING).toSorted());
    expect(items.properties.severity.enum).toEqual(["important", "nit", "pre_existing"]);
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(StructuredReport)({ findings: [FINDING, { ...FINDING, breaks: null }] }),
      ),
    ).toBe(true);
  });
});

describe("resultOf", () => {
  test("a structured answer that reads is reported, in the domain's names", () => {
    expect(resultOf(REQUEST, answered({ findings: [FINDING] }), RUN_URL)).toEqual({
      kind: "reported",
      report: {
        findings: [
          {
            file: "app/src/task.ts",
            line: 22,
            severity: "important",
            summary: "rename accepts a blank title",
            failureScenario: "rename 1 ' ' saves an empty title",
            breaks: { file: "app/src/commands/rename.ts", line: 5 },
          },
        ],
      },
      request: REQUEST,
      runUrl: RUN_URL,
      ...FACTS,
    });
  });

  test("a failed session fails with its error, and keeps what it knows of the run", () => {
    const failed: SessionAnswer = { kind: "failed", error: "timed out after 5000 ms", ...FACTS };

    expect(resultOf(REQUEST, failed, RUN_URL)).toEqual({
      kind: "failed",
      cause: "timed out after 5000 ms",
      request: REQUEST,
      runUrl: RUN_URL,
      ...FACTS,
    });
  });

  test("a structured answer that does not read fails, never as zero findings", () => {
    const { breaks: _, ...withoutBreaks } = FINDING;
    const result = resultOf(REQUEST, answered({ findings: [withoutBreaks] }), RUN_URL);

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.cause : "").toStartWith("the structured answer does not read: ");
  });

  test("the artifact's JSON reads back as the same result", () => {
    const reported = resultOf(REQUEST, answered({ findings: [FINDING] }), RUN_URL);

    const failed = resultOf(
      REQUEST,
      { kind: "failed", error: "e", model: null, claudeCodeVersion: null, costUsd: null },
      RUN_URL,
    );

    for (const result of [reported, failed]) {
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ReviewResult))(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("summaryOf", () => {
  test("one line with the request, what ran, and the count by severity or the cause", () => {
    const nit = { ...FINDING, severity: "nit" };

    expect(summaryOf(resultOf(REQUEST, answered({ findings: [FINDING, nit, nit] }), RUN_URL))).toBe(
      "review pr=80 round=1 model=claude-sonnet-5-5 effort=medium claude_code=2.1.318 reported: 1 important, 2 nit, 0 pre_existing",
    );
    expect(
      summaryOf(
        resultOf(
          REQUEST,
          { kind: "failed", error: "boom", model: null, claudeCodeVersion: null, costUsd: null },
          RUN_URL,
        ),
      ),
    ).toBe("review pr=80 round=1 model=sonnet effort=medium claude_code=unknown failed: boom");
  });
});
