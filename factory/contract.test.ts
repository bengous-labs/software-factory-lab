/**
 * The names the factory stores outside its code, each pinned to its spelling: GitHub's ruleset, open pull
 * requests, posted comments, existing state records and session transcripts hold them, so one that
 * changes here stops reading what is already stored. A change to a stored name changes this test, and
 * shows in its diff.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  branchMadeFor,
  CI_CHECKS,
  DELTA_READ,
  LAND_APPROVAL_LABEL,
  LAND_GATE,
  LANDED_OPEN_MARKER,
  landLabelOf,
  landRouteOf,
  MERGE_BOT_STATE_MARKER,
  OUTCOMES_LOG,
  REVIEW_CHECK,
  reviewLabelOf,
  storedLandRouteOf,
  WORKTREES_DIR,
} from "./contract.ts";
import { CHECKOUT_VARIABLE, worktreeOf } from "./dispatch/dispatch-plan.ts";
import { FACTORY_CONFIG_PATH } from "./install/factory-config.ts";
import { EMPTY_RECORD, recordOfComment, stateCommentOf, storedOfRecord } from "./land/merge-bot/record.ts";
import type { StateRecord } from "./land/merge-bot/record.ts";
import { relayFilesOf } from "./land/relay/relay-start.live.ts";
import { targetOf, targetTextOf } from "./land/relay/wakes.ts";
import {
  REVIEW_RESULT_FILE,
  REVIEW_THREADS_FILE,
  REVIEW_VARIABLES,
  REVIEW_WORKFLOW,
} from "./land/review/review-report.ts";
import { FORK_PARENT } from "./land/review/review-session.live.ts";
import { apiKeyHelperOf, apiWorkerLogOf, apiWorkerSettingsOf } from "./land/shared/api-worker.ts";
import { STRUCTURED_OUTPUT } from "./land/shared/ask.live.ts";
import { AUTHOR_MARK, FIXED_MARK, QUESTION_MARK, REJECT_MARK } from "./land/shared/author-mark.ts";
import { markerOf, movedLineOf, reviewMarkerOf, reviewOfBody, severityOfBody } from "./land/shared/findings.ts";
import { FORK_MARKER, outcomeLineOf } from "./land/stop/decide.ts";
import { FORK_FLAG } from "./land/stop/publish.live.ts";
import { API_WORKER_VARIABLE, AUTHOR_VARIABLE, isApiWorker, ROLE_VARIABLE } from "./lib/author-session.ts";
import { stopsOf } from "./watch/watch-plan.ts";

const REQUEST = {
  pr: 7,
  head: "a".repeat(40),
  base: "b".repeat(40),
  patch: "p1",
  round: 2,
  model: "sonnet",
  effort: "medium",
  security: false,
} as const;

/** A record with every key a decision can write. */
const FULL_RECORD: StateRecord = {
  reviewedPatch: "p1",
  reviewedHead: "a".repeat(40),
  reviewRounds: 3,
  importantByRound: [1, 0, null],
  ownerHold: "Review round 3 posted 1 Important finding(s).",
  ownerAskedPatch: "p1",
  deltaReadPatch: "p2",
  followUpIssue: 12,
  triage: {
    p1: { land: "owner", review: "deep", secondRound: true, deltaRead: true, reason: "r", model: null, security: true },
  },
  landOkPatch: "p1",
  dequeued: { head: "a".repeat(40), reason: "a conflict" },
  review: { kind: "requested", patch: "p1", round: DELTA_READ, runId: 9, at: "2026-11-11T10:00:00.000Z" },
};

describe("the names GitHub's ruleset and the open pull requests hold", () => {
  test("the checks the ruleset requires, and the CI jobs the Land gate waits for", () => {
    expect({ REVIEW_CHECK, LAND_GATE, CI_CHECKS }).toEqual({
      REVIEW_CHECK: "agent-review",
      LAND_GATE: "land-gate",
      CI_CHECKS: ["validate", "mutation"],
    });
  });

  test("the Land approval label, and the stored value of each Land route", () => {
    expect(LAND_APPROVAL_LABEL).toBe("land-ok");
    expect({ auto: storedLandRouteOf("auto"), owner: storedLandRouteOf("owner") }).toEqual({
      auto: "auto",
      owner: "human",
    });
  });

  test("the Land mod, which cannot import these names, spells the Land gate and the Land approval label the same", async () => {
    const mod = await Bun.file(join(import.meta.dir, "..", ".claude", "plugins", "land", "hooks", "land.tsx")).text();

    expect(mod).toContain(`const LABEL = "${LAND_APPROVAL_LABEL}";`);
    expect(mod).toContain(`const GATE = "${LAND_GATE}";`);
  });

  test("a stored Land route reads back as auto only when it says auto: any other value is the Owner's", () => {
    expect(["auto", "human", "owner", ""].map((stored) => landRouteOf(stored))).toEqual([
      "auto",
      "owner",
      "owner",
      "owner",
    ]);
  });

  test("a branch is made for an issue when its name opens with a type, the issue's number and a dash", () => {
    expect(branchMadeFor("issue/12-add-a-flag", 12)).toBe(true);
    expect(branchMadeFor("origin/fix/12-x", 12)).toBe(true);
    expect(branchMadeFor("issue/123-add-a-flag", 12)).toBe(false);
    expect(branchMadeFor("issue/12", 12)).toBe(false);
    expect(branchMadeFor("12-add-a-flag", 12)).toBe(false);
    expect(branchMadeFor("x/issue/12-a", 12)).toBe(false);
    expect(branchMadeFor("Issue/12-a", 12)).toBe(false);
  });

  test("the labels that carry a Land route and a Review depth", () => {
    expect([landLabelOf("auto"), landLabelOf("owner")]).toEqual(["land:auto", "land:human"]);
    expect((["none", "light", "deep"] as const).map((depth) => reviewLabelOf(depth))).toEqual([
      "review:none",
      "review:light",
      "review:deep",
    ]);
  });
});

describe("the markers posted comments carry", () => {
  test("the state record's marker and the landed-open marker", () => {
    expect({ MERGE_BOT_STATE_MARKER, LANDED_OPEN_MARKER }).toEqual({
      MERGE_BOT_STATE_MARKER: "<!-- lab-conductor-state",
      LANDED_OPEN_MARKER: "<!-- lab-landed-open -->",
    });
  });

  test("the Author's marks", () => {
    expect({ AUTHOR_MARK, QUESTION_MARK, REJECT_MARK, FIXED_MARK }).toEqual({
      AUTHOR_MARK: "<!-- lab-author-reply -->",
      QUESTION_MARK: "<!-- lab-author-question -->",
      REJECT_MARK: "<!-- lab-author-reject -->",
      FIXED_MARK: "<!-- lab-author-fixed",
    });
  });

  test("a finding's marker, by severity, which reads back", () => {
    expect((["important", "nit", "pre_existing"] as const).map((severity) => markerOf(severity))).toEqual([
      "<!-- lab-finding severity=important -->",
      "<!-- lab-finding severity=nit -->",
      "<!-- lab-finding severity=pre_existing -->",
    ]);
    expect(severityOfBody("**Important**: x\n\n<!-- lab-finding severity=important -->")).toBe("important");
  });

  test("a review's marker, which names its patch and round and reads back", () => {
    expect(reviewMarkerOf(REQUEST)).toBe("<!-- lab-review patch=p1 round=2 -->");
    expect(reviewOfBody("Round 2: no new finding.\n\n<!-- lab-review patch=p1 round=2 -->")).toEqual({
      patch: "p1",
      round: 2,
    });
  });

  test("the line of a finding anchored away from its own place", () => {
    expect(movedLineOf("app/src/cli.ts:12")).toBe("At `app/src/cli.ts:12`, outside this diff.");
  });
});

describe("the state record a comment stores", () => {
  test("the Delta read is the review job's number 4", () => {
    expect(DELTA_READ).toBe(4);
  });

  test("its keys, and each Routing answer's, as existing records hold them", () => {
    const stored = storedOfRecord(FULL_RECORD);

    expect(Object.keys(stored).toSorted()).toEqual([
      "deltaReadPatch",
      "dequeued",
      "followUpIssue",
      "importantByRound",
      "landOkPatch",
      "ownerAskedPatch",
      "ownerHold",
      "review",
      "reviewRounds",
      "reviewedHead",
      "reviewedPatch",
      "triage",
    ]);
    expect(Object.keys(stored.triage["p1"] ?? {}).toSorted()).toEqual([
      "deltaRead",
      "land",
      "model",
      "reason",
      "review",
      "secondRound",
      "security",
    ]);
    expect(stored.triage["p1"]?.land).toBe("human");
    expect(Object.keys(stored.review ?? {}).toSorted()).toEqual(["at", "kind", "patch", "round", "runId"]);
    expect(Object.keys(storedOfRecord(EMPTY_RECORD)).toSorted()).toEqual([
      "dequeued",
      "landOkPatch",
      "reviewRounds",
      "reviewedHead",
      "reviewedPatch",
      "triage",
    ]);
  });

  test("the comment that holds it: a line for the reader, then the record on a line of its own, which reads back", () => {
    const body = stateCommentOf(EMPTY_RECORD, "");

    expect(body).toBe(
      'Merge bot state for this PR. Do not edit.\n\n<!-- lab-conductor-state {"reviewedPatch":null,"reviewedHead":null,"reviewRounds":0,"triage":{},"landOkPatch":null,"dequeued":null} -->',
    );
    expect(recordOfComment(stateCommentOf(FULL_RECORD, "**Review findings**: none."))).toEqual(FULL_RECORD);
  });
});

describe("the names sessions and files hold", () => {
  test("the variables that make a session an Author, a Worker of the bench, or a fork of the Stop hook", () => {
    expect({ AUTHOR_VARIABLE, ROLE_VARIABLE, FORK_FLAG }).toEqual({
      AUTHOR_VARIABLE: "LAB_AUTHOR",
      ROLE_VARIABLE: "LAB_ROLE",
      FORK_FLAG: "LAB_STOP_FORK",
    });
  });

  test("the variable that makes a Worker an API Worker, set to 1 alone", () => {
    expect(API_WORKER_VARIABLE).toBe("LAB_API_WORKER");
    expect(
      [{ LAB_API_WORKER: "1" }, { LAB_API_WORKER: "0" }, { LAB_AUTHOR: "1" }, {}].map((env) => isApiWorker(env)),
    ).toEqual([true, false, false, false]);
  });

  test("the variable through which an API Worker's hooks name the main checkout", () => {
    expect(CHECKOUT_VARIABLE).toBe("LAB_MAIN_CHECKOUT");
  });

  test("the directory of the main checkout that holds the Workers' worktrees", () => {
    expect(WORKTREES_DIR).toBe(".claude/worktrees");
    expect(worktreeOf("/repo", 7)).toBe("/repo/.claude/worktrees/issue-7");
  });

  test("the marker of a question put to a fork, and Claude Code's own names for the review's fork and its answer", () => {
    expect({ FORK_MARKER, FORK_PARENT, STRUCTURED_OUTPUT }).toEqual({
      FORK_MARKER: "[harness:fork-probe]",
      FORK_PARENT: "forked-command-code-review",
      STRUCTURED_OUTPUT: "StructuredOutput",
    });
  });

  test("the factory config's path, and a relay's files under the main checkout", () => {
    expect(FACTORY_CONFIG_PATH).toBe(".github/software-factory.json");
    expect(OUTCOMES_LOG).toBe(".lab/outcomes.log");
    expect(relayFilesOf("/repo", 7)).toEqual({
      stateDir: "/repo/.lab/state",
      pid: "/repo/.lab/state/relay-7.pid",
      session: "/repo/.lab/state/relay-7.session",
      log: "/repo/.lab/state/relay-7.log",
      seen: "/repo/.lab/state/watch-7.json",
    });
  });

  test("a relay's session file: the session's id, and for an API Worker a second line with what its headless resume needs", () => {
    const headless = { model: "claude-opus-5-5", worktree: "/repo/.claude/worktrees/issue-7" };

    expect(targetTextOf({ session: "S1", headless: null })).toBe("S1\n");
    expect(targetTextOf({ session: "S1", headless })).toBe(
      'S1\n{"model":"claude-opus-5-5","worktree":"/repo/.claude/worktrees/issue-7"}\n',
    );
    expect(targetOf(targetTextOf({ session: "S1", headless }))).toEqual({ session: "S1", headless });
  });

  test("the key helper an API Worker's settings and its forks' name: it prints the key's file under the home", () => {
    expect(apiKeyHelperOf("/home/me")).toBe("cat '/home/me/.api-agent/key'");
  });

  test("a stop's line in the outcomes log: its keys as the Stop hook writes them, which the watch reads back", () => {
    const facts = { at: "t1", session: "S1", api: true, worktree: "/w", branch: "issue/7-x", head: "h" };
    const line = outcomeLineOf(facts, { kind: "not-published", reason: "why" });

    expect(line).toBe(
      '{"at":"t1","session":"S1","api":true,"worktree":"/w","branch":"issue/7-x","head":"h","outcome":"not-published","reason":"why"}',
    );
    expect(stopsOf(line)).toEqual([
      { at: "t1", session: "S1", api: true, branch: "issue/7-x", outcome: "not-published", reason: "why" },
    ]);
  });

  test("an API Worker's settings file under the config directory, and the log of its turns under the main checkout", () => {
    expect(apiWorkerSettingsOf("/home/me")).toBe("/home/me/.config/software-factory-lab/api-worker-settings.json");
    expect(apiWorkerLogOf("/repo", "S1")).toBe("/repo/.lab/state/api-worker-S1.log");
  });

  test("the review job's workflow, the files its processes share, and the variables that carry its request", () => {
    expect({ REVIEW_WORKFLOW, REVIEW_RESULT_FILE, REVIEW_THREADS_FILE, REVIEW_VARIABLES }).toEqual({
      REVIEW_WORKFLOW: "code-review.yml",
      REVIEW_RESULT_FILE: "review-result.json",
      REVIEW_THREADS_FILE: "review-threads.json",
      REVIEW_VARIABLES: {
        pr: "REVIEW_PR",
        head: "REVIEW_HEAD",
        base: "REVIEW_BASE",
        patch: "REVIEW_PATCH",
        round: "REVIEW_ROUND",
        model: "REVIEW_MODEL",
        effort: "REVIEW_EFFORT",
        security: "REVIEW_SECURITY",
      },
    });
  });
});
