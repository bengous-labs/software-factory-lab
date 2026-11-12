import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import type { Run } from "../../lib/run.port.ts";
import { FIXED_MARK } from "../shared/author-mark.ts";
import { fixedRecordBodyOf, questionCommentOf } from "../stop/decide.ts";
import { reviewsReader } from "./github.ts";
import { labeled, runIn, WHERE } from "./merge-bot.fixtures.ts";
import {
  ActionsRun,
  checkRunBodyOf,
  CheckRuns,
  CheckSuites,
  ciOfRuns,
  CommitPulls,
  devRedOf,
  Dispatched,
  humanLabelByOf,
  IssueComments,
  IssueEvents,
  landApprovalByOwnerOf,
  landApprovalPutByOwnerOf,
  latestReviewAtOf,
  ListedPrs,
  notFound,
  openedByFactoryOf,
  PostedComment,
  Pull,
  PullReviews,
  stateCommentIn,
} from "./readings.ts";
import { EMPTY_RECORD, stateCommentOf } from "./record.ts";

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

describe("an object nested in GitHub's answer", () => {
  test("an answer whose nested object lacks a field the Merge bot reads is refused", () => {
    const refused: ReadonlyArray<[Schema.ConstraintDecoder<unknown>, Schema.Json]> = [
      [Pull, { ...PULL, user: {} }],
      [Pull, { ...PULL, head: {} }],
      [Pull, { ...PULL, head: { ...PULL.head, repo: {} } }],
      [Pull, { ...PULL, base: {} }],
      [IssueComments, [{ id: 1, user: {}, body: "b" }]],
      [
        CheckRuns,
        { check_runs: [{ name: "validate", status: "queued", conclusion: null, app: {}, check_suite: { id: 1 } }] },
      ],
      [
        CheckRuns,
        { check_runs: [{ name: "validate", status: "queued", conclusion: null, app: null, check_suite: {} }] },
      ],
      [IssueEvents, [{ event: "labeled", label: {}, actor: null, created_at: "2026-11-05T11:00:00Z" }]],
      [PostedComment, {}],
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

  test("only a land-ok put is a Land approval: its later removal, or another label put after it, leaves the Owner's as it was", () => {
    const later = decodeJson(
      IssueEvents,
      "events",
      JSON.stringify([
        { event: "labeled", label: { name: "land-ok" }, actor: { login: "owner" }, created_at: "2026-11-05T11:00:00Z" },
        {
          event: "unlabeled",
          label: { name: "land-ok" },
          actor: { login: "someone" },
          created_at: "2026-11-05T11:05:00Z",
        },
        {
          event: "labeled",
          label: { name: "land:auto" },
          actor: { login: "someone" },
          created_at: "2026-11-05T11:06:00Z",
        },
      ]),
    );

    expect(landApprovalPutByOwnerOf(later, "owner")).toBe(true);
  });

  test("no land-ok put, or a labeled event whose label GitHub gives as null, is no Land approval", () => {
    const unnamed = decodeJson(
      IssueEvents,
      "events",
      JSON.stringify([
        { event: "labeled", label: null, actor: { login: "owner" }, created_at: "2026-11-05T11:00:00Z" },
      ]),
    );

    expect(landApprovalPutByOwnerOf(unnamed, "owner")).toBe(false);
    expect(landApprovalPutByOwnerOf([], "owner")).toBe(false);
    expect(landApprovalByOwnerOf([], "owner", pushedAt(null))).toBe(false);
  });

  test("a review of a deleted user, whom GitHub gives as null, is none of the App's", () => {
    expect(latestReviewAtOf([{ ...reviewBy(APP, "2026-11-05T12:00:00Z"), user: null }], APP)).toBeNull();
    expect(
      latestReviewAtOf(
        [{ ...reviewBy(APP, "2026-11-05T12:00:00Z"), user: null }, reviewBy(APP, "2026-11-05T11:00:00Z")],
        APP,
      ),
    ).toBe("2026-11-05T11:00:00Z");
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

  test("a comment of a deleted user, whom GitHub gives as null, is skipped: the App's and the Author's after it are read", () => {
    expect(
      stateCommentIn(
        [
          { id: 1, user: null, body: state },
          ...commentsOf([2, logins.appLogin, state], [3, logins.authorLogin, fixed]),
        ],
        logins,
      ),
    ).toEqual({ id: 2, body: state, record, fixed: new Set(["T1", "T2"]) });
  });

  test("the Author's question that quotes the fixed mark in a code span is no record; the record after it is read", () => {
    const question = questionCommentOf(`Keep \`${FIXED_MARK} T9 -->\`?`, "feat/7-x", "S1");

    expect(stateCommentIn(commentsOf([1, logins.authorLogin, question]), logins).fixed).toEqual(new Set());
    expect(
      stateCommentIn(commentsOf([1, logins.authorLogin, question], [2, logins.authorLogin, fixed]), logins).fixed,
    ).toEqual(new Set(["T1", "T2"]));
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

  test("only a put or a removal of land:human decides: a labeled event with a null label, or another event that names land:human, does not", () => {
    const events = [
      labeled("land:human", BOT, "2026-11-05T10:00:00Z"),
      { event: "labeled", label: null, actor: { login: "owner" }, created_at: "2026-11-05T11:00:00Z" },
      { ...labeled("land:human", "owner", "2026-11-05T12:00:00Z"), event: "mentioned" },
    ];

    expect(humanLabelByOf(events, ["land:human"], LOGINS)).toBe("merge-bot");
  });

  test("an unreadable actor, or no labeled event of land:human, is another login: the safe side", () => {
    expect(humanLabelByOf([labeled("land:human", null, "2026-11-05T10:00:00Z")], ["land:human"], LOGINS)).toBe("other");
    expect(humanLabelByOf([labeled("land-ok", BOT, "2026-11-05T10:00:00Z")], ["land:human"], LOGINS)).toBe("other");
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

describe("ciOfRuns", () => {
  test("a check run with no App, which GitHub gives as null, is not GitHub Actions': the run after it is read", () => {
    const runs = { check_runs: [{ ...runIn(1, "completed", "failure"), app: null }, runIn(1, "completed", "success")] };

    expect(ciOfRuns([runs, runs])).toBe("success");
  });
});
