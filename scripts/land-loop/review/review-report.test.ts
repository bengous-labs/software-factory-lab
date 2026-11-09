import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import type { SessionAnswer } from "../ports/review.ts";
import {
  inputsOf,
  mergedResultOf,
  OUTPUT_SCHEMA,
  resultOf,
  resultOfJson,
  ReviewInputs,
  ReviewResult,
  StructuredReport,
  summaryOf,
} from "./review-report.ts";
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
  security: false,
};

const RUN_URL = "https://github.com/o/r/actions/runs/1";

const FACTS = {
  model: "claude-sonnet-5-5",
  claudeCodeVersion: "2.1.318",
  tokens: { input: 41_022, output: 3310, cacheRead: 812_400, cacheCreation: 60_211 },
};

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
    const inputs = {
      pr: "80",
      head: HEAD,
      base: BASE,
      patch: "p1",
      round: "1",
      model: "sonnet",
      effort: "medium",
      security: "false",
    };

    expect(Schema.decodeUnknownSync(ReviewInputs)(inputs)).toEqual(REQUEST);
    expect(Schema.decodeUnknownSync(ReviewInputs)({ ...inputs, security: "true" })).toEqual({
      ...REQUEST,
      security: true,
    });

    for (const round of [2, 3] as const) {
      expect(Schema.decodeUnknownSync(ReviewInputs)({ ...inputs, round: String(round) })).toEqual({
        ...REQUEST,
        round,
      });
    }
  });

  test("a round outside 1 to 3, a number that is not one, a head that is not a SHA, an unknown effort or a security flag that is not true or false is refused", () => {
    const inputs = {
      pr: "80",
      head: HEAD,
      base: BASE,
      patch: "p1",
      round: "1",
      model: "sonnet",
      effort: "medium",
      security: "true",
    };

    for (const wrong of [
      { round: "0" },
      { round: "4" },
      { pr: "eighty" },
      { pr: "8.5" },
      { head: "HEAD" },
      { base: "main" },
      { effort: "huge" },
      { security: "yes" },
      { security: "" },
      { security: undefined },
    ]) {
      expect([wrong, Result.isFailure(Schema.decodeUnknownResult(ReviewInputs)({ ...inputs, ...wrong }))]).toEqual([
        wrong,
        true,
      ]);
    }
  });
});

describe("inputsOf", () => {
  test("the request goes out as the workflow's string inputs, which read back as the same request", () => {
    const inputs = inputsOf({ ...REQUEST, round: 2, security: true });

    expect(inputs).toEqual({
      pr: "80",
      head: HEAD,
      base: BASE,
      patch: "p1",
      round: "2",
      model: "sonnet",
      effort: "medium",
      security: "true",
    });
    expect(Schema.decodeUnknownSync(ReviewInputs)(inputs)).toEqual({ ...REQUEST, round: 2, security: true });
    expect(inputsOf(REQUEST).security).toBe("false");
  });

  test("a head that is not a SHA is refused before it is dispatched", () => {
    expect(() => inputsOf({ ...REQUEST, head: "HEAD" })).toThrow('["head"]');
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
            pass: "code",
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
      { kind: "failed", error: "e", model: null, claudeCodeVersion: null, tokens: null },
      RUN_URL,
    );

    for (const result of [reported, failed]) {
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(ReviewResult))(JSON.stringify(result))).toEqual(result);
      expect(resultOfJson(JSON.stringify(result))).toEqual(result);
    }
  });

  test("an artifact written before the token counts, with costUsd and no tokens, reads with no counts and drops costUsd", () => {
    const { tokens: _, ...current } = resultOf(REQUEST, answered({ findings: [FINDING] }), RUN_URL);

    expect(resultOfJson(JSON.stringify({ ...current, costUsd: 0.03 }))).toEqual({ ...current, tokens: null });
    expect(resultOfJson(JSON.stringify({ ...current, costUsd: null }))).toEqual({ ...current, tokens: null });
  });

  test("an artifact written before the security pass, with no request.security and no pass, reads as a Code review", () => {
    const current = resultOf(REQUEST, answered({ findings: [FINDING] }), RUN_URL);
    const { security: _security, ...request } = current.request;
    const findings = current.kind === "reported" ? current.report.findings.map(({ pass: _pass, ...rest }) => rest) : [];

    expect(resultOfJson(JSON.stringify({ ...current, request, report: { findings } }))).toEqual(current);
  });

  test("an artifact that is not JSON, or not a result, reads as none", () => {
    expect(resultOfJson("{")).toBeNull();
    expect(resultOfJson(JSON.stringify({ kind: "reported", report: { findings: [] } }))).toBeNull();
  });
});

describe("mergedResultOf", () => {
  const SECURED: ReviewRequest = { ...REQUEST, security: true };

  const LEAK = { ...FINDING, severity: "nit", summary: "the token reaches the log" };

  const SECURITY_FACTS = { ...FACTS, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } };

  const securityAnswered = (structured: Schema.Json): SessionAnswer => ({
    kind: "answered",
    structured,
    ...SECURITY_FACTS,
  });

  test("two answered sessions report the Code review's findings, then the security pass's, each with its pass, and the tokens of both", () => {
    const result = mergedResultOf(
      SECURED,
      answered({ findings: [FINDING] }),
      securityAnswered({ findings: [LEAK, FINDING] }),
      RUN_URL,
    );

    expect(result).toMatchObject({
      kind: "reported",
      request: SECURED,
      model: FACTS.model,
      tokens: { input: 41_023, output: 3312, cacheRead: 812_403, cacheCreation: 60_215 },
    });
    expect(
      result.kind === "reported" ? result.report.findings.map((finding) => [finding.summary, finding.pass]) : [],
    ).toEqual([
      ["rename accepts a blank title", "code"],
      ["the token reaches the log", "security"],
      ["rename accepts a blank title", "security"],
    ]);
  });

  test("a failed security session fails the result, its cause prefixed, even when the Code review answered", () => {
    for (const security of [
      { kind: "failed", error: "timed out after 5000 ms", ...SECURITY_FACTS } as const,
      securityAnswered({ findings: [{ ...FINDING, severity: "fatal" }] }),
    ]) {
      const result = mergedResultOf(SECURED, answered({ findings: [FINDING] }), security, RUN_URL);

      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" ? result.cause : "").toStartWith("security pass: ");
      expect(result.tokens).toEqual({ input: 41_023, output: 3312, cacheRead: 812_403, cacheCreation: 60_215 });
    }

    const result = mergedResultOf(
      SECURED,
      answered({ findings: [] }),
      { kind: "failed", error: "boom", ...SECURITY_FACTS },
      RUN_URL,
    );

    expect(result).toEqual({
      kind: "failed",
      cause: "security pass: boom",
      request: SECURED,
      runUrl: RUN_URL,
      ...FACTS,
      tokens: { input: 41_023, output: 3312, cacheRead: 812_403, cacheCreation: 60_215 },
    });
  });

  test("a failed Code review fails with its own cause", () => {
    const result = mergedResultOf(
      SECURED,
      { kind: "failed", error: "boom", ...FACTS },
      { kind: "failed", error: "other", ...SECURITY_FACTS },
      RUN_URL,
    );

    expect(result).toMatchObject({ kind: "failed", cause: "boom" });
  });

  test("a session with no counts adds none", () => {
    const result = mergedResultOf(
      SECURED,
      { kind: "answered", structured: { findings: [] }, ...FACTS, tokens: null },
      securityAnswered({ findings: [] }),
      RUN_URL,
    );

    expect(result.tokens).toEqual(SECURITY_FACTS.tokens);
    expect(
      mergedResultOf(
        SECURED,
        { kind: "answered", structured: { findings: [] }, ...FACTS, tokens: null },
        { kind: "answered", structured: { findings: [] }, ...FACTS, tokens: null },
        RUN_URL,
      ).tokens,
    ).toBeNull();
  });

  test("with no security pass, the result is the Code review's alone", () => {
    const code = answered({ findings: [FINDING] });

    expect(mergedResultOf(REQUEST, code, null, RUN_URL)).toEqual(resultOf(REQUEST, code, RUN_URL));
  });
});

describe("summaryOf", () => {
  test("one line with the request, what ran, and the count by severity or the cause", () => {
    const nit = { ...FINDING, severity: "nit" };

    expect(summaryOf(resultOf(REQUEST, answered({ findings: [FINDING, nit, nit] }), RUN_URL))).toBe(
      "review pr=80 round=1 model=claude-sonnet-5-5 effort=medium claude_code=2.1.318 reported: 1 important, 2 nit, 0 pre_existing tokens in=41022 out=3310 cache_read=812400 cache_write=60211",
    );
    expect(
      summaryOf(
        resultOf(
          REQUEST,
          { kind: "failed", error: "boom", model: null, claudeCodeVersion: null, tokens: null },
          RUN_URL,
        ),
      ),
    ).toBe("review pr=80 round=1 model=sonnet effort=medium claude_code=unknown failed: boom tokens none");
  });
});
