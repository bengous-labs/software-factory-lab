import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Ran, Run } from "../../lib/run.port.ts";
import { resultOf } from "../review/review-report.ts";
import { envOf } from "./github.ts";
import { reviewJobReader, snapshotOf } from "./main.live.ts";
import { labeled, ok, WHERE } from "./merge-bot.fixtures.ts";
import type { Pull } from "./readings.ts";
import { EMPTY_RECORD } from "./record.ts";
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

/** The job's variables, each login its own, as `merge-bot.yml` sets them. */
const VARIABLES = {
  GITHUB_REPOSITORY: "o/r",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "5",
  OWNER: "the-owner",
  AUTHOR_LOGIN: "the-author",
  APP_LOGIN: "the-app[bot]",
};

const HEAD = "a".repeat(40);

const PULL: Pull = {
  number: 12,
  node_id: "PR_1",
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  user: { login: "the-author" },
  labels: [{ name: "land-ok" }],
  head: { sha: HEAD, ref: "issue/1-x", repo: { full_name: "o/r" } },
  base: { ref: "dev" },
};

/**
 * A runner over a PR whose head was pushed at 10:00 and reviewed by the App at 10:30, on which `login` put
 * the Land approval at 11:00.
 */
const landOkRunner =
  (login: string): Run =>
  (argv) => {
    const [command, ...args] = argv;
    const path = args.at(-1) ?? "";

    if (command === "git") {
      return Promise.resolve(
        ok(args[0] === "rev-parse" ? "d".repeat(40) : args.includes("--name-only") ? "x.ts\n" : ""),
      );
    }

    const answers: ReadonlyArray<readonly [string, unknown]> = [
      ["/check-runs", { check_runs: [] }],
      ["/check-suites", { check_suites: [{ id: 1, head_branch: "issue/1-x", created_at: "2026-11-05T10:00:00Z" }] }],
      ["/issues/12/events", [[labeled("land-ok", login, "2026-11-05T11:00:00Z")]]],
      [
        "/pulls/12/reviews",
        [
          [
            {
              user: { login: VARIABLES.APP_LOGIN },
              body: "Round 1: 0 Important.\n\n<!-- lab-review patch=p1 round=1 -->",
              submitted_at: "2026-11-05T10:30:00Z",
            },
          ],
        ],
      ],
    ];

    const answer = answers.find(([part]) => path.includes(part));

    return answer === undefined
      ? Promise.reject(new Error(`unexpected command: ${argv.join(" ")}`))
      : Promise.resolve(ok(JSON.stringify(answer[1])));
  };

/** The snapshot of `PULL` when `login` put its Land approval, over the Env the job's variables give. */
const snapshotBy = (login: string) =>
  snapshotOf(
    envOf(VARIABLES, { run: landOkRunner(login), ask: () => Promise.reject(new Error("no model")) }, "/tmp"),
    PULL,
    { base: "b".repeat(40), head: HEAD },
    EMPTY_RECORD,
    [],
  );

describe("snapshotOf", () => {
  test("a Land approval the Owner put after the head's push and the App's review counts", async () => {
    expect(await snapshotBy(VARIABLES.OWNER)).toMatchObject({
      landApprovalByOwner: true,
      landApprovalPutByOwner: true,
    });
  });

  test("a Land approval the Author's machine account or the App put counts for nothing, whatever the job's variables name", async () => {
    for (const login of [VARIABLES.AUTHOR_LOGIN, VARIABLES.APP_LOGIN]) {
      expect(await snapshotBy(login)).toMatchObject({ landApprovalByOwner: false, landApprovalPutByOwner: false });
    }
  });
});

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
