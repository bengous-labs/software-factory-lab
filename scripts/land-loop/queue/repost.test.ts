import { describe, expect, test } from "bun:test";

import { greenOnHead, prOfRef } from "./repost.ts";

const SHA = "a".repeat(40);

describe("prOfRef", () => {
  test("the queue's ref names the PR it tests", () => {
    expect(prOfRef(`refs/heads/gh-readonly-queue/dev/pr-12-${SHA}`)).toBe(12);
    expect(prOfRef("refs/heads/dev")).toBeNull();
  });
});

describe("greenOnHead", () => {
  const check = (name: string, conclusion: string, slug: string, at: string) => ({
    name,
    status: "completed",
    conclusion,
    app: { slug },
    completed_at: at,
  });

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
