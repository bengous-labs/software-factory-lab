import { describe, expect, test } from "bun:test";

import { commandsAnswering, ok } from "./merge-bot.fixtures.ts";
import { ciOfRuns, ciRunsPathsOf, startOf } from "./readings.ts";
import type { Pull } from "./readings.ts";
import { EMPTY_RECORD } from "./record.ts";
import {
  changedPathsArgs,
  deletedPathsArgs,
  judgeDiffArgs,
  judgeEnvOf,
  linesChanged,
  linesOfNumstat,
  numstatArgs,
  patchOf,
  pathsListed,
  rangeOf,
  rangeStart,
  readsPatchDelta,
  routingLineOf,
} from "./routing-inputs.ts";

const ciRuns = (conclusion: string | null, slug = "github-actions") => ({
  check_runs: [
    {
      name: "x",
      status: conclusion === null ? "in_progress" : "completed",
      conclusion,
      app: { slug },
      check_suite: { id: 1 },
    },
  ],
});

const PULL: Pull = {
  number: 7,
  node_id: "PR_7",
  state: "open",
  merged: false,
  draft: false,
  mergeable: true,
  mergeable_state: "clean",
  user: { login: "the-author" },
  labels: [],
  head: { sha: "h1", ref: "issue/7-x", repo: { full_name: "o/r" } },
  base: { ref: "release" },
};

describe("the routing inputs", () => {
  test("the git commands that list a range's paths and count its lines split renames and name the range", () => {
    expect(changedPathsArgs("b", "h")).toEqual(["diff", "--name-only", "--no-renames", "b..h"]);
    expect(deletedPathsArgs("b", "h")).toEqual(["diff", "--name-only", "--no-renames", "--diff-filter=D", "b..h"]);
    expect(numstatArgs("b", "h")).toEqual(["diff", "--numstat", "b..h"]);
  });

  test("a numstat counts what each file adds and deletes, never its path, and nothing for a binary file", () => {
    expect(linesOfNumstat("3\t1\ta.ts\n2\t0\tb.ts\n")).toBe(6);
    expect(linesOfNumstat("3\t1\t7\n")).toBe(4);
    expect(linesOfNumstat("-\t-\timage.png\n3\t1\ta.ts\n")).toBe(4);
    expect(linesOfNumstat("")).toBe(0);
  });

  test("Review rounds 2 and 3 read the Patch delta from the head the last round read; round 1 the whole PR", () => {
    expect(readsPatchDelta(1)).toBe(false);
    expect(readsPatchDelta(2)).toBe(true);
    expect(readsPatchDelta(3)).toBe(true);
  });

  test("the Routing judge reads the whole diff of its range, its stat or its patch", () => {
    expect(judgeDiffArgs("b", "h", true)).toEqual(["diff", "--stat", "b..h"]);
    expect(judgeDiffArgs("b", "h", false)).toEqual(["diff", "b..h"]);
  });

  test("a start serves the PR it names, a completed run's commit PRs, or on CI's push completion every open PR", () => {
    expect(startOf({ event: "pull_request_target", pr: "7" })).toEqual({ kind: "pr", number: 7 });
    expect(startOf({ event: "workflow_run", pr: "7", runEvent: "workflow_dispatch" })).toEqual({
      kind: "pr",
      number: 7,
    });
    expect(startOf({ event: "workflow_run", pr: "", runEvent: "pull_request" })).toEqual({ kind: "commit-pulls" });
    expect(startOf({ event: "workflow_run", pr: "", runEvent: "push" })).toEqual({ kind: "sweep" });
    expect(startOf({ event: "push", pr: "" })).toEqual({ kind: "sweep" });
    expect(startOf({ event: "schedule" })).toEqual({ kind: "sweep" });
  });

  test("the CI of a head reads GitHub Actions' validate and mutation runs on it", () => {
    expect(ciRunsPathsOf("o/r", "h1")).toEqual([
      "repos/o/r/commits/h1/check-runs?check_name=validate",
      "repos/o/r/commits/h1/check-runs?check_name=mutation",
    ]);

    expect(ciOfRuns([ciRuns("success"), ciRuns("success")])).toBe("success");
    expect(ciOfRuns([ciRuns("success"), ciRuns("failure")])).toBe("failure");
    expect(ciOfRuns([ciRuns("success"), ciRuns(null)])).toBeNull();
    expect(ciOfRuns([ciRuns("success"), ciRuns("success", "another-app")])).toBeNull();
  });
});

describe("what the Merge bot reads of a range through git", () => {
  test("a range is the PR's head and its merge base with the PR's base branch, read after a fetch of their refs", async () => {
    const { env, calls } = commandsAnswering({
      "fetch --quiet origin +refs/pull/7/head:refs/lab/pr-7 +refs/heads/release:refs/remotes/origin/release +refs/heads/dev:refs/remotes/origin/dev":
        ok(""),
      "merge-base origin/release h1": ok("b1\n"),
    });

    expect(await rangeOf(env, PULL)).toEqual({ base: "b1", head: "h1" });
    expect(calls.map((call) => [call.argv[0], call.argv[1], call.cwd])).toEqual([
      ["git", "fetch", "/tmp"],
      ["git", "merge-base", "/tmp"],
    ]);
  });

  test("a patch is the stable id git gives the range's diff, and an empty diff is the empty patch, with no id asked", async () => {
    const changed = commandsAnswering({ "diff b1..h1": ok("the diff\n"), "patch-id --stable": ok("p1d 0000\n") });

    expect(await patchOf(changed.env, { base: "b1", head: "h1" })).toBe("p1d");
    expect(changed.calls.at(-1)).toEqual({ argv: ["git", "patch-id", "--stable"], cwd: "/tmp", stdin: "the diff\n" });

    const same = commandsAnswering({ "diff b1..h1": ok("\n") });

    expect(await patchOf(same.env, { base: "b1", head: "h1" })).toBe("empty");
    expect(same.calls).toHaveLength(1);
  });

  test("a Patch delta starts at the head the last review read while it is an ancestor of this head, else at the merge base", async () => {
    const range = { base: "b1", head: "h1" };
    const reviewed = { ...EMPTY_RECORD, reviewedHead: "r1" };
    const ancestor = commandsAnswering({ "merge-base --is-ancestor r1 h1": ok("") });

    expect(await rangeStart(ancestor.env, range, reviewed, true)).toBe("r1");
    expect(ancestor.calls).toEqual([
      { argv: ["git", "merge-base", "--is-ancestor", "r1", "h1"], cwd: "/tmp", stdin: undefined },
    ]);

    const rebased = commandsAnswering({ "merge-base --is-ancestor r1 h1": { code: 1, stdout: "", stderr: "" } });

    expect(await rangeStart(rebased.env, range, reviewed, true)).toBe("b1");
  });

  test("the whole PR, or a PR no review read yet, starts at the merge base, and git is not asked", async () => {
    const range = { base: "b1", head: "h1" };
    const none = commandsAnswering({});

    expect(await rangeStart(none.env, range, { ...EMPTY_RECORD, reviewedHead: "r1" }, false)).toBe("b1");
    expect(await rangeStart(none.env, range, EMPTY_RECORD, true)).toBe("b1");
    expect(none.calls).toEqual([]);
  });

  test("the paths git lists come one per line, and a range that touches none lists none", async () => {
    const { env, calls } = commandsAnswering({
      "diff --name-only a..b": ok("a.ts\n\nb.ts\n"),
      "diff --name-only b..b": ok(""),
    });

    expect(await pathsListed(env, ["diff", "--name-only", "a..b"])).toEqual(["a.ts", "b.ts"]);
    expect(await pathsListed(env, ["diff", "--name-only", "b..b"])).toEqual([]);
    expect(calls[0]).toEqual({ argv: ["git", "diff", "--name-only", "a..b"], cwd: "/tmp", stdin: undefined });
  });

  test("the lines a range changes are those of git's numstat over it", async () => {
    const { env, calls } = commandsAnswering({ "diff --numstat b1..h1": ok("3\t1\ta.ts\n2\t2\tb.ts\n") });

    expect(await linesChanged(env, "b1", "h1")).toBe(8);
    expect(calls).toEqual([{ argv: ["git", "diff", "--numstat", "b1..h1"], cwd: "/tmp", stdin: undefined }]);
  });
});

describe("the Routing judge's worktree", () => {
  const JOB = { PATH: "/usr/bin", HOME: "/home/runner", CLAUDE_CODE_OAUTH_TOKEN: "oauth", GH_TOKEN: "app" };

  test("the judge's environment holds the job's PATH, HOME and OAuth token, no memory and the given config, and nothing else", () => {
    expect(judgeEnvOf(JOB, "/tmp/config")).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CONFIG_DIR: "/tmp/config",
    });
    expect(() => judgeEnvOf({ ...JOB, HOME: "" }, "/tmp/config")).toThrow("HOME is unset");
    expect(() => judgeEnvOf({ HOME: "/home/runner", CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, "/tmp/config")).toThrow(
      "PATH is unset",
    );
  });
});

describe("routingLineOf", () => {
  const ANSWER = {
    land: "auto",
    review: "light",
    secondRound: false,
    reason: "docs",
    model: "claude-haiku-5-5",
  } as const;

  const TOKENS = { input: 2, output: 58, cacheRead: 1568, cacheCreation: 6770 };

  test("the Routing judge's tokens close the line when it was asked, and none when its call counted none", () => {
    expect(routingLineOf(91, "3f2a9c1e00", ANSWER, { routing: ANSWER, tokens: TOKENS })).toBe(
      "#91 routing 3f2a9c1e: route:auto review:light second:false by claude-haiku-5-5 (docs) tokens in=2 out=58 cache_read=1568 cache_write=6770",
    );
    expect(routingLineOf(91, "3f2a9c1e00", ANSWER, { routing: ANSWER, tokens: null })).toBe(
      "#91 routing 3f2a9c1e: route:auto review:light second:false by claude-haiku-5-5 (docs) tokens none",
    );
  });

  test("a route the Routing rules set alone names no tokens", () => {
    expect(routingLineOf(91, "3f2a9c1e00", { ...ANSWER, model: null, reason: "rules" }, null)).toBe(
      "#91 routing 3f2a9c1e: route:auto review:light second:false by the Routing rules (rules)",
    );
  });
});
