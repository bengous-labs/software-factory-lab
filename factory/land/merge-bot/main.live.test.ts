import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Ran, Run } from "../../lib/run.port.ts";
import { resultOf } from "../review/review-report.ts";
import { reviewJobReader } from "./main.live.ts";
import { ok, WHERE } from "./merge-bot.fixtures.ts";
import type { ReviewState } from "./record.ts";

const ASKED: ReviewState = { kind: "requested", patch: "p1", round: 1, runId: 7, at: "2026-11-07T11:00:00.000Z" };

const RESULT = resultOf(
  {
    pr: 12,
    head: "a".repeat(40),
    base: "b".repeat(40),
    patch: "p1",
    round: 1,
    model: "opus",
    effort: "high",
    security: false,
  },
  {
    kind: "answered",
    structured: { findings: [] },
    model: "claude-opus-5-5",
    claudeCodeVersion: "2.1.318",
    tokens: null,
  },
  "https://github.com/o/r/actions/runs/7",
);

interface RecordedRunner {
  readonly runner: Run;
  readonly calls: string[][];
}

/** A runner that answers `gh api` with `api` and an artifact download with `download`, and records every call. */
function runnerOf(api: Ran, download: (dir: string) => Ran): RecordedRunner {
  const calls: string[][] = [];

  const runner: Run = (argv) => {
    calls.push([...argv]);

    return Promise.resolve(argv[1] === "api" ? api : download(argv.at(-1) ?? ""));
  };

  return { runner, calls };
}

const downloaded = (dir: string): Ran => {
  writeFileSync(join(dir, "review-result.json"), JSON.stringify(RESULT));

  return ok("");
};

describe("reviewJobReader", () => {
  test("no request, or one for another patch, reads no run", async () => {
    const { runner, calls } = runnerOf(ok("{}"), downloaded);

    expect(await reviewJobReader(runner)(WHERE, 12, undefined, "p1")).toBeNull();
    expect(await reviewJobReader(runner)(WHERE, 12, ASKED, "p2")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a run GitHub answers 404 for is missing; any other failed read throws", async () => {
    const gone = runnerOf({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" }, downloaded);
    const flaky = runnerOf({ code: 1, stdout: "", stderr: "gh: Server Error (HTTP 502)\n" }, downloaded);

    expect(await reviewJobReader(gone.runner)(WHERE, 12, ASKED, "p1")).toEqual({ kind: "missing" });
    expect(gone.calls).toEqual([["gh", "api", "repos/o/r/actions/runs/7"]]);
    // oxlint-disable-next-line typescript/await-thenable, typescript/no-confusing-void-expression -- bun-types types rejects matchers as void; Bun returns the promise the test awaits.
    await expect(reviewJobReader(flaky.runner)(WHERE, 12, ASKED, "p1")).rejects.toThrow(
      "exited 1: gh: Server Error (HTTP 502)",
    );
  });

  test("a run in progress is running, and its artifact is not fetched", async () => {
    const { runner, calls } = runnerOf(ok('{"status":"in_progress","conclusion":null}'), downloaded);

    expect(await reviewJobReader(runner)(WHERE, 12, ASKED, "p1")).toEqual({ kind: "running" });
    expect(calls).toHaveLength(1);
  });

  test("a completed run gives the result of its artifact, named after the PR and the round, or null when none reads", async () => {
    const done = '{"status":"completed","conclusion":"success"}';
    const read = runnerOf(ok(done), downloaded);
    const none = runnerOf(ok(done), () => ({ code: 1, stdout: "", stderr: "no artifact" }));

    expect(await reviewJobReader(read.runner)(WHERE, 12, ASKED, "p1")).toEqual({
      kind: "completed",
      conclusion: "success",
      result: RESULT,
    });
    expect(read.calls[1]?.slice(0, 7)).toEqual(["gh", "run", "download", "7", "--repo", "o/r", "--name"]);
    expect(read.calls[1]?.[7]).toBe("review-12-1");
    expect(await reviewJobReader(none.runner)(WHERE, 12, ASKED, "p1")).toEqual({
      kind: "completed",
      conclusion: "success",
      result: null,
    });
  });
});
