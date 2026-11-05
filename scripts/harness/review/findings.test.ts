import { describe, expect, test } from "bun:test";

import { commentOf, findingsOf, NIT_CAP, promptOf, severityOfBody } from "./findings.ts";

const out = (findings: object[]): string => JSON.stringify({ structured_output: { findings } });

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

  test("an answer without structured output does not read", () => {
    expect(findingsOf(JSON.stringify({ result: "looks good" }))).toBeNull();
    expect(findingsOf("not json")).toBeNull();
  });
});

describe("comments", () => {
  test("a posted finding names its severity and carries the marker the conductor reads back", () => {
    const body = commentOf({ file: "a.ts", line: 1, severity: "important", summary: "s", failureScenario: "f" });

    expect(body.startsWith("**Important**: s")).toBe(true);
    expect(severityOfBody(body)).toBe("important");
    expect(severityOfBody("a human comment")).toBeNull();
  });
});

describe("promptOf", () => {
  test("round 2 hunts nothing new and carries the author's rejections", () => {
    const prompt = promptOf("guide", "diff", 2, [{ where: "a.ts:1", finding: "x", reply: "intended" }]);

    expect(prompt).toContain("hunt for nothing new");
    expect(prompt).toContain("Author: intended");
    expect(promptOf("guide", "diff", 1, [])).not.toContain("round 2");
  });
});
