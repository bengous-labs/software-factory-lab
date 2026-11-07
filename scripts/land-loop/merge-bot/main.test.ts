import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import {
  ActionsRun,
  CheckRuns,
  CheckSuites,
  CommitPulls,
  Dispatched,
  IssueComments,
  IssueEvents,
  landApprovalByOwnerOf,
  ListedPrs,
  notFound,
  Pull,
  PullReviews,
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
