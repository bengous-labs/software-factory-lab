import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { FIXED_MARK } from "../author-mark.ts";
import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import type { Reader } from "../ports/ask.ts";
import type { Ran, Run } from "../ports/run.ts";
import { resultOf } from "../review/review-report.ts";
import { judgeAskOf, patchDeltaRulesOf, routingOf, routingRulesOf } from "../routing/routing-rules.ts";
import type { LedgerFinding } from "../shared/finding.ts";
import { fixedRecordBodyOf, questionCommentOf } from "../stop/decide.ts";
import { EMPTY_RECORD, stateBodyOf, stateCommentOf } from "./decide.ts";
import type { LedgerInputs, ReviewState, StateRead, StateRecord, Step } from "./decide.ts";
import {
  ActionsRun,
  againPoster,
  changedPathsArgs,
  checkRunBodyOf,
  CheckRuns,
  checkSetter,
  CheckSuites,
  ciOfRuns,
  ciRunsPathsOf,
  CommitPulls,
  conversationReader,
  deletedPathsArgs,
  devRedOf,
  devRunsReader,
  Dispatched,
  draftConverter,
  humanLabelByOf,
  IssueComments,
  IssueEvents,
  issueOpener,
  judgeAt,
  judgeDiffArgs,
  judgeEnvOf,
  labelEventsReader,
  landApprovalByOwnerOf,
  landApprovalPutByOwnerOf,
  latestReviewAtOf,
  linesOfNumstat,
  ListedPrs,
  notFound,
  numstatArgs,
  openedByFactoryOf,
  ownerCommenter,
  Pull,
  PullReviews,
  rangeRefspecsOf,
  readsPatchDelta,
  reviewJobReader,
  reviewsReader,
  routingLineOf,
  routingPolicyAt,
  startOf,
  stateCommentIn,
  stateWriter,
  stepsDone,
  threadsResolver,
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

/** The times a Land approval is weighed against: the head pushed at `headPushedAt`, and no review of the App. */
const pushedAt = (headPushedAt: string | null) => ({ headPushedAt, reviewedAt: null });

/** A Delta read's review of the PR by `login`, with its marker, posted at `submittedAt`, null while pending. */
const reviewBy = (login: string, submittedAt: string | null) => ({
  user: { login },
  body: "Delta read: 1 Important.\n\n<!-- lab-review patch=p1 round=4 -->",
  submitted_at: submittedAt,
});

/** A reply `login` posted in a thread at `submittedAt`, which GitHub lists as a review with an empty body. */
const replyBy = (login: string, submittedAt: string) => ({ user: { login }, body: "", submitted_at: submittedAt });

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
        JSON.stringify({
          check_runs: [
            { name: "validate", status: "queued", conclusion: null, app: { slug: "a" }, check_suite: { id: 1 } },
          ],
        }),
      ).check_runs,
    ).toHaveLength(1);
    expect(decodeJson(CheckSuites, "suites", JSON.stringify({ check_suites: [] })).check_suites).toEqual([]);
    expect(
      decodeJson(
        CheckSuites,
        "suites",
        JSON.stringify({ check_suites: [{ id: 1, head_branch: null, created_at: "t" }] }),
      ).check_suites,
    ).toEqual([{ id: 1, head_branch: null, created_at: "t" }]);
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
      decodeJson(
        PullReviews,
        "reviews",
        JSON.stringify([{ id: 1, user: null, body: "b", state: "COMMENTED", submitted_at: "2026-11-05T11:00:00Z" }]),
      ),
    ).toEqual([{ user: null, body: "b", submitted_at: "2026-11-05T11:00:00Z" }]);
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

    expect(landApprovalByOwnerOf(events, "owner", pushedAt("2026-11-05T10:00:00Z"))).toBe(true);
    expect(landApprovalByOwnerOf(events, "owner", pushedAt("2026-11-05T12:00:00Z"))).toBe(false);
    expect(landApprovalByOwnerOf(events, "someone", pushedAt("2026-11-05T10:00:00Z"))).toBe(false);
    expect(landApprovalPutByOwnerOf(events, "owner")).toBe(true);
    expect(landApprovalPutByOwnerOf(events, "someone")).toBe(false);

    const byGhost = decodeJson(
      IssueEvents,
      "events",
      JSON.stringify([
        { event: "labeled", label: { name: "land-ok" }, actor: null, created_at: "2026-11-05T11:00:00Z" },
      ]),
    );

    expect(landApprovalByOwnerOf(byGhost, "owner", pushedAt(null))).toBe(false);

    const runs = JSON.stringify({
      check_runs: [{ name: "validate", status: "completed", conclusion: "success", app: null, check_suite: { id: 1 } }],
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
      [PullReviews, [{ user: null, body: "b" }]],
    ];

    for (const [schema, answer] of refused) {
      expect(Result.isFailure(Schema.decodeUnknownResult(schema)(answer))).toBe(true);
    }
  });
});

describe("a Land approval and the App's reviews", () => {
  const APP = "bengous-labs-agents[bot]";

  const events = decodeJson(
    IssueEvents,
    "events",
    JSON.stringify([
      { event: "labeled", label: { name: "land-ok" }, actor: { login: "owner" }, created_at: "2026-11-05T11:00:00Z" },
    ]),
  );

  test("the App's latest review is its last submitted one, whatever the order GitHub lists them in; another login's or a pending one is none", () => {
    expect(
      latestReviewAtOf(
        [
          reviewBy(APP, "2026-11-05T11:30:00Z"),
          reviewBy(APP, "2026-11-05T09:00:00Z"),
          reviewBy("bengous", "2026-11-05T12:00:00Z"),
          reviewBy(APP, null),
        ],
        APP,
      ),
    ).toBe("2026-11-05T11:30:00Z");
    expect(latestReviewAtOf([reviewBy("bengous", "2026-11-05T12:00:00Z")], APP)).toBeNull();
    expect(latestReviewAtOf([], APP)).toBeNull();
  });

  test("a reply the App posts in a thread, which GitHub lists as a review with no marker, is no new read: the landing's own replies void no approval", () => {
    const reviews = [
      reviewBy(APP, "2026-11-05T10:30:00Z"),
      replyBy(APP, "2026-11-05T11:05:00Z"),
      { ...reviewBy(APP, "2026-11-05T11:10:00Z"), body: "A human-looking review with no marker." },
    ];

    const reviewedAt = latestReviewAtOf(reviews, APP);

    expect(reviewedAt).toBe("2026-11-05T10:30:00Z");
    expect(landApprovalByOwnerOf(events, "owner", { headPushedAt: "2026-11-05T10:00:00Z", reviewedAt })).toBe(true);
  });

  test("a land-ok the Owner put before the App's latest review was posted does not count: the Owner could not read it", () => {
    const headPushedAt = "2026-11-05T10:00:00Z";

    expect(landApprovalByOwnerOf(events, "owner", { headPushedAt, reviewedAt: "2026-11-05T11:30:00Z" })).toBe(false);
    expect(landApprovalByOwnerOf(events, "owner", { headPushedAt, reviewedAt: "2026-11-05T10:30:00Z" })).toBe(true);
    expect(landApprovalPutByOwnerOf(events, "owner")).toBe(true);
  });

  test("every page of the PR's reviews is read, so the latest past the first hundred is found", async () => {
    const pages = [[reviewBy(APP, "2026-11-05T09:00:00Z")], [reviewBy(APP, "2026-11-05T11:30:00Z")]];
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: JSON.stringify(pages), stderr: "" });
    };

    const reviews = await reviewsReader(runner)(WHERE, 12);

    expect(calls).toEqual([
      ["gh", "api", "-X", "GET", "--paginate", "--slurp", "repos/o/r/pulls/12/reviews?per_page=100"],
    ]);
    expect(latestReviewAtOf(reviews, APP)).toBe("2026-11-05T11:30:00Z");
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

    expect(landApprovalByOwnerOf(events, "bengous", pushedAt("2026-11-05T10:00:00Z"))).toBe(false);
  });
});

/** The conversation comments of `listed`, each its id, its author's login and its body. */
const commentsOf = (...listed: ReadonlyArray<readonly [number, string, string]>): typeof IssueComments.Type =>
  listed.map(([id, login, body]) => ({ id, user: { login }, body }));

describe("stateCommentIn", () => {
  const logins = { appLogin: "bengous-labs-agents[bot]", authorLogin: "bengous-labs-author" };
  const record = { ...EMPTY_RECORD, reviewRounds: 2 };
  const state = stateCommentOf(record, "**Review findings**: none.");
  const fixed = fixedRecordBodyOf({ comment: null, fixed: [] }, ["T1", "T2"]) ?? "";

  test("reads the App's state comment, its ledger included, and the threads the Author's record says it fixed", () => {
    expect(
      stateCommentIn(
        commentsOf([1, "bengous", "hello"], [2, logins.appLogin, state], [3, logins.authorLogin, fixed]),
        logins,
      ),
    ).toEqual({ id: 2, body: state, record, fixed: new Set(["T1", "T2"]) });
  });

  test("a mark another login wrote is not read: no state comment, nothing fixed", () => {
    expect(
      stateCommentIn(commentsOf([1, "someone", state], [2, "someone", fixed], [3, logins.appLogin, fixed]), logins),
    ).toEqual({ id: null, body: null, record: EMPTY_RECORD, fixed: new Set() });
  });

  test("the Author's question that quotes the fixed mark in a code span is no record; the record after it is read", () => {
    const question = questionCommentOf(`Keep \`${FIXED_MARK} T9 -->\`?`, "feat/7-x", "S1");

    expect(stateCommentIn(commentsOf([1, logins.authorLogin, question]), logins).fixed).toEqual(new Set());
    expect(
      stateCommentIn(commentsOf([1, logins.authorLogin, question], [2, logins.authorLogin, fixed]), logins).fixed,
    ).toEqual(new Set(["T1", "T2"]));
  });
});

/** `count` comments of the Owner, numbered from `from`. */
const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: from + index, user: { login: "bengous" }, body: "hello" }));

describe("conversationReader", () => {
  test("reads every page of the PR's conversation, so the Author's record past the first 100 comments is found", async () => {
    const record = fixedRecordBodyOf({ comment: null, fixed: [] }, ["T1"]) ?? "";
    const pages = [page(1, 100), [...page(101, 5), { id: 106, user: { login: "bengous-labs-author" }, body: record }]];
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: JSON.stringify(pages), stderr: "" });
    };

    const comments = await conversationReader(runner)(WHERE, 12);

    expect(calls).toEqual([
      ["gh", "api", "-X", "GET", "--paginate", "--slurp", "repos/o/r/issues/12/comments?per_page=100"],
    ]);
    expect(comments).toHaveLength(106);
    expect(
      stateCommentIn(comments, { appLogin: "bengous-labs-agents[bot]", authorLogin: "bengous-labs-author" }).fixed,
    ).toEqual(new Set(["T1"]));
  });
});

/** An open Important of round 1, as the ledger reads its thread. */
const OPEN_IMPORTANT: LedgerFinding = {
  thread: "T1",
  url: "https://github.com/o/r/pull/12#discussion_r1",
  where: "a.ts:3",
  file: "a.ts",
  severity: "important",
  security: false,
  summary: "off by one",
  round: 1,
  resolved: false,
  closedByApp: false,
  landedOpen: false,
  outdated: false,
  rejection: null,
  ownerAnswer: null,
  again: [],
};

const OPEN: LedgerInputs = { findings: [OPEN_IMPORTANT], fixed: new Set() };

/** The same Important, its thread closed by the App. */
const CLOSED: LedgerInputs = { findings: [{ ...OPEN_IMPORTANT, resolved: true, closedByApp: true }], fixed: new Set() };

const ROUND_1: StateRecord = { ...EMPTY_RECORD, reviewedPatch: "p1", reviewRounds: 1, importantByRound: [1] };

/** What a run of `stepsDone` over fakes did: whether to decide again, each write with the id it named, and how often it read the findings. */
interface StepsRun {
  readonly decideAgain: boolean;
  readonly writes: ReadonlyArray<{ readonly id: number | null; readonly body: string }>;
  readonly reads: number;
}

/**
 * `steps` done over the state comment `read`, from `record` and `inputs`: a `record` step writes its
 * record, a `route` step a routed one, a `follow-up` step one with issue 31, the step of kind `stopAt`
 * stops the run, and any other changes nothing. The findings read again are `reread`; a new comment gets id 99.
 */
async function stepsRun(
  steps: readonly Step[],
  start: { readonly read: StateRead; readonly record: StateRecord; readonly inputs: LedgerInputs },
  { reread, stopAt = null }: { readonly reread: LedgerInputs; readonly stopAt?: Step["kind"] | null },
): Promise<StepsRun> {
  const writes: Array<{ id: number | null; body: string }> = [];
  let reads = 0;

  const decideAgain = await stepsDone(steps, start, {
    perform: async (step, record, write) => {
      if (step.kind === stopAt) {
        return null;
      }

      const next =
        step.kind === "record"
          ? step.record
          : step.kind === "route"
            ? { ...record, triage: { [step.patch]: ROUTED } }
            : step.kind === "follow-up"
              ? { ...record, followUpIssue: 31 }
              : record;

      if (next !== record) {
        await write(next);
      }

      return next;
    },
    findings: () => {
      reads += 1;

      return Promise.resolve(reread.findings);
    },
    write: (id, body) => {
      writes.push({ id, body });

      return Promise.resolve(id ?? 99);
    },
  });

  return { decideAgain, writes, reads };
}

const ROUTED = {
  land: "auto",
  review: "light",
  secondRound: false,
  reason: "ordinary code",
  model: null,
} as const;

describe("stepsDone", () => {
  const check = { kind: "success", summary: "ok" } as const;

  test("the Owner's Land approval lands the open Importants open and no decision follows: the follow-up issue is recorded, the findings are read again and the comment shows them landed open", async () => {
    const steps: Step[] = [
      { kind: "labels", route: "owner", depth: "light" },
      { kind: "follow-up", threads: ["T1"] },
      { kind: "land-open", threads: ["T1"] },
      { kind: "review-check", check },
      { kind: "land-gate", check },
      { kind: "auto-merge" },
    ];

    const landed: LedgerInputs = {
      findings: [{ ...OPEN_IMPORTANT, resolved: true, closedByApp: true, landedOpen: true }],
      fixed: new Set(),
    };

    const followed: StateRecord = { ...ROUND_1, followUpIssue: 31 };

    const run = await stepsRun(
      steps,
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: landed },
    );

    expect(run.reads).toBe(1);
    expect(run.writes).toEqual([
      { id: 7, body: stateBodyOf(followed, OPEN) },
      { id: 7, body: stateBodyOf(followed, landed) },
    ]);
    expect(run.writes[1]?.body).toContain("**Landed open by the Owner's Land approval.** Important");
    expect(run.decideAgain).toBe(false);
  });

  test("a round's record is written once, with the ledger of the rounds it counts and the threads the round resolved", async () => {
    const round2: StateRecord = { ...ROUND_1, reviewedPatch: "p2", reviewRounds: 2, importantByRound: [1, 0] };

    const steps: Step[] = [
      { kind: "resolve-threads", threads: ["T1"] },
      { kind: "to-draft" },
      { kind: "record", record: round2 },
      { kind: "review-check", check },
    ];

    const run = await stepsRun(
      steps,
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.writes).toEqual([{ id: 7, body: stateBodyOf(round2, CLOSED) }]);
    expect(run.writes[0]?.body).toContain("**Fixed, confirmed by round 2.** Important");
    expect(run.decideAgain).toBe(false);
  });

  test("a PR with no comment gets one from the first step that writes a record, and the steps after it edit that comment", async () => {
    const recorded: StateRecord = { ...ROUND_1, triage: { p1: ROUTED }, landOkPatch: "p1" };

    const run = await stepsRun(
      [
        { kind: "route", patch: "p1", patchDelta: false },
        { kind: "record", record: recorded },
      ],
      { read: { id: null, body: null, record: EMPTY_RECORD }, record: EMPTY_RECORD, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.writes.map((write) => write.id)).toEqual([null, 99]);
    expect(run.writes.at(-1)?.body).toBe(stateBodyOf(recorded, OPEN));
    expect(run.reads).toBe(0);
    expect(run.decideAgain).toBe(true);
  });

  test("the ledger is written before the steps when only what it shows changed; a step that stops the run writes nothing after it, and no decision follows", async () => {
    const routed: StateRecord = { ...ROUND_1, triage: { p1: ROUTED } };

    const run = await stepsRun(
      [
        { kind: "route", patch: "p1", patchDelta: false },
        { kind: "resolve-threads", threads: ["T1"] },
        { kind: "to-draft" },
        { kind: "auto-merge" },
      ],
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: CLOSED },
      { reread: OPEN, stopAt: "to-draft" },
    );

    expect(run.writes).toEqual([
      { id: 7, body: stateBodyOf(ROUND_1, CLOSED) },
      { id: 7, body: stateBodyOf(routed, CLOSED) },
    ]);
    expect(run.decideAgain).toBe(false);
  });

  test("nothing is written when the comment holds the record and the ledger already", async () => {
    const run = await stepsRun(
      [{ kind: "to-draft" }],
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.writes).toEqual([]);
  });
});

describe("stateWriter", () => {
  test("edits the comment it names, or posts a new one and gives the id GitHub answers", async () => {
    const calls: Array<{ argv: string[]; body: string }> = [];

    const runner: Run = (argv, options) => {
      calls.push({
        argv: [...argv],
        body: decodeJson(Schema.Struct({ body: Schema.String }), "a write", options.stdin ?? "").body,
      });

      return Promise.resolve({
        code: 0,
        stdout: argv[3] === "POST" ? '{"id":4242,"body":"x"}' : "not json",
        stderr: "",
      });
    };

    expect(await stateWriter(runner)(WHERE, 12, 7, "edited")).toBe(7);
    expect(await stateWriter(runner)(WHERE, 12, null, "posted")).toBe(4242);
    expect(calls).toEqual([
      { argv: ["gh", "api", "-X", "PATCH", "repos/o/r/issues/comments/7", "--input", "-"], body: "edited" },
      { argv: ["gh", "api", "-X", "POST", "repos/o/r/issues/12/comments", "--input", "-"], body: "posted" },
    ]);
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

  const LOGINS = { appLogin: BOT, authorLogin: "bengous-labs-author" };

  test("no land:human on the PR is null, whatever the events say", () => {
    expect(humanLabelByOf([labeled("land:human", BOT, "2026-11-05T10:00:00Z")], ["land:auto"], LOGINS)).toBeNull();
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

    expect(humanLabelByOf(botLast, ["land:human"], LOGINS)).toBe("merge-bot");
    expect(humanLabelByOf(ownerLast, ["land:human"], LOGINS)).toBe("other");
  });

  test("the Author's machine account's label is an agent's: it is told apart from another login's", () => {
    const authorLast = [
      labeled("land:human", "owner", "2026-11-05T10:00:00Z"),
      labeled("land:human", "bengous-labs-author", "2026-11-05T11:00:00Z"),
    ];

    expect(humanLabelByOf(authorLast, ["land:human"], LOGINS)).toBe("author");
    expect(humanLabelByOf(authorLast.toReversed(), ["land:human"], LOGINS)).toBe("other");
  });

  test("a land:human on the PR whose latest event is its removal is a read that lags: another login", () => {
    const lagging = [
      labeled("land:human", BOT, "2026-11-05T10:00:00Z"),
      { ...labeled("land:human", BOT, "2026-11-05T11:00:00Z"), event: "unlabeled" },
    ];

    expect(humanLabelByOf(lagging, ["land:human"], LOGINS)).toBe("other");
  });

  test("an unreadable actor, or no labeled event of land:human, is another login: the safe side", () => {
    expect(humanLabelByOf([labeled("land:human", null, "2026-11-05T10:00:00Z")], ["land:human"], LOGINS)).toBe("other");
    expect(humanLabelByOf([labeled("land-ok", BOT, "2026-11-05T10:00:00Z")], ["land:human"], LOGINS)).toBe("other");
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
    expect(humanLabelByOf(events, ["land:human"], { appLogin: "agents[bot]", authorLogin: "author" })).toBe(
      "merge-bot",
    );
  });
});

/** A runner every command of which succeeds with an empty JSON object. */
const answersEmpty: Run = () => Promise.resolve({ code: 0, stdout: "{}", stderr: "" });

describe("issueOpener", () => {
  test("opens the issue on the repository with its title and body as they are, and answers its number", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: JSON.stringify({ number: 31, title: "t" }), stderr: "" });
    };

    const issue = { title: "Follow up #12: Important findings landed open", body: "- Important in `a.ts`" };

    expect(await issueOpener(runner)(WHERE, issue)).toBe(31);
    expect(calls).toEqual([
      { argv: ["gh", "api", "-X", "POST", "repos/o/r/issues", "--input", "-"], stdin: JSON.stringify(issue) },
    ]);
  });

  test("an answer with no issue number fails, naming the endpoint", () => {
    expect(issueOpener(answersEmpty)(WHERE, { title: "t", body: "b" })).rejects.toThrow("gh api repos/o/r/issues");
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

  test("a placeholder is escaped in the Markdown summary, and kept as written in the plain-text title", () => {
    expect(
      checkRunBodyOf("land-gate", SHA, { kind: "pending", summary: "Held for the Owner: <file>." }, RUN_URL)["output"],
    ).toEqual({ title: "Held for the Owner: <file>.", summary: String.raw`Held for the Owner: &lt;file>.` });
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

/** A runner whose every command GitHub refuses. */
const REFUSED: Run = () => Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 502" });

describe("draftConverter", () => {
  test("sends the PR back to draft with one GraphQL mutation that names its node id", async () => {
    const calls: Array<{ argv: string[]; stdin: string | undefined }> = [];

    const runner: Run = (argv, options) => {
      calls.push({ argv: [...argv], stdin: options.stdin });

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await draftConverter(runner)(WHERE, "PR_node1");

    expect(calls).toEqual([
      {
        argv: ["gh", "api", "-X", "POST", "graphql", "--input", "-"],
        stdin: JSON.stringify({
          query: "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}",
          variables: { id: "PR_node1" },
        }),
      },
    ]);
  });

  test("a conversion GitHub refuses throws, so the round is not recorded and a later run sends the PR back again", () => {
    expect(draftConverter(REFUSED)(WHERE, "PR_node1")).rejects.toThrow("gh api -X exited 1: HTTP 502");
  });
});

describe("threadsResolver", () => {
  test("resolves each thread, in its order, and stops at the first GitHub refuses", async () => {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve(
        argv.includes("id=T2") ? { code: 1, stdout: "", stderr: "HTTP 502" } : { code: 0, stdout: "{}", stderr: "" },
      );
    };

    await threadsResolver(runner)(WHERE, ["T1"]);

    expect(calls).toEqual([
      [
        "gh",
        "api",
        "graphql",
        "-f",
        "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
        "-f",
        "id=T1",
      ],
    ]);
    expect(threadsResolver(runner)(WHERE, ["T2", "T3"])).rejects.toThrow("gh api graphql exited 1: HTTP 502");
    expect(calls.some((call) => call.includes("id=T3"))).toBe(false);
  });
});

describe("againPoster", () => {
  test("posts each reply in its review thread, in its order", async () => {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    await againPoster(runner)(WHERE, [
      { thread: "T1", body: "still wrong" },
      { thread: "T2", body: "again" },
    ]);

    const reply =
      "query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}";

    expect(calls).toEqual([
      ["gh", "api", "graphql", "-f", reply, "-f", "id=T1", "-f", "body=still wrong"],
      ["gh", "api", "graphql", "-f", reply, "-f", "id=T2", "-f", "body=again"],
    ]);
  });

  test("a reply GitHub refuses throws, so the round is not recorded and a later run posts what is left", () => {
    expect(againPoster(REFUSED)(WHERE, [{ thread: "T1", body: "still wrong" }])).rejects.toThrow(
      "gh api graphql exited 1: HTTP 502",
    );
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

type CheckRun = (typeof CheckRuns.Type)["check_runs"][number];

const runIn = (suite: number, status: string, conclusion: string | null, slug = "github-actions"): CheckRun => ({
  name: "x",
  status,
  conclusion,
  app: { slug },
  check_suite: { id: suite },
});

const checkRun = (status: string, conclusion: string | null) => ({ check_runs: [runIn(1, status, conclusion)] });

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

  const QUEUE_SUITE = 1;
  const PUSH_SUITE = 2;
  const APP_SUITE = 3;

  /** The merge queue's suite, CI's push suite and the App's suite on DEV_HEAD. */
  const SUITES = {
    check_suites: [
      { id: QUEUE_SUITE, head_branch: "gh-readonly-queue/dev/pr-1-a", created_at: "t" },
      { id: PUSH_SUITE, head_branch: "dev", created_at: "t" },
      { id: APP_SUITE, head_branch: "dev", created_at: "t" },
    ],
  };

  /** `origin/dev` is DEV_HEAD, with SUITES, and `validate` and `mutation` answer these check runs, the queue's listed first. */
  function devRunner(validate: readonly CheckRun[], mutation: readonly CheckRun[]) {
    const calls: string[][] = [];

    const runner: Run = (argv) => {
      calls.push([...argv]);

      if (argv[0] === "git") {
        return Promise.resolve(ok(argv[1] === "rev-parse" ? `${DEV_HEAD}\n` : ""));
      }

      const path = argv.at(-1) ?? "";

      const answer = path.includes("/check-suites")
        ? SUITES
        : { check_runs: path.endsWith("=validate") ? validate : mutation };

      return Promise.resolve(ok(JSON.stringify(answer)));
    };

    return { runner, calls };
  }

  test("rangeOf fetches dev once, beside the PR's base when that is another branch", () => {
    expect(rangeRefspecsOf({ number: 12, base: { ref: "dev" } })).toEqual([
      "+refs/pull/12/head:refs/lab/pr-12",
      "+refs/heads/dev:refs/remotes/origin/dev",
    ]);
    expect(rangeRefspecsOf({ number: 12, base: { ref: "main" } })).toEqual([
      "+refs/pull/12/head:refs/lab/pr-12",
      "+refs/heads/main:refs/remotes/origin/main",
      "+refs/heads/dev:refs/remotes/origin/dev",
    ]);
  });

  test("reads origin/dev's check suites and validate and mutation on its head, and no workflow run", async () => {
    const { runner, calls } = devRunner(
      [runIn(PUSH_SUITE, "completed", "success")],
      [runIn(PUSH_SUITE, "completed", "success")],
    );

    const runs = await devRunsReader(runner)(WHERE);

    expect(calls).toEqual([
      ["git", "rev-parse", "origin/dev"],
      ["gh", "api", "-X", "GET", `repos/o/r/commits/${DEV_HEAD}/check-suites?per_page=100`],
      ...ciRunsPathsOf("o/r", DEV_HEAD).map((path) => ["gh", "api", "-X", "GET", path]),
    ]);
    expect(devRedOf(runs)).toBe(false);
  });

  test("the merge queue's skipped mutation, listed first, does not read as red", async () => {
    const { runner } = devRunner(
      [runIn(QUEUE_SUITE, "completed", "success"), runIn(PUSH_SUITE, "completed", "success")],
      [runIn(QUEUE_SUITE, "completed", "skipped"), runIn(PUSH_SUITE, "in_progress", null)],
    );

    expect(devRedOf(await devRunsReader(runner)(WHERE))).toBe(false);
  });

  test("the merge queue's green validate, listed first, does not hide a red push validate", async () => {
    const { runner } = devRunner(
      [runIn(QUEUE_SUITE, "completed", "success"), runIn(PUSH_SUITE, "completed", "failure")],
      [runIn(QUEUE_SUITE, "completed", "skipped"), runIn(PUSH_SUITE, "completed", "success")],
    );

    expect(devRedOf(await devRunsReader(runner)(WHERE))).toBe(true);
  });

  test("a red run in another app's suite on dev is not read", async () => {
    const { runner } = devRunner(
      [runIn(APP_SUITE, "completed", "failure", "bengous-labs-agents"), runIn(PUSH_SUITE, "completed", "success")],
      [runIn(APP_SUITE, "completed", "failure", "bengous-labs-agents"), runIn(PUSH_SUITE, "completed", "success")],
    );

    expect(devRedOf(await devRunsReader(runner)(WHERE))).toBe(false);
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
