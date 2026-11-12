import { describe, expect, test } from "bun:test";

import { decodeJson } from "../../lib/json.ts";
import { CheckRuns, greenOnHead, prOfRef, Pull, repostBodyOf } from "./repost.ts";

const SHA = "a".repeat(40);

describe("prOfRef", () => {
  test("the queue's ref names the PR it tests", () => {
    expect(prOfRef(`refs/heads/gh-readonly-queue/dev/pr-12-${SHA}`)).toBe(12);
    expect(prOfRef("refs/heads/dev")).toBeNull();
    expect(prOfRef(`refs/heads/gh-readonly-queue/dev/pr-12-${SHA}/more`)).toBeNull();
  });
});

const check = (name: string, conclusion: string, slug: string, at: string) => ({
  name,
  status: "completed",
  conclusion,
  app: { slug },
  completed_at: at,
});

describe("greenOnHead", () => {
  test("the App's latest completed check of that name decides; another App's check of the same name does not count", () => {
    const runs = [
      check("land-gate", "failure", "bengous-labs-agents", "2026-11-05T10:00:00Z"),
      check("land-gate", "success", "bengous-labs-agents", "2026-11-05T11:00:00Z"),
      check("agent-review", "success", "github-actions", "2026-11-05T11:00:00Z"),
    ];

    expect(greenOnHead(runs, "land-gate", "bengous-labs-agents")).toBe(true);
    expect(greenOnHead(runs, "agent-review", "bengous-labs-agents")).toBe(false);
  });

  test("the latest completion decides, whatever order GitHub lists the checks in", () => {
    const green = check("land-gate", "success", "bengous-labs-agents", "2026-11-05T11:00:00Z");
    const red = check("land-gate", "failure", "bengous-labs-agents", "2026-11-05T10:00:00Z");
    const older = check("land-gate", "failure", "bengous-labs-agents", "2026-11-05T09:00:00Z");

    expect(greenOnHead([green, red], "land-gate", "bengous-labs-agents")).toBe(true);
    expect(greenOnHead([red, green], "land-gate", "bengous-labs-agents")).toBe(true);
    expect(greenOnHead([older, red, green], "land-gate", "bengous-labs-agents")).toBe(true);
    expect(
      greenOnHead([older, green, { ...red, completed_at: "2026-11-05T12:00:00Z" }], "land-gate", "bengous-labs-agents"),
    ).toBe(false);
  });

  test("a check that has not completed does not decide", () => {
    const runs = [
      check("land-gate", "failure", "bengous-labs-agents", "2026-11-05T10:00:00Z"),
      { ...check("land-gate", "success", "bengous-labs-agents", "2026-11-05T11:00:00Z"), status: "in_progress" },
    ];

    expect(greenOnHead(runs, "land-gate", "bengous-labs-agents")).toBe(false);
  });
});

describe("the GitHub answers this job reads", () => {
  test("a check run with no App reads, and never counts as the App's", () => {
    const text = JSON.stringify({
      check_runs: [
        {
          name: "land-gate",
          status: "completed",
          conclusion: "success",
          completed_at: "2026-11-05T11:00:00Z",
          app: null,
        },
      ],
    });

    expect(greenOnHead(decodeJson(CheckRuns, "check runs", text).check_runs, "land-gate", "bengous-labs-agents")).toBe(
      false,
    );
  });

  test("a check run still in progress reads with no conclusion and no completion time", () => {
    const text = JSON.stringify({
      total_count: 1,
      check_runs: [
        { id: 1, name: "land-gate", status: "in_progress", conclusion: null, completed_at: null, app: { slug: "a" } },
      ],
    });

    expect(decodeJson(CheckRuns, "check runs", text).check_runs).toEqual([
      { name: "land-gate", status: "in_progress", conclusion: null, completed_at: null, app: { slug: "a" } },
    ]);
  });

  test("an answer outside the schema is refused", () => {
    expect(() => decodeJson(Pull, "PR #12", JSON.stringify({ head: { ref: "x" } }))).toThrow(
      'PR #12: Missing key\n  at ["head"]["sha"]',
    );
    expect(() => decodeJson(CheckRuns, "check runs", JSON.stringify({ check_runs: [{ name: "x" }] }))).toThrow(
      'check runs: Missing key\n  at ["check_runs"][0]["status"]',
    );
    expect(() =>
      decodeJson(
        CheckRuns,
        "check runs",
        JSON.stringify({
          check_runs: [{ name: "x", status: "completed", conclusion: null, completed_at: null, app: {} }],
        }),
      ),
    ).toThrow('check runs: Missing key\n  at ["check_runs"][0]["app"]["slug"]');
  });
});

describe("repostBodyOf", () => {
  const RUN_URL = "https://github.com/o/r/actions/runs/9";
  const HEAD = "c".repeat(40);

  test("a green check is a success on the queue's commit, and links to the run that posts it", () => {
    expect(repostBodyOf("land-gate", SHA, { green: true, pr: 12, headSha: HEAD }, RUN_URL)).toEqual({
      name: "land-gate",
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
      output: { title: "Green on #12's head ccccccc.", summary: "Green on #12's head ccccccc." },
      details_url: RUN_URL,
    });
  });

  test("a check not green is a failure on the queue's commit, and links to the run that posts it", () => {
    expect(repostBodyOf("agent-review", SHA, { green: false, pr: 12, headSha: HEAD }, RUN_URL)).toEqual({
      name: "agent-review",
      head_sha: SHA,
      status: "completed",
      conclusion: "failure",
      output: { title: "Not green on #12's head ccccccc.", summary: "Not green on #12's head ccccccc." },
      details_url: RUN_URL,
    });
  });
});
