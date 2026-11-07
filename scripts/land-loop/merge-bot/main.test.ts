import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";
import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { Ran, Run } from "../ports/run.ts";
import { resultOf } from "../review/review-report.ts";
import type { ReviewState } from "./decide.ts";
import {
  ActionsRun,
  changedPathsArgs,
  CheckRuns,
  CheckSuites,
  ciOfRuns,
  ciRunsPathsOf,
  CommitPulls,
  Dispatched,
  IssueComments,
  IssueEvents,
  judgeDiffArgs,
  landApprovalByOwnerOf,
  ListedPrs,
  notFound,
  Pull,
  PullReviews,
  reviewJobReader,
  routingPolicyAt,
  WorkflowRuns,
} from "./main.ts";

const PULL = {
  number: 12,
  node_id: "PR_1",
  state: "open",
  merged: false,
  draft: false,
  mergeable: null,
  mergeable_state: "unknown",
  user: { login: "owner" },
  labels: [{ id: 1, name: "land:auto" }],
  head: { sha: "a".repeat(40), ref: "agent/x", repo: null },
  base: { ref: "dev" },
  title: "feat: x",
};

describe("the GitHub answers the Merge bot reads", () => {
  test("a PR whose mergeability GitHub has not computed, from a deleted fork, reads", () => {
    const pull = decodeJson(Pull, "pull", JSON.stringify(PULL));

    expect(pull.mergeable).toBeNull();
    expect(pull.head.repo).toBeNull();
    expect(pull.labels).toEqual([{ name: "land:auto" }]);
    expect(pull).not.toHaveProperty("title");
  });

  test("each endpoint's answer reads into the fields the Merge bot uses", () => {
    expect(decodeJson(IssueComments, "comments", JSON.stringify([{ id: 1, user: { login: "a" }, body: "b" }]))).toEqual(
      [{ id: 1, user: { login: "a" }, body: "b" }],
    );
    expect(
      decodeJson(
        IssueEvents,
        "events",
        JSON.stringify([
          { event: "committed", actor: { login: "a" }, created_at: "2026-11-05T10:00:00Z" },
          { event: "labeled", label: { name: "land-ok" }, actor: { login: "a" }, created_at: "2026-11-05T11:00:00Z" },
        ]),
      ),
    ).toHaveLength(2);
    expect(
      decodeJson(
        CheckRuns,
        "runs",
        JSON.stringify({ check_runs: [{ name: "validate", status: "queued", conclusion: null, app: { slug: "a" } }] }),
      ).check_runs,
    ).toHaveLength(1);
    expect(decodeJson(CheckSuites, "suites", JSON.stringify({ check_suites: [] })).check_suites).toEqual([]);
    expect(decodeJson(WorkflowRuns, "runs", JSON.stringify({ workflow_runs: [{ conclusion: null }] }))).toEqual({
      workflow_runs: [{ conclusion: null }],
    });
    expect(decodeJson(CommitPulls, "pulls", JSON.stringify([{ number: 3, state: "open" }]))).toEqual([
      { number: 3, state: "open" },
    ]);
    expect(decodeJson(ListedPrs, "gh pr list", JSON.stringify([{ number: 3 }]))).toEqual([{ number: 3 }]);
  });

  test("the review job's run, its dispatch and the PR's reviews read into the fields the Merge bot uses", () => {
    expect(
      decodeJson(ActionsRun, "run", JSON.stringify({ id: 42, status: "in_progress", conclusion: null, name: "x" })),
    ).toEqual({ status: "in_progress", conclusion: null });
    expect(
      decodeJson(
        Dispatched,
        "dispatch",
        JSON.stringify({ workflow_run_id: 42_364_772_835, run_url: "u", html_url: "h" }),
      ),
    ).toEqual({ workflow_run_id: 42_364_772_835 });
    expect(
      decodeJson(PullReviews, "reviews", JSON.stringify([{ id: 1, user: null, body: "b", state: "COMMENTED" }])),
    ).toEqual([{ user: null, body: "b" }]);
  });

  test("GitHub's null user, actor and App read, and a deleted user's event leaves the Land approval as it was", () => {
    const events = decodeJson(
      IssueEvents,
      "events",
      JSON.stringify([
        { event: "labeled", label: { name: "land-ok" }, actor: { login: "owner" }, created_at: "2026-11-05T11:00:00Z" },
        { event: "head_ref_force_pushed", actor: null, created_at: "2026-11-05T11:05:00Z" },
        { event: "unlabeled", label: null, actor: null, created_at: "2026-11-05T11:06:00Z" },
      ]),
    );

    expect(landApprovalByOwnerOf(events, "owner", "2026-11-05T10:00:00Z")).toBe(true);
    expect(landApprovalByOwnerOf(events, "owner", "2026-11-05T12:00:00Z")).toBe(false);
    expect(landApprovalByOwnerOf(events, "someone", "2026-11-05T10:00:00Z")).toBe(false);

    const byGhost = decodeJson(
      IssueEvents,
      "events",
      JSON.stringify([
        { event: "labeled", label: { name: "land-ok" }, actor: null, created_at: "2026-11-05T11:00:00Z" },
      ]),
    );

    expect(landApprovalByOwnerOf(byGhost, "owner", null)).toBe(false);

    const runs = JSON.stringify({
      check_runs: [{ name: "validate", status: "completed", conclusion: "success", app: null }],
    });

    expect(decodeJson(CheckRuns, "runs", runs).check_runs[0]?.app).toBeNull();
    expect(decodeJson(Pull, "pull", JSON.stringify({ ...PULL, user: null })).user).toBeNull();
    expect(decodeJson(IssueComments, "comments", JSON.stringify([{ id: 1, user: null, body: "b" }]))).toEqual([
      { id: 1, user: null, body: "b" },
    ]);
  });

  test("an answer outside the schema is refused, naming the endpoint and the field", () => {
    expect(() => decodeJson(Pull, "gh api repos/o/r/pulls/12", JSON.stringify({ ...PULL, state: "merged" }))).toThrow(
      'gh api repos/o/r/pulls/12: Expected "open" | "closed"\n  at ["state"]',
    );
    expect(() =>
      decodeJson(IssueComments, "comments", JSON.stringify([{ id: "1", user: { login: "a" }, body: "b" }])),
    ).toThrow('Expected number\n  at [0]["id"]');
  });

  test("every other endpoint's answer outside its schema is refused", () => {
    const refused: ReadonlyArray<[Schema.ConstraintDecoder<unknown>, Schema.Json]> = [
      [CheckRuns, { check_runs: [{ name: "validate", status: "completed", conclusion: null }] }],
      [IssueEvents, [{ event: "labeled", label: { name: "land-ok" }, actor: { login: "a" } }]],
      [CheckSuites, { check_suites: [{ created_at: null }] }],
      [WorkflowRuns, { workflow_runs: null }],
      [CommitPulls, [{ number: "3", state: "open" }]],
      [ListedPrs, [{ id: 3 }]],
      [ActionsRun, { status: "completed" }],
      [Dispatched, { workflow_run_id: "42" }],
      [PullReviews, [{ user: { login: "a" } }]],
    ];

    for (const [schema, answer] of refused) {
      expect(Result.isFailure(Schema.decodeUnknownResult(schema)(answer))).toBe(true);
    }
  });
});

/** A `gh api` read that exited 1 with `stderr`. */
const failedRead = (stderr: string) => ({ code: 1, stdout: "", stderr });

describe("notFound", () => {
  test("only a read GitHub answered 404 is a run gone; a rate limit, a 5xx or a network error is not", () => {
    expect(notFound(failedRead("gh: Not Found (HTTP 404)\n"))).toBe(true);
    expect(notFound(failedRead("gh: Server Error (HTTP 502)\n"))).toBe(false);
    expect(notFound(failedRead("gh: API rate limit exceeded (HTTP 403)\n"))).toBe(false);
    expect(notFound(failedRead("error connecting to api.github.com\n"))).toBe(false);
    expect(notFound({ code: 0, stdout: "{}", stderr: "(HTTP 404)" })).toBe(false);
  });
});

const WHERE = { repo: "o/r", cwd: "/tmp" };

const ASKED: ReviewState = { kind: "requested", patch: "p1", round: 1, runId: 7, at: "2026-11-07T11:00:00.000Z" };

const RESULT = resultOf(
  { pr: 12, head: "a".repeat(40), base: "b".repeat(40), patch: "p1", round: 1, model: "opus", effort: "high" },
  {
    kind: "answered",
    structured: { findings: [] },
    model: "claude-opus-5-5",
    claudeCodeVersion: "2.1.318",
    costUsd: 0.5,
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

const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });

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

const ciRuns = (conclusion: string | null, slug = "github-actions") => ({
  check_runs: [{ name: "x", status: conclusion === null ? "in_progress" : "completed", conclusion, app: { slug } }],
});

describe("the routing inputs", () => {
  test("the routing policy is read from the given checkout, and a config that does not read fails naming the file", () => {
    const checkout = mkdtempSync(join(tmpdir(), "routing-policy-"));
    mkdirSync(join(checkout, ".github"));
    const routing = { ownerPaths: ["x/**"], factoryPaths: [], deepReviewPaths: [], lineCap: 7 };
    writeFileSync(join(checkout, FACTORY_CONFIG_PATH), JSON.stringify({ land: { routing } }));

    expect(routingPolicyAt(checkout)).toEqual(routing);

    writeFileSync(join(checkout, FACTORY_CONFIG_PATH), JSON.stringify({ land: {} }));

    expect(() => routingPolicyAt(checkout)).toThrow(FACTORY_CONFIG_PATH);
  });

  test("a moved file lists both its old and its new path, so a move out of an Owner path is still routed to the Owner", async () => {
    const repo = mkdtempSync(join(tmpdir(), "changed-paths-"));

    // An inherited GIT_DIR would point this git at the real repository; the test layer cannot import fixtureEnv.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name, value]) => !name.startsWith("GIT_") && value !== undefined),
    );

    const git = (args: readonly string[]) => $`git ${args}`.cwd(repo).env(env).quiet();

    await git(["init", "-q"]);
    await git(["config", "user.email", "t@t"]);
    await git(["config", "user.name", "t"]);
    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, FACTORY_CONFIG_PATH), "{}\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "a"]);
    const base = (await git(["rev-parse", "HEAD"])).text().trim();
    mkdirSync(join(repo, "scripts"));
    await git(["mv", FACTORY_CONFIG_PATH, "scripts/software-factory.json"]);
    await git(["commit", "-q", "-m", "b"]);

    const listed = (await git(changedPathsArgs(base, "HEAD"))).text().trim().split("\n").toSorted();

    expect(listed).toEqual([FACTORY_CONFIG_PATH, "scripts/software-factory.json"]);
  });

  test("the Routing judge reads the diff of the paths it is asked about, each path read literally", () => {
    expect(judgeDiffArgs("b", "h", null, true)).toEqual(["--literal-pathspecs", "diff", "--stat", "b..h"]);
    expect(judgeDiffArgs("b", "h", ["app/a*.ts", "docs/u.md"], false)).toEqual([
      "--literal-pathspecs",
      "diff",
      "b..h",
      "--",
      "app/a*.ts",
      "docs/u.md",
    ]);
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
