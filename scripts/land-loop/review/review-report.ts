/**
 * The review job's data: the request the Merge bot dispatches, the report the forked `/code-review`
 * returns through StructuredOutput, and the result the job uploads as its artifact. The artifact's
 * shape is an external format: the Merge bot reads it from another run.
 */

import { Result, Schema } from "effect";

import type { SessionAnswer } from "../ports/review.ts";

export const Severity = Schema.Literals(["important", "nit", "pre_existing"]);

export type Severity = typeof Severity.Type;

const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);

const Round = Schema.Literals([1, 2, 3]);

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));

const ReviewRequestFields = {
  pr: Schema.Int,
  /** The commit the review reads: the PR's head when the Merge bot asked. */
  head: Sha,
  /** Where the reviewed range starts: the merge base on round 1, the last reviewed head after it. */
  base: Sha,
  /** The patch identity the Merge bot keys the review on. */
  patch: Schema.String,
  round: Round,
  model: Schema.String,
  effort: Effort,
};

export const ReviewRequest = Schema.Struct(ReviewRequestFields);

export type ReviewRequest = typeof ReviewRequest.Type;

const IntFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Int));

/** The request as the workflow's inputs carry it: every value a string. */
export const ReviewInputs = Schema.Struct({
  ...ReviewRequestFields,
  pr: IntFromString,
  round: Schema.FiniteFromString.pipe(Schema.decodeTo(Round)),
});

const Location = Schema.Struct({ file: Schema.String, line: Schema.NullOr(Schema.Int) });

const ReportedFinding = Schema.Struct({
  /** The changed line that causes the defect. */
  file: Schema.String,
  line: Schema.NullOr(Schema.Int),
  severity: Severity,
  summary: Schema.String,
  failureScenario: Schema.String,
  /** Where the defect shows, when that is another place; null when it shows on the causing line. */
  breaks: Schema.NullOr(Location),
});

export type ReportedFinding = typeof ReportedFinding.Type;

const ReviewReport = Schema.Struct({ findings: Schema.Array(ReportedFinding) });

type ReviewReport = typeof ReviewReport.Type;

/** The report as the StructuredOutput call carries it, in the snake_case of `OUTPUT_SCHEMA`. */
export const StructuredReport = Schema.Struct({
  findings: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      line: Schema.NullOr(Schema.Int),
      severity: Severity,
      summary: Schema.String,
      failure_scenario: Schema.String,
      breaks: Schema.NullOr(Location),
    }),
  ),
});

const LOCATION_SCHEMA = {
  type: "object",
  properties: { file: { type: "string" }, line: { type: ["integer", "null"] } },
  required: ["file", "line"],
  additionalProperties: false,
};

/** The JSON Schema of `StructuredReport`, passed to `outputFormat`; the CLI checks every StructuredOutput call against it. */
export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          severity: { type: "string", enum: ["important", "nit", "pre_existing"] },
          summary: { type: "string" },
          failure_scenario: { type: "string" },
          breaks: { anyOf: [LOCATION_SCHEMA, { type: "null" }] },
        },
        required: ["file", "line", "severity", "summary", "failure_scenario", "breaks"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

const RunFacts = {
  request: ReviewRequest,
  /** The exact model that ran, null when no result names one. */
  model: Schema.NullOr(Schema.String),
  claudeCodeVersion: Schema.NullOr(Schema.String),
  costUsd: Schema.NullOr(Schema.Finite),
  /** The review job's run, linked from the agent-review summary. */
  runUrl: Schema.String,
};

export const ReviewResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reported"), report: ReviewReport, ...RunFacts }),
  /** `cause` says why in plain words, for the agent-review summary. */
  Schema.Struct({ kind: Schema.Literal("failed"), cause: Schema.String, ...RunFacts }),
]);

export type ReviewResult = typeof ReviewResult.Type;

export type ReportedResult = Extract<ReviewResult, { readonly kind: "reported" }>;

const encodeInputs = Schema.encodeSync(ReviewInputs);

/** The request as the workflow's inputs, every value a string: what the Merge bot dispatches. */
export function inputsOf(request: ReviewRequest): Readonly<Record<string, string>> {
  return encodeInputs(request);
}

const decodeResultJson = Schema.decodeUnknownResult(Schema.fromJsonString(ReviewResult));

/** The result an artifact's `review-result.json` holds; null when it does not read as one. */
export function resultOfJson(json: string): ReviewResult | null {
  return Result.getOrNull(decodeResultJson(json));
}

const decodeStructured = Schema.decodeUnknownResult(StructuredReport);

/** The job's result for `request`, from what the review session gave; a structured answer that does not read fails. */
export function resultOf(request: ReviewRequest, answer: SessionAnswer, runUrl: string): ReviewResult {
  const facts = {
    request,
    model: answer.model,
    claudeCodeVersion: answer.claudeCodeVersion,
    costUsd: answer.costUsd,
    runUrl,
  };

  if (answer.kind === "failed") {
    return { kind: "failed", cause: answer.error, ...facts };
  }

  return Result.match(decodeStructured(answer.structured), {
    onFailure: (issue): ReviewResult => ({
      kind: "failed",
      cause: `the structured answer does not read: ${issue.message}`,
      ...facts,
    }),
    onSuccess: (structured): ReviewResult => ({
      kind: "reported",
      report: {
        findings: structured.findings.map((finding) => ({
          file: finding.file,
          line: finding.line,
          severity: finding.severity,
          summary: finding.summary,
          failureScenario: finding.failure_scenario,
          breaks: finding.breaks,
        })),
      },
      ...facts,
    }),
  });
}

/** One line for the job's log: the request, what ran, and the findings by severity or the cause. */
export function summaryOf(result: ReviewResult): string {
  const { request } = result;
  const head = `review pr=${request.pr} round=${request.round} model=${result.model ?? request.model} effort=${request.effort} claude_code=${result.claudeCodeVersion ?? "unknown"}`;

  if (result.kind === "failed") {
    return `${head} failed: ${result.cause}`;
  }

  const count = (severity: Severity): number =>
    result.report.findings.filter((finding) => finding.severity === severity).length;

  return `${head} reported: ${count("important")} important, ${count("nit")} nit, ${count("pre_existing")} pre_existing`;
}
