import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import {
  CheckRuns,
  CheckSuites,
  CommitPulls,
  IssueComments,
  IssueEvents,
  ListedPrs,
  Pull,
  ReviewThreads,
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

  test("a review thread whose author was deleted reads with a null author", () => {
    const answer = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "T",
                  isResolved: true,
                  path: "a.ts",
                  line: 3,
                  comments: { nodes: [{ author: null, body: "x" }] },
                },
              ],
            },
          },
        },
      },
    };

    expect(decodeJson(ReviewThreads, "threads", JSON.stringify(answer))).toEqual(answer);
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
      [IssueEvents, [{ event: "labeled", label: null, actor: { login: "a" }, created_at: "t" }]],
      [CheckSuites, { check_suites: [{ created_at: null }] }],
      [WorkflowRuns, { workflow_runs: null }],
      [CommitPulls, [{ number: "3", state: "open" }]],
      [ListedPrs, [{ id: 3 }]],
      [ReviewThreads, { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T" }] } } } } }],
    ];

    for (const [schema, answer] of refused) {
      expect(Result.isFailure(Schema.decodeUnknownResult(schema)(answer))).toBe(true);
    }
  });
});
