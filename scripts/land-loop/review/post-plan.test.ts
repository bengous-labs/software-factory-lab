import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { markerOf } from "./findings.ts";
import { diffLinesOf, postPlanOf, reviewMarkerOf, reviewOf } from "./post-plan.ts";
import type { DiffLines } from "./post-plan.ts";
import type { ReportedFinding, ReportedResult } from "./review-report.ts";

/** A `git diff` of four files: a change, a new file whose path holds a space, a deleted file, a one-line change. */
const DIFF = [
  "diff --git a/app/a.ts b/app/a.ts",
  "index 1111111..2222222 100644",
  "--- a/app/a.ts",
  "+++ b/app/a.ts",
  "@@ -120,4 +120,5 @@ function x() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+++ b/added-line.ts",
  " const c = 4;",
  ' const d = " @@ -1 +5 @@ ";',
  "diff --git a/new file.ts b/new file.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/new file.ts\t",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  String.raw`\ No newline at end of file`,
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "--- y",
  "diff --git a/b.ts b/b.ts",
  "index 5555555..6666666 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const LINES: DiffLines = new Map([
  ["app/a.ts", new Set([120, 121, 122, 123, 124])],
  ["new file.ts", new Set([1, 2])],
  ["b.ts", new Set([1])],
]);

describe("diffLinesOf", () => {
  test("reads the new side's added and context lines of each hunk, never a removed line nor a deleted file", () => {
    const lines = diffLinesOf(DIFF);

    expect(lines).toEqual(LINES);
    expect([...lines.keys()]).toEqual(["app/a.ts", "new file.ts", "b.ts"]);
  });

  test("a unified diff without git's header line reads too, and an empty diff shows no line", () => {
    expect(diffLinesOf(["--- a/x.ts", "+++ b/x.ts", "@@ -3,2 +3,2 @@", " a", "+b"].join("\n"))).toEqual(
      new Map([["x.ts", new Set([3, 4])]]),
    );
    expect(diffLinesOf("")).toEqual(new Map());
  });
});

const finding = (severity: ReportedFinding["severity"], file: string, line: number | null): ReportedFinding => ({
  file,
  line,
  severity,
  summary: `${severity} at ${file}`,
  failureScenario: "the scenario",
  breaks: null,
});

describe("postPlanOf", () => {
  test("a finding on a line the diff shows anchors there", () => {
    expect(postPlanOf([finding("important", "app/a.ts", 122)], LINES).comments[0]?.anchor).toEqual({
      file: "app/a.ts",
      line: 122,
    });
  });

  test("a finding on a line the diff does not show anchors on its file's first line, else on the diff's first line", () => {
    const anchors = postPlanOf(
      [
        finding("important", "app/a.ts", 7),
        finding("important", "app/a.ts", null),
        finding("important", "app/other.ts", 4),
      ],
      LINES,
    ).comments.map((planned) => planned.anchor);

    expect(anchors).toEqual([
      { file: "app/a.ts", line: 120 },
      { file: "app/a.ts", line: 120 },
      { file: "app/a.ts", line: 120 },
    ]);
  });

  test("a diff that shows no line leaves a finding nothing to anchor on, and the plan fails", () => {
    expect(() => postPlanOf([finding("nit", "gone.ts", 1)], new Map())).toThrow(
      "the finding on gone.ts has no line of the diff to anchor on",
    );
  });

  test("every Important is posted, the first three Nits are, and a Pre-existing finding is only counted", () => {
    const plan = postPlanOf(
      [
        finding("nit", "b.ts", 1),
        finding("pre_existing", "b.ts", 1),
        finding("nit", "app/a.ts", 121),
        finding("important", "b.ts", 1),
        finding("nit", "app/a.ts", 123),
        finding("nit", "app/a.ts", 124),
        finding("important", "app/a.ts", 120),
        finding("pre_existing", "app/a.ts", 120),
      ],
      LINES,
    );

    expect(plan.comments.map((planned) => [planned.severity, planned.anchor.file, planned.anchor.line])).toEqual([
      ["important", "b.ts", 1],
      ["important", "app/a.ts", 120],
      ["nit", "b.ts", 1],
      ["nit", "app/a.ts", 121],
      ["nit", "app/a.ts", 123],
    ]);
    expect(plan.preExisting).toBe(2);
  });
});

const REQUEST = {
  pr: 80,
  head: "a".repeat(40),
  base: "b".repeat(40),
  patch: "p1",
  round: 2 as const,
  model: "sonnet",
  effort: "medium" as const,
};

const resultOf = (...findings: ReportedFinding[]): ReportedResult => ({
  kind: "reported",
  report: { findings },
  request: REQUEST,
  model: "claude-sonnet-5-5",
  claudeCodeVersion: "2.1.318",
  costUsd: 0.03,
  runUrl: "https://github.com/o/r/actions/runs/7",
});

const PostedComments = Schema.Array(
  Schema.Struct({ path: Schema.String, line: Schema.Int, side: Schema.String, body: Schema.String }),
);

const commentsOf = (...findings: ReportedFinding[]): typeof PostedComments.Type =>
  Schema.decodeUnknownSync(PostedComments)(
    reviewOf(postPlanOf(findings, LINES), resultOf(...findings), "c".repeat(40))["comments"],
  );

describe("reviewOf", () => {
  test("posts one comment on the new side per planned comment, on the head it names", () => {
    const result = resultOf(finding("important", "app/a.ts", 122));
    const review = reviewOf(postPlanOf(result.report.findings, LINES), result, "c".repeat(40));

    expect(review).toMatchObject({
      commit_id: "c".repeat(40),
      event: "COMMENT",
      comments: [{ path: "app/a.ts", line: 122, side: "RIGHT" }],
    });
  });

  test("a comment names its severity and summary, where its defect breaks, its scenario, and ends with its marker", () => {
    const breaking = { ...finding("important", "app/a.ts", 122), breaks: { file: "app/rename.ts", line: 5 } };
    const nowhere = { ...finding("nit", "b.ts", 1), breaks: { file: "app/rename.ts", line: null } };

    expect(commentsOf(breaking, nowhere).map((comment) => comment.body)).toEqual([
      `**Important**: important at app/a.ts\nBreaks: \`app/rename.ts:5\`\n\nthe scenario\n\n${markerOf("important")}`,
      `**Nit**: nit at b.ts\nBreaks: \`app/rename.ts\`\n\nthe scenario\n\n${markerOf("nit")}`,
    ]);
  });

  test("a comment on its finding's own line, breaking nothing elsewhere, holds the summary, the scenario and the marker alone", () => {
    expect(commentsOf(finding("important", "b.ts", 1)).map((comment) => comment.body)).toEqual([
      `**Important**: important at b.ts\n\nthe scenario\n\n${markerOf("important")}`,
    ]);
  });

  test("a comment anchored away from its finding says where the finding is", () => {
    const bodies = commentsOf(
      finding("important", "app/other.ts", 4),
      finding("important", "app/other.ts", 120),
      finding("important", "app/a.ts", 7),
      finding("important", "app/other.ts", null),
    ).map((comment) => comment.body.split("\n")[1]);

    expect(bodies).toEqual([
      "At `app/other.ts:4`, outside this diff.",
      "At `app/other.ts:120`, outside this diff.",
      "At `app/a.ts:7`, outside this diff.",
      "At `app/other.ts`, outside this diff.",
    ]);
  });

  test("a finding with no line on a file of the diff anchors on that file and has not moved", () => {
    expect(commentsOf(finding("important", "app/a.ts", null)).map((comment) => comment.body.split("\n")[1])).toEqual([
      "",
    ]);
  });

  test("the body counts what is posted and the Pre-existing findings left out, links the run, and carries the review's marker", () => {
    const result = resultOf(
      finding("important", "b.ts", 1),
      finding("nit", "b.ts", 1),
      finding("nit", "b.ts", 1),
      finding("pre_existing", "b.ts", 1),
    );

    expect(reviewOf(postPlanOf(result.report.findings, LINES), result, "c")["body"]).toBe(
      [
        "Review round 2 (claude-sonnet-5-5, /code-review medium): 1 important, 2 nit. 1 pre-existing finding(s) not posted.",
        "",
        "Review run: https://github.com/o/r/actions/runs/7",
        "",
        "<!-- lab-review patch=p1 round=2 -->",
      ].join("\n"),
    );
  });

  test("a review with nothing to post says so, and names the model asked when the result names none", () => {
    const result = { ...resultOf(), model: null };

    expect(reviewOf(postPlanOf([], LINES), result, "c")["body"]).toStartWith(
      "Review round 2 (sonnet, /code-review medium): nothing to fix.\n",
    );
    expect(reviewOf(postPlanOf([], LINES), result, "c")["comments"]).toEqual([]);
  });
});

describe("reviewMarkerOf", () => {
  test("names the patch and the round of the review", () => {
    expect(reviewMarkerOf({ ...REQUEST, patch: "abc", round: 1 })).toBe("<!-- lab-review patch=abc round=1 -->");
  });
});
