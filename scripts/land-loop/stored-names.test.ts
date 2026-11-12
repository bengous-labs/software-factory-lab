/**
 * The names the factory stores outside its code, each pinned to its spelling: GitHub's ruleset, open pull
 * requests, posted comments, existing state records and session transcripts hold them, so one that
 * changes here stops reading what is already stored. A change to a stored name changes this test, and
 * shows in its diff.
 */

import { describe, expect, test } from "bun:test";

import { AUTHOR_VARIABLE, ROLE_VARIABLE } from "../lib/author-session.ts";
import { AUTHOR_MARK, FIXED_MARK, QUESTION_MARK, REJECT_MARK } from "./author-mark.ts";
import {
  CI_CHECKS,
  DELTA_READ,
  LAND_APPROVAL_LABEL,
  LAND_GATE,
  LANDED_OPEN_MARKER,
  landLabelOf,
  MERGE_BOT_STATE_MARKER,
  REVIEW_CHECK,
  reviewLabelOf,
  storedLandRouteOf,
} from "./contract.ts";
import { FACTORY_CONFIG_PATH } from "./factory-config.ts";
import { STRUCTURED_OUTPUT } from "./lib/ask.ts";
import { relayFilesOf } from "./lib/relay-start.ts";
import { FORK_PARENT } from "./lib/review-session.ts";
import { EMPTY_RECORD, recordOfComment, stateCommentOf, storedOfRecord } from "./merge-bot/decide.ts";
import type { StateRecord } from "./merge-bot/decide.ts";
import { markerOf, movedLineOf, reviewOfBody, severityOfBody } from "./review/findings.ts";
import { reviewMarkerOf } from "./review/post-plan.ts";
import { FORK_MARKER } from "./stop/decide.ts";
import { FORK_FLAG } from "./stop/hook.ts";

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

  test("the marker of a question put to a fork, and Claude Code's own names for the review's fork and its answer", () => {
    expect({ FORK_MARKER, FORK_PARENT, STRUCTURED_OUTPUT }).toEqual({
      FORK_MARKER: "[harness:fork-probe]",
      FORK_PARENT: "forked-command-code-review",
      STRUCTURED_OUTPUT: "StructuredOutput",
    });
  });

  test("the factory config's path, and a relay's files under the main checkout", () => {
    expect(FACTORY_CONFIG_PATH).toBe(".github/software-factory.json");
    expect(relayFilesOf("/repo", 7)).toEqual({
      stateDir: "/repo/.lab/state",
      pid: "/repo/.lab/state/relay-7.pid",
      session: "/repo/.lab/state/relay-7.session",
      log: "/repo/.lab/state/relay-7.log",
    });
  });
});
