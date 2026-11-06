import { describe, expect, test } from "bun:test";

import { decodeJson } from "../../lib/json.ts";
import { CheckRuns, greenOnHead, prOfRef, Pull } from "./repost.ts";

const SHA = "a".repeat(40);

describe("prOfRef", () => {
  test("the queue's ref names the PR it tests", () => {
    expect(prOfRef(`refs/heads/gh-readonly-queue/dev/pr-12-${SHA}`)).toBe(12);
    expect(prOfRef("refs/heads/dev")).toBeNull();
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
});

describe("the GitHub answers this job reads", () => {
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
  });
});
