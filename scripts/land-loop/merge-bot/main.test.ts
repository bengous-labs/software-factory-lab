import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import type { Reader } from "../ports/ask.ts";
import type { Ran, Run } from "../ports/run.ts";
import { resultOf } from "../review/review-report.ts";
import { judgeAskOf, patchDeltaRulesOf, routingOf, routingRulesOf } from "../routing/routing-rules.ts";
import type { ReviewState } from "./decide.ts";
import {
  ActionsRun,
  changedPathsArgs,
  checkRunBodyOf,
  CheckRuns,
  checkSetter,
  CheckSuites,
  ciOfRuns,
  ciRunsPathsOf,
  CommitPulls,
  deletedPathsArgs,
  devRedOf,
  devRunsReader,
  Dispatched,
  humanLabelByOf,
  IssueComments,
  IssueEvents,
  judgeAt,
  judgeDiffArgs,
  judgeEnvOf,
  labelEventsReader,
  landApprovalByOwnerOf,
  landApprovalPutByOwnerOf,
  linesOfNumstat,
  ListedPrs,
  notFound,
  numstatArgs,
  openedByFactoryOf,
  ownerCommenter,
  Pull,
  PullReviews,
  readsPatchDelta,
  reviewJobReader,
  routingLineOf,
  routingPolicyAt,
  startOf,
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
    expect(landApprovalPutByOwnerOf(events, "owner")).toBe(true);
    expect(landApprovalPutByOwnerOf(events, "someone")).toBe(false);

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

describe("the Owner and the Author", () => {
  const logins = { owner: "bengous", authorLogin: "bengous-labs-author" };

  test("a PR the Author's machine account opened is served as one the Owner opened; any other login's is not", () => {
    expect(openedByFactoryOf("bengous", logins)).toBe(true);
    expect(openedByFactoryOf("bengous-labs-author", logins)).toBe(true);
    expect(openedByFactoryOf("someone", logins)).toBe(false);
    expect(openedByFactoryOf(undefined, logins)).toBe(false);
  });

  test("a land-ok the Author's machine account put is no Land approval", () => {
    const events = decodeJson(
      IssueEvents,
      "events",
      JSON.stringify([
        {
          event: "labeled",
          label: { name: "land-ok" },
          actor: { login: "bengous-labs-author" },
          created_at: "2026-11-05T11:00:00Z",
        },
      ]),
    );

    expect(landApprovalByOwnerOf(events, "bengous", "2026-11-05T10:00:00Z")).toBe(false);
  });
});

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

const ok = (stdout: string): Ran => ({ code: 0, stdout, stderr: "" });

const downloaded = (dir: string): Ran => {
  writeFileSync(join(dir, "review-result.json"), JSON.stringify(RESULT));

  return ok("");
};

type LabelEvent = (typeof IssueEvents.Type)[number];

const labeled = (name: string, login: string | null, at: string): LabelEvent => ({
  event: "labeled",
  label: { name },
  actor: login === null ? null : { login },
  created_at: at,
});

const filler = (count: number): LabelEvent[] =>
  Array.from({ length: count }, () => ({
    event: "mentioned",
    actor: { login: "x" },
    created_at: "2026-11-05T09:00:00Z",
  }));

describe("humanLabelByOf", () => {
  const BOT = "agents[bot]";

  test("no land:human on the PR is null, whatever the events say", () => {
    expect(humanLabelByOf([labeled("land:human", BOT, "2026-11-05T10:00:00Z")], ["land:auto"], BOT)).toBeNull();
  });

  test("the latest labeled event of land:human decides: the Merge bot's App, or any other login", () => {
    const botLast = [
      labeled("land:human", "owner", "2026-11-05T10:00:00Z"),
      labeled("land:human", BOT, "2026-11-05T11:00:00Z"),
      labeled("land-ok", "owner", "2026-11-05T12:00:00Z"),
    ];

    const ownerLast = [
      labeled("land:human", BOT, "2026-11-05T10:00:00Z"),
      labeled("land:human", "owner", "2026-11-05T11:00:00Z"),
    ];

    expect(humanLabelByOf(botLast, ["land:human"], BOT)).toBe("merge-bot");
    expect(humanLabelByOf(ownerLast, ["land:human"], BOT)).toBe("other");
  });

  test("a land:human on the PR whose latest event is its removal is a read that lags: another login", () => {
    const lagging = [
      labeled("land:human", BOT, "2026-11-05T10:00:00Z"),
      { ...labeled("land:human", BOT, "2026-11-05T11:00:00Z"), event: "unlabeled" },
    ];

    expect(humanLabelByOf(lagging, ["land:human"], BOT)).toBe("other");
  });

  test("an unreadable actor, or no labeled event of land:human, is another login: the safe side", () => {
    expect(humanLabelByOf([labeled("land:human", null, "2026-11-05T10:00:00Z")], ["land:human"], BOT)).toBe("other");
    expect(humanLabelByOf([labeled("land-ok", BOT, "2026-11-05T10:00:00Z")], ["land:human"], BOT)).toBe("other");
  });
});

describe("labelEventsReader", () => {
  test("reads every page of the PR's events, so a labeled event past the first 100 is found", async () => {
    const pages = [filler(100), [...filler(20), labeled("land:human", "agents[bot]", "2026-11-05T11:00:00Z")]];
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: JSON.stringify(pages), stderr: "" });
    };

    const events = await labelEventsReader(runner)(WHERE, 12);

    expect(calls).toEqual([
      ["gh", "api", "-X", "GET", "--paginate", "--slurp", "repos/o/r/issues/12/events?per_page=100"],
    ]);
    expect(events).toHaveLength(121);
    expect(humanLabelByOf(events, ["land:human"], "agents[bot]")).toBe("merge-bot");
  });
});

describe("ownerCommenter", () => {
  test("posts an owner-comment step as a new comment on the PR, with its body as is", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await ownerCommenter(runner)(WHERE, 12, "Only the Owner's Land approval counts.");

    expect(calls).toEqual([
      {
        argv: ["gh", "api", "-X", "POST", "repos/o/r/issues/12/comments", "--input", "-"],
        stdin: JSON.stringify({ body: "Only the Owner's Land approval counts." }),
      },
    ]);
  });
});

describe("checkRunBodyOf", () => {
  const RUN_URL = "https://github.com/o/r/actions/runs/42";
  const SHA = "b".repeat(40);

  test("a pending check is in progress, with no conclusion, and links to the run that posts it", () => {
    expect(checkRunBodyOf("land-gate", SHA, { kind: "pending", summary: "Waiting." }, RUN_URL)).toEqual({
      name: "land-gate",
      head_sha: SHA,
      status: "in_progress",
      output: { title: "Waiting.", summary: "Waiting." },
      details_url: RUN_URL,
    });
  });

  test("a success or a failure check is completed with its kind as conclusion, and links to the run", () => {
    for (const kind of ["success", "failure"] as const) {
      expect(checkRunBodyOf("agent-review", SHA, { kind, summary: "Done." }, RUN_URL)).toEqual({
        name: "agent-review",
        head_sha: SHA,
        status: "completed",
        conclusion: kind,
        output: { title: "Done.", summary: "Done." },
        details_url: RUN_URL,
      });
    }
  });
});

describe("checkSetter", () => {
  test("posts the body checkRunBodyOf gives to the repository's check-runs", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    const runUrl = "https://github.com/o/r/actions/runs/42";
    const head = "c".repeat(40);
    const check = { kind: "success", summary: "Landable." } as const;

    await checkSetter(runner)({ ...WHERE, runUrl }, "land-gate", head, check);

    expect(calls).toEqual([
      {
        argv: ["gh", "api", "-X", "POST", "repos/o/r/check-runs", "--input", "-"],
        stdin: JSON.stringify(checkRunBodyOf("land-gate", head, check, runUrl)),
      },
    ]);
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

const ciRuns = (conclusion: string | null, slug = "github-actions") => ({
  check_runs: [{ name: "x", status: conclusion === null ? "in_progress" : "completed", conclusion, app: { slug } }],
});

// An inherited GIT_DIR would point a fixture's git at the real repository; the test layer cannot import fixtureEnv.
const FIXTURE_ENV = Object.fromEntries(
  Object.entries(process.env).flatMap(([name, value]) =>
    name.startsWith("GIT_") || value === undefined ? [] : [[name, value] as const],
  ),
);

/** A `Run` over the fixture's environment, with `base` under the call's own variables. */
const runOver =
  (base: Readonly<Record<string, string>>): Run =>
  async (argv, options) => {
    const child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...FIXTURE_ENV, ...base, ...options.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { code, stdout, stderr };
  };

const fixtureRun = runOver({});

/** A new git repository, and a git that runs in it. */
async function fixtureRepo(prefix: string) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const env = FIXTURE_ENV;

  const git = (args: readonly string[]) => $`git ${args}`.cwd(repo).env(env).quiet();

  await git(["init", "-q"]);
  await git(["config", "user.email", "t@t"]);
  await git(["config", "user.name", "t"]);

  return { repo, git };
}

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
    const { repo, git } = await fixtureRepo("changed-paths-");

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

  test("the deleted paths of a range, renames split, reach the rules for the whole PR and for its Patch delta", async () => {
    const { repo, git } = await fixtureRepo("deleted-paths-");

    const policy: RoutingPolicy = {
      ownerPaths: [],
      factoryPaths: [".claude/**"],
      deepReviewPaths: [],
      lineCap: 400,
    };

    expect(deletedPathsArgs("b", "h")).toEqual(["diff", "--name-only", "--no-renames", "--diff-filter=D", "b..h"]);

    const head = async (): Promise<string> => (await git(["rev-parse", "HEAD"])).text().trim();

    const listed = async (args: readonly string[]): Promise<readonly string[]> =>
      (await git(args))
        .text()
        .split("\n")
        .filter((path) => path !== "");

    const reviewOn = async (from: string, to: string) => {
      const verdict = patchDeltaRulesOf(policy, {
        paths: await listed(changedPathsArgs(from, to)),
        lines: 0,
        deletedPaths: await listed(deletedPathsArgs(from, to)),
        messages: [],
      });

      return verdict.kind === "ruled" ? verdict.answer.review : "judged";
    };

    mkdirSync(join(repo, ".claude/skills/foo"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/foo/SKILL.md"), "s\n");
    writeFileSync(join(repo, ".claude/notes.md"), "n\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "a"]);
    const base = await head();
    await git(["rm", "-q", ".claude/notes.md"]);
    await git(["commit", "-q", "-m", "b"]);
    const deleted = await head();
    await git(["mv", ".claude/skills/foo", ".claude/skills/bar"]);
    await git(["commit", "-q", "-m", "c"]);

    expect(await listed(deletedPathsArgs(deleted, "HEAD"))).toEqual([".claude/skills/foo/SKILL.md"]);
    expect(await reviewOn(base, deleted)).toBe("light");
    expect(await reviewOn(deleted, "HEAD")).toBe("deep");
    expect(await reviewOn(base, "HEAD")).toBe("deep");
  });

  test("the Routing judge is asked about a change no rule names, never about a mixed one, and on a Patch delta only when the delta is judged, reading the whole diff of its range", async () => {
    const { repo, git } = await fixtureRepo("patch-delta-");
    const policy: RoutingPolicy = { ownerPaths: [], factoryPaths: ["scripts/**"], deepReviewPaths: [], lineCap: 400 };

    const commit = async (files: Readonly<Record<string, string>>): Promise<string> => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      }

      await git(["add", "."]);
      await git(["commit", "-q", "-m", "c"]);

      return (await git(["rev-parse", "HEAD"])).text().trim();
    };

    const pathsOf = async (from: string, to: string): Promise<readonly string[]> =>
      (await git(changedPathsArgs(from, to)))
        .text()
        .split("\n")
        .filter((path) => path !== "");

    const rulesOn = async (from: string, to: string) =>
      routingRulesOf(policy, { paths: await pathsOf(from, to), lines: 0, deletedPaths: [], messages: [] });

    const base = await commit({ "README.md": "r\n" });
    const unruled = await commit({ "docs/u.md": "u\n" });

    expect(judgeAskOf(await rulesOn(base, unruled), null)).toEqual({ kind: "ask" });
    expect((await git(judgeDiffArgs(base, unruled, false))).text()).toContain("+u");

    const reviewed = await commit({ ".gitignore": "a\n", "scripts/a.ts": "1\n" });

    expect(judgeAskOf(await rulesOn(base, reviewed), null)).toEqual({ kind: "none" });

    const askOn = async (from: string, head: string) =>
      judgeAskOf(await rulesOn(base, head), await rulesOn(from, head));

    expect(await askOn(reviewed, await commit({ "scripts/a.ts": "2\n" }))).toEqual({ kind: "none" });

    const fixed = await commit({ ".gitignore": "b\n", "scripts/a.ts": "3\n" });

    expect(await askOn(reviewed, fixed)).toEqual({ kind: "none" });

    const head = await commit({ ".gitignore": "c\n", "docs/u.md": "v\n" });

    expect(await askOn(fixed, head)).toEqual({ kind: "ask" });

    const diff = (await git(judgeDiffArgs(fixed, head, false))).text();

    expect(diff).toContain("+c");
    expect(diff).toContain("+v");

    const same = await commit({ "docs/u.md": "u\n" });
    const back = await commit({ "docs/u.md": "v\n" });

    const nothing = patchDeltaRulesOf(policy, {
      paths: await pathsOf(head, back),
      lines: 0,
      deletedPaths: [],
      messages: [],
    });

    expect(same).not.toBe(back);
    expect(judgeAskOf(await rulesOn(base, back), nothing)).toEqual({ kind: "none" });
    expect(routingOf(await rulesOn(base, back), nothing, null).secondRound).toBe(false);
  });

  test("a Patch delta's own line count, from git's numstat over its range, reaches the rules: past the cap it is read again", async () => {
    const { repo, git } = await fixtureRepo("delta-lines-");
    const policy: RoutingPolicy = { ownerPaths: [], factoryPaths: [], deepReviewPaths: [], lineCap: 4 };

    const commit = async (text: string): Promise<string> => {
      writeFileSync(join(repo, "notes.md"), text);
      await git(["add", "."]);
      await git(["commit", "-q", "-m", "c"]);

      return (await git(["rev-parse", "HEAD"])).text().trim();
    };

    const base = await commit("a\n");
    const reviewed = await commit("a\nb\nc\nd\ne\nf\n");
    const small = await commit("a\nb\nc\nd\ne\nF\n");
    const large = await commit("1\n2\n3\n4\n5\n6\n");

    const deltaOf = async (from: string, to: string) =>
      patchDeltaRulesOf(policy, {
        paths: ["notes.md"],
        lines: linesOfNumstat((await git(numstatArgs(from, to))).text()),
        deletedPaths: [],
        messages: [],
      });

    expect(linesOfNumstat((await git(numstatArgs(base, reviewed))).text())).toBe(5);
    expect(linesOfNumstat((await git(numstatArgs(reviewed, small))).text())).toBe(2);
    expect((await deltaOf(reviewed, small)).kind).toBe("judged");
    expect(routingOf(await deltaOf(small, large), await deltaOf(small, large), null).secondRound).toBe(true);
    expect(linesOfNumstat("-\t-\timage.png\n3\t1\ta.ts\n")).toBe(4);
    expect(linesOfNumstat("")).toBe(0);
  });

  test("Review rounds 2 and 3 read the Patch delta from the head the last round read; round 1 the whole PR", () => {
    expect(readsPatchDelta(1)).toBe(false);
    expect(readsPatchDelta(2)).toBe(true);
    expect(readsPatchDelta(3)).toBe(true);
  });

  test("the Merge bot never adds the needs-human label", () => {
    expect(readFileSync(join(import.meta.dir, "main.ts"), "utf8")).not.toContain("needs-human");
  });

  test("a PR whose commits change no file lists no path: its Snapshot is empty", async () => {
    const { repo, git } = await fixtureRepo("empty-change-");

    writeFileSync(join(repo, "README.md"), "r\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "a"]);
    const base = (await git(["rev-parse", "HEAD"])).text().trim();
    writeFileSync(join(repo, "x.ts"), "x\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "b"]);
    await git(["rm", "-q", "x.ts"]);
    await git(["commit", "-q", "-m", "c"]);
    await git(["commit", "-q", "--allow-empty", "-m", "d"]);

    expect((await git(changedPathsArgs(base, "HEAD"))).text()).toBe("");
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

const checkRun = (status: string, conclusion: string | null) => ({
  check_runs: [{ name: "x", status, conclusion, app: { slug: "github-actions" } }],
});

const NO_CHECK_RUN = { check_runs: [] };

describe("devRedOf", () => {
  test("validate and mutation completed success: dev is not red", () => {
    expect(devRedOf([checkRun("completed", "success"), checkRun("completed", "success")])).toBe(false);
  });

  test("validate completed failure: dev is red, whatever mutation is", () => {
    expect(devRedOf([checkRun("completed", "failure"), checkRun("in_progress", null)])).toBe(true);
  });

  test("mutation completed failure after a green validate: dev is red", () => {
    expect(devRedOf([checkRun("completed", "success"), checkRun("completed", "failure")])).toBe(true);
  });

  test("validate completed cancelled: dev is red, whatever mutation is", () => {
    expect(devRedOf([checkRun("completed", "cancelled"), NO_CHECK_RUN])).toBe(true);
  });

  test("mutation still running after a green validate: dev is not red", () => {
    expect(devRedOf([checkRun("completed", "success"), checkRun("in_progress", null)])).toBe(false);
  });

  test("no check run posted yet: dev is not red", () => {
    expect(devRedOf([NO_CHECK_RUN, NO_CHECK_RUN])).toBe(false);
  });
});

describe("devRunsReader", () => {
  const DEV_HEAD = "43e27e7".padEnd(40, "0");

  /** `origin/dev` is DEV_HEAD, its CI check runs are green, and every workflow run, the Merge bot's among them, failed. */
  function devRunner() {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      if (argv[0] === "git") {
        return Promise.resolve(ok(`${DEV_HEAD}\n`));
      }

      const failedRuns = { workflow_runs: [{ name: "merge-bot", conclusion: "failure" }] };
      const answer = (argv.at(-1) ?? "").includes("/actions/runs") ? failedRuns : checkRun("completed", "success");

      return Promise.resolve(ok(JSON.stringify(answer)));
    };

    return { runner, calls };
  }

  test("reads validate and mutation on origin/dev's head, never a workflow run, so a failed Merge bot run is not read", async () => {
    const { runner, calls } = devRunner();

    const runs = await devRunsReader(runner)(WHERE);

    expect(calls).toEqual([
      ["git", "rev-parse", "origin/dev"],
      ...ciRunsPathsOf("o/r", DEV_HEAD).map((path) => ["gh", "api", "-X", "GET", path]),
    ]);
    expect(devRedOf(runs)).toBe(false);
  });
});

/** A repository whose checkout sits on its first commit, and the head of a PR one commit past it. */
async function prRepo() {
  const { repo, git } = await fixtureRepo("judge-worktree-");

  mkdirSync(join(repo, "app/src"), { recursive: true });
  writeFileSync(join(repo, "app/src/cli.ts"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "a"]);
  writeFileSync(join(repo, "app/src/cli.ts"), "head\n");
  await git(["commit", "-q", "-am", "b"]);
  const head = (await git(["rev-parse", "HEAD"])).text().trim();
  await git(["checkout", "-q", "--detach", "HEAD~1"]);

  const worktrees = async (): Promise<number> =>
    (await git(["worktree", "list", "--porcelain"]))
      .text()
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;

  return { checkout: { run: fixtureRun, cwd: repo, head }, worktrees };
}

/** A git that refuses to remove a worktree. */
const refusingRemoval: Run = (argv, options) =>
  argv.includes("remove") ? Promise.resolve({ code: 1, stdout: "", stderr: "locked" }) : fixtureRun(argv, options);

describe("the Routing judge's worktree", () => {
  const JOB = { PATH: "/usr/bin", HOME: "/home/runner", CLAUDE_CODE_OAUTH_TOKEN: "oauth", GH_TOKEN: "app" };

  const ANSWER = {
    routing: { land: "auto", review: "light", secondRound: false, reason: "r", model: "m" },
    tokens: { input: 2, output: 58, cacheRead: 1568, cacheCreation: 6770 },
  } as const;

  const answering = (reader: Reader): Promise<typeof ANSWER> => {
    expect(reader.cwd).not.toBe("");

    return Promise.resolve(ANSWER);
  };

  test("no question makes no worktree and asks nothing", async () => {
    const { checkout, worktrees } = await prRepo();
    const readers: Reader[] = [];

    const answer = await judgeAt({ kind: "none" }, checkout, JOB, (reader) => {
      readers.push(reader);

      return Promise.resolve(ANSWER);
    });

    expect(answer).toBeNull();
    expect(readers).toEqual([]);
    expect(await worktrees()).toBe(1);
  });

  test("the judge reads a worktree of the PR's head under the read guard, with no GitHub token, and the worktree goes after the call", async () => {
    const { checkout, worktrees } = await prRepo();
    const readers: Reader[] = [];
    const seen: string[] = [];

    const answer = await judgeAt({ kind: "ask" }, checkout, JOB, async (reader) => {
      readers.push(reader);
      seen.push(
        readFileSync(join(reader.cwd, "app/src/cli.ts"), "utf8"),
        String(await worktrees()),
        String(existsSync(reader.env.CLAUDE_CONFIG_DIR ?? "")),
        reader.guard("Read", { file_path: "app/src/cli.ts" }).kind,
        reader.guard("Read", { file_path: join(checkout.cwd, "app/src/cli.ts") }).kind,
        reader.guard("Read", { file_path: ".git" }).kind,
      );

      return ANSWER;
    });

    const [reader] = readers;

    expect(answer).toEqual(ANSWER);
    expect(seen).toEqual(["head\n", "2", "true", "allow", "deny", "deny"]);
    expect(reader?.cwd).not.toBe(checkout.cwd);
    expect(Object.keys(reader?.env ?? {}).toSorted()).toEqual([
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "PATH",
    ]);
    expect(reader?.guard("Write", {})).toEqual({ kind: "deny", reason: "the tool Write is not admitted here" });
    expect(existsSync(reader?.cwd ?? checkout.cwd)).toBe(false);
    expect(existsSync(reader?.env.CLAUDE_CONFIG_DIR ?? checkout.cwd)).toBe(false);
    expect(existsSync(dirname(reader?.cwd ?? checkout.cwd))).toBe(false);
    expect(await worktrees()).toBe(1);
  });

  test("a failed call answers the safe side with its own error, even when the removal fails too, and leaves no worktree", async () => {
    const { checkout, worktrees } = await prRepo();
    const roots: string[] = [];

    const failing = (reader: Reader): Promise<never> => {
      roots.push(reader.cwd);

      return Promise.reject(new Error("the judge broke"));
    };

    expect(await judgeAt({ kind: "ask" }, checkout, JOB, failing)).toMatchObject({
      routing: { review: "deep", secondRound: true, reason: "the Routing judge failed: the judge broke" },
      tokens: null,
    });
    expect(existsSync(roots[0] ?? checkout.cwd)).toBe(false);
    expect(await worktrees()).toBe(1);

    expect(await judgeAt({ kind: "ask" }, { ...checkout, run: refusingRemoval }, JOB, failing)).toMatchObject({
      routing: { reason: "the Routing judge failed: the judge broke" },
    });
    expect(await worktrees()).toBe(1);
  });

  test("a removal that fails after the judge answered keeps the answer, and the worktree is pruned", async () => {
    const { checkout, worktrees } = await prRepo();

    expect(await judgeAt({ kind: "ask" }, { ...checkout, run: refusingRemoval }, JOB, answering)).toEqual(ANSWER);
    expect(await worktrees()).toBe(1);
  });

  test("a worktree or an environment that cannot be made answers the safe side, so the Sweep goes on", async () => {
    const { checkout, worktrees } = await prRepo();

    expect(
      await judgeAt({ kind: "ask" }, checkout, { ...JOB, CLAUDE_CODE_OAUTH_TOKEN: undefined }, answering),
    ).toMatchObject({
      routing: {
        review: "deep",
        secondRound: true,
        reason: "the Routing judge failed: CLAUDE_CODE_OAUTH_TOKEN is unset",
      },
      tokens: null,
    });
    expect(await worktrees()).toBe(1);

    const unknown = await judgeAt({ kind: "ask" }, { ...checkout, head: "f".repeat(40) }, JOB, answering);

    expect(unknown).toMatchObject({ routing: { review: "deep", secondRound: true }, tokens: null });
    expect(unknown?.routing.reason).toStartWith("the Routing judge failed: git worktree add exited");
  });

  test("the checkout runs no filter driver of the runner's system or global git config, LFS included, and no hook", async () => {
    const { repo, git } = await fixtureRepo("judge-filters-");
    const marks = mkdtempSync(join(tmpdir(), "judge-marks-"));
    const globalConfig = join(marks, "gitconfig");
    const systemConfig = join(marks, "system-gitconfig");
    const hooks = join(marks, "hooks");

    const filter = (name: string): string =>
      `[filter "${name}"]\n\tsmudge = sh -c 'touch ${join(marks, `${name}-ran`)}; cat'\n\trequired = true\n`;

    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${join(marks, "hook-ran")}\n`, { mode: 0o755 });
    writeFileSync(globalConfig, filter("evil"));
    writeFileSync(systemConfig, filter("lfs"));
    await git(["config", "core.hooksPath", hooks]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await git(["add", "."]);
    await git(["commit", "-q", "--no-verify", "-m", "a"]);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n*.bin filter=lfs\n");
    writeFileSync(join(repo, "a.txt"), "b\n");
    writeFileSync(join(repo, "b.bin"), "c\n");
    await git(["add", "."]);
    await git(["commit", "-q", "--no-verify", "-m", "b"]);
    const head = (await git(["rev-parse", "HEAD"])).text().trim();

    const checkout = {
      run: runOver({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: systemConfig }),
      cwd: repo,
      head,
    };

    expect(await judgeAt({ kind: "ask" }, checkout, JOB, answering)).toEqual(ANSWER);
    expect(existsSync(join(marks, "evil-ran"))).toBe(false);
    expect(existsSync(join(marks, "lfs-ran"))).toBe(false);
    expect(existsSync(join(marks, "hook-ran"))).toBe(false);
  });

  test("the judge's environment holds the job's PATH, HOME and OAuth token, no memory and the given config, and nothing else", () => {
    expect(judgeEnvOf(JOB, "/tmp/config")).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CONFIG_DIR: "/tmp/config",
    });
    expect(() => judgeEnvOf({ ...JOB, HOME: "" }, "/tmp/config")).toThrow("HOME is unset");
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
