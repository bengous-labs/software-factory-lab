import { describe, expect, test } from "bun:test";

import { LAND_APPROVAL_LABEL } from "../../contract.ts";
import type { ReportedFinding, ReportedResult } from "../review/review-report.ts";
import {
  again,
  completed,
  EARLIER_PATCH_COMMENT,
  failure,
  finding,
  GREEN,
  important,
  kinds,
  P1,
  READY,
  red,
  stepsOf,
} from "./merge-bot.fixtures.ts";
import { recordOfJson, storedOfRecord } from "./record.ts";
import type { ReviewState } from "./record.ts";
import { afterReview, earlierImportantsOf, postedFindingsOf, REVIEW_DEADLINE_MS, reviewStepsOf } from "./review-job.ts";
import type { ReviewJob } from "./snapshot.ts";
import type { CheckState, Step } from "./steps.ts";

const failedState = (cause: string): ReviewState => ({ kind: "failed", patch: P1, round: 1, runId: 42, cause });

describe("the review job's run", () => {
  const AT = "2026-11-07T11:50:00.000Z";

  const REQUESTED: ReviewState = { kind: "requested", patch: P1, round: 1, runId: 42, at: AT };

  const asked = { ...READY, record: { ...READY.record, review: REQUESTED } };

  const REQUEST = {
    pr: 9,
    head: "a".repeat(40),
    base: "b".repeat(40),
    patch: P1,
    round: 1 as const,
    model: "sonnet",
    effort: "medium" as const,
    security: false,
  };

  const FACTS = {
    request: REQUEST,
    model: "claude-sonnet-5-5",
    claudeCodeVersion: "2.1.318",
    tokens: null,
    runUrl: "u",
  };

  const reported = (...findings: ReportedFinding[]): ReportedResult => ({
    kind: "reported",
    report: { findings, namesEarlier: true },
    ...FACTS,
  });

  const running: CheckState = { kind: "pending", summary: "Review round 1 running." };

  const held: Step = {
    kind: "land-gate",
    check: { kind: "pending", summary: "Not landable: the Code review failed." },
  };

  test("while the run has not completed, the decision ends with both checks pending and asks no other review, even on a draft", () => {
    for (const snapshot of [
      { ...asked, reviewJob: { kind: "running" as const } },
      { ...asked, reviewJob: null },
      { ...asked, reviewJob: { kind: "running" as const }, draft: true, ci: null },
    ]) {
      expect(stepsOf(snapshot)).toEqual([
        { kind: "review-check", check: running },
        { kind: "land-gate", check: running },
      ]);
    }
  });

  test("a request still running past the deadline fails, and the record keeps why; up to the deadline it waits", () => {
    const deadline = new Date(Date.parse(AT) + REVIEW_DEADLINE_MS).toISOString();
    const late = new Date(Date.parse(AT) + REVIEW_DEADLINE_MS + 1).toISOString();
    const waiting = { ...asked, reviewJob: { kind: "running" as const } };

    expect(REVIEW_DEADLINE_MS).toBe(65 * 60_000);
    expect(kinds({ ...waiting, now: new Date(Date.parse(AT) + 60 * 60_000).toISOString() })).toEqual([
      "review-check",
      "land-gate",
    ]);
    expect(kinds({ ...waiting, now: deadline })).toEqual(["review-check", "land-gate"]);
    expect(stepsOf({ ...waiting, now: late })).toEqual([
      {
        kind: "record",
        record: { ...asked.record, review: failedState("the review job did not report") },
      },
      failure("the review job did not report"),
      held,
    ]);
  });

  const inRound2 = (...findings: ReportedFinding[]): ReportedResult => ({
    ...reported(...findings),
    request: { ...REQUEST, round: 2 },
  });

  test("a completed run that reports for this PR, patch and round posts the review, even on a draft, records the round, then says whether it found an Important", () => {
    const both = reported(finding("important"), finding("nit"));
    const nit = reported(finding("nit"));

    expect(stepsOf({ ...asked, reviewJob: completed(both) })).toEqual([
      { kind: "post-review", result: both, heldOpen: [] },
      { kind: "to-draft" },
      { kind: "record", record: afterReview(asked.record, both) },
      red(1),
    ]);
    expect(stepsOf({ ...asked, draft: true, reviewJob: completed(nit) })).toEqual([
      { kind: "post-review", result: nit, heldOpen: [] },
      { kind: "record", record: afterReview(asked.record, nit) },
      GREEN,
    ]);
  });

  test("a round with a Nit and no Important sends an Author's PR to draft, and leaves an Owner's PR ready", () => {
    const nit = reported(finding("nit"), finding("pre_existing"));
    const byAuthor = { ...asked, openedByAuthor: true, reviewJob: completed(nit) };

    expect(stepsOf(byAuthor)).toEqual([
      { kind: "post-review", result: nit, heldOpen: [] },
      { kind: "to-draft" },
      { kind: "record", record: afterReview(asked.record, nit) },
      GREEN,
    ]);
    expect(kinds({ ...byAuthor, openedByAuthor: false })).toEqual(["post-review", "record", "review-check"]);
  });

  test("a round with no Important and no Nit leaves the PR ready, whoever opened it; a PR already in draft is not sent again", () => {
    for (const result of [reported(), reported(finding("pre_existing"))]) {
      expect(kinds({ ...asked, openedByAuthor: true, reviewJob: completed(result) })).toEqual([
        "post-review",
        "record",
        "review-check",
      ]);
    }

    for (const result of [reported(finding("nit")), reported(finding("important"))]) {
      expect(kinds({ ...asked, openedByAuthor: true, draft: true, reviewJob: completed(result) })).not.toContain(
        "to-draft",
      );
    }
  });

  test("an Important sends the PR to draft whoever opened it, before the round is recorded", () => {
    for (const openedByAuthor of [true, false]) {
      expect(kinds({ ...asked, openedByAuthor, reviewJob: completed(reported(finding("important"))) })).toEqual([
        "post-review",
        "to-draft",
        "record",
        "review-check",
      ]);
    }
  });

  test("a Review round 1 was shown no earlier finding: it leaves an open Important as it is, and its Review check counts it", () => {
    const nit = reported(finding("nit"));

    expect(stepsOf({ ...asked, openImportant: important(1), reviewJob: completed(nit) })).toEqual([
      { kind: "post-review", result: nit, heldOpen: [] },
      { kind: "record", record: afterReview(asked.record, nit) },
      red(1),
    ]);
    expect(
      stepsOf({ ...asked, openImportant: important(1), reviewJob: completed(reported(finding("important"))) }),
    ).toContainEqual(red(2));
  });

  describe("a later round and the earlier Importants", () => {
    const ROUND_2: ReviewState = { ...REQUESTED, round: 2 };

    const second = {
      ...READY,
      openImportant: important(2),
      record: { ...READY.record, reviewedPatch: "patch-0", reviewRounds: 1, importantByRound: [2], review: ROUND_2 },
    };

    test("a round that does not report an earlier Important again resolves its thread; one that does leaves it open", () => {
      const result = inRound2(again("T1"), finding("nit"));

      expect(stepsOf({ ...second, reviewJob: completed(result) })).toEqual([
        { kind: "post-review", result, heldOpen: ["T1"] },
        { kind: "resolve-threads", threads: ["T2"] },
        { kind: "to-draft" },
        { kind: "record", record: afterReview(second.record, result) },
        red(1),
      ]);
    });

    test("a round that reports no earlier Important again resolves each of them, and its Review check is green", () => {
      const result = inRound2();

      expect(stepsOf({ ...second, reviewJob: completed(result) })).toEqual([
        { kind: "post-review", result, heldOpen: [] },
        { kind: "resolve-threads", threads: ["T1", "T2"] },
        { kind: "record", record: afterReview(second.record, result) },
        GREEN,
      ]);
    });

    test("a round that reports each earlier Important again resolves none", () => {
      const result = inRound2(again("T1"), again("T2"), finding("important"));
      const steps = stepsOf({ ...second, reviewJob: completed(result) });

      expect(steps[0]).toEqual({ kind: "post-review", result, heldOpen: ["T1", "T2"] });
      expect(steps.map((step) => step.kind)).not.toContain("resolve-threads");
      expect(steps.at(-1)).toEqual(red(3));
    });

    test("a report that was not asked to name the earlier findings, as one written before rounds were, closes none and leaves each open", () => {
      const named = inRound2(finding("nit"));
      const unnamed: ReportedResult = { ...named, report: { ...named.report, namesEarlier: false } };

      expect(stepsOf({ ...second, reviewJob: completed(unnamed) })).toEqual([
        { kind: "post-review", result: unnamed, heldOpen: [] },
        { kind: "record", record: afterReview(second.record, unnamed) },
        red(2),
      ]);
      expect(earlierImportantsOf(unnamed, important(2))).toEqual({ kept: [], closed: [], left: 2 });
      expect(earlierImportantsOf(named, important(2))).toEqual({ kept: [], closed: ["T1", "T2"], left: 0 });
    });

    test("only an Important names an earlier thread: a Nit that names one keeps nothing open", () => {
      const result = inRound2({ ...finding("nit"), earlier: "T1" });

      expect(stepsOf({ ...second, reviewJob: completed(result) })).toContainEqual({
        kind: "resolve-threads",
        threads: ["T1", "T2"],
      });
    });

    test("a thread the review posted itself, when its posting is retried, is not an earlier one: it stays open", () => {
      const result = inRound2(finding("important"));
      const own = { thread: "T3", review: { patch: P1, round: 2 } };
      const otherPatch = { thread: "T4", review: { patch: "patch-0", round: 2 } };
      const unmarked = { thread: "T5", review: null };

      expect(
        stepsOf({ ...second, openImportant: [own, otherPatch, unmarked], reviewJob: completed(result) }),
      ).toContainEqual({ kind: "resolve-threads", threads: ["T4", "T5"] });
      expect(
        stepsOf({
          ...second,
          openImportant: [{ thread: "T3", review: { patch: P1, round: 1 } }],
          reviewJob: completed(result),
        }),
      ).toContainEqual({ kind: "resolve-threads", threads: ["T3"] });
    });

    test("the findings posted leave out an Important whose earlier thread stays open, and keep every other finding", () => {
      const result = inRound2(again("T1"), again("T-resolved"), finding("nit"), { ...finding("nit"), earlier: "T1" });

      expect(postedFindingsOf(result, ["T1"])).toEqual([
        again("T-resolved"),
        finding("nit"),
        { ...finding("nit"), earlier: "T1" },
      ]);
      expect(postedFindingsOf(result, [])).toEqual(result.report.findings);
    });

    test("earlierImportantsOf sorts the open threads of earlier reviews by what the round reports again", () => {
      expect(earlierImportantsOf(inRound2(again("T2"), again("T9")), important(2))).toEqual({
        kept: ["T2"],
        closed: ["T1"],
        left: 0,
      });
      expect(earlierImportantsOf(reported(again("T2")), important(2))).toEqual({ kept: [], closed: [], left: 2 });
    });
  });

  test("the posted review's Review check counts the Importants the Author rejected apart; its conclusion follows the open count alone", () => {
    const rows: Array<[number, number, CheckState]> = [
      [0, 0, { kind: "success", summary: "No Important finding open." }],
      [0, 2, { kind: "success", summary: "No Important finding open; 2 rejected by the Author." }],
      [1, 0, { kind: "failure", summary: "1 Important finding(s) open." }],
      [1, 2, { kind: "failure", summary: "1 Important finding(s) open; 2 rejected by the Author." }],
    ];

    for (const [openImportant, rejectedImportant, check] of rows) {
      expect(
        stepsOf({
          ...asked,
          openImportant: important(openImportant),
          rejectedImportant,
          reviewJob: completed(reported(finding("nit"))),
        }),
      ).toContainEqual({ kind: "review-check", check });
    }

    expect(
      stepsOf({ ...asked, rejectedImportant: 2, reviewJob: completed(reported(finding("important"))) }),
    ).toContainEqual({
      kind: "review-check",
      check: { kind: "failure", summary: "1 Important finding(s) open; 2 rejected by the Author." },
    });
  });

  test("a failed result, a run with no result that reads, or an artifact of another PR, patch or round fails the review, with the cause", () => {
    const rows: Array<[ReviewJob, string]> = [
      [completed({ kind: "failed", cause: "timed out after 1500000 ms", ...FACTS }), "timed out after 1500000 ms"],
      [completed(null, "timed_out"), "the review job ended (timed_out) with no result that reads"],
      [completed(null, "cancelled"), "the review job ended (cancelled) with no result that reads"],
      [completed({ ...reported(), request: { ...REQUEST, pr: 10 } }), "the artifact does not match the request"],
      [
        completed({ ...reported(), request: { ...REQUEST, patch: "patch-0" } }),
        "the artifact does not match the request",
      ],
      [completed({ ...reported(), request: { ...REQUEST, round: 2 } }), "the artifact does not match the request"],
    ];

    for (const [reviewJob, cause] of rows) {
      expect(stepsOf({ ...asked, reviewJob })).toEqual([
        { kind: "record", record: { ...asked.record, review: failedState(cause) } },
        failure(cause),
        held,
      ]);
    }
  });

  test("a failed review stays failed while its run reruns, or when its run fails again, and writes no record again", () => {
    const failed = { ...asked, record: { ...asked.record, review: failedState("c") } };

    for (const reviewJob of [{ kind: "running" as const }, null]) {
      expect(stepsOf({ ...failed, reviewJob, now: "2026-11-08T12:00:00.000Z" })).toEqual([failure("c"), held]);
    }

    expect(stepsOf({ ...failed, reviewJob: completed({ kind: "failed", cause: "other", ...FACTS }) })).toEqual([
      failure("other"),
      held,
    ]);
    expect(stepsOf({ ...failed, reviewJob: completed(null, "failure") })).toEqual([
      failure("the review job ended (failure) with no result that reads"),
      held,
    ]);
  });

  test("a failed review whose run reran and reports for its patch and round is posted", () => {
    const failed = { ...asked, record: { ...asked.record, review: failedState("c") } };

    expect(kinds({ ...failed, reviewJob: completed(reported()) })).toEqual(["post-review", "record", "review-check"]);
  });

  test("a review asked for another patch is stale: it is cleared, and the decision goes on for this patch", () => {
    const stale = { ...asked, record: { ...asked.record, review: { ...REQUESTED, patch: "patch-0" } } };

    expect(stepsOf({ ...stale, reviewJob: completed(reported()) }).slice(0, 3)).toEqual([
      { kind: "record", record: READY.record },
      { kind: "labels", route: "auto", depth: "light" },
      { kind: "request-review", depth: "light", reviewRound: 1, security: false },
    ]);
    expect(reviewStepsOf(READY, READY.record)).toEqual({ record: READY.record, end: null });
  });

  test("a run GitHub no longer gives back is asked again in the same decision, whether its review was asked or failed", () => {
    for (const review of [REQUESTED, failedState("c")]) {
      const gone = { ...asked, record: { ...asked.record, review }, reviewJob: { kind: "missing" as const } };

      expect(stepsOf(gone).slice(0, 3)).toEqual([
        { kind: "record", record: READY.record },
        { kind: "labels", route: "auto", depth: "light" },
        { kind: "request-review", depth: "light", reviewRound: 1, security: false },
      ]);
    }
  });

  test("a stale Land approval and a failed review are written in one record", () => {
    const snapshot = {
      ...asked,
      labels: [LAND_APPROVAL_LABEL],
      landApprovalByOwner: true,
      record: { ...asked.record, landOkPatch: "patch-0" },
      reviewJob: completed(null),
    };

    expect(stepsOf(snapshot).slice(0, 3)).toEqual([
      { kind: "owner-comment", body: EARLIER_PATCH_COMMENT },
      { kind: "remove-land-approval" },
      {
        kind: "record",
        record: {
          ...asked.record,
          landOkPatch: null,
          review: failedState("the review job ended (success) with no result that reads"),
        },
      },
    ]);
  });

  test("a posted review records the patch and the head it read, its round and its Important count, and clears the request", () => {
    const record = {
      ...asked.record,
      reviewedPatch: "patch-0",
      reviewedHead: "h0",
      reviewRounds: 1,
      importantByRound: [3],
    };

    const round2 = { ...reported(finding("important"), finding("nit")), request: { ...REQUEST, round: 2 as const } };

    expect(afterReview(record, round2)).toEqual({
      ...READY.record,
      reviewedPatch: P1,
      reviewedHead: REQUEST.head,
      reviewRounds: 2,
      importantByRound: [3, 1],
    });
  });

  test("a review posted again writes its count at its round's index, never appends", () => {
    const round1 = reported(finding("nit"));
    const once = afterReview(READY.record, round1);

    expect(once.importantByRound).toEqual([0]);
    expect(afterReview(once, round1)).toEqual(once);
  });

  test("a round's Important count holds the security pass's Importants with the Code review's", () => {
    const security = { ...finding("important"), pass: "security" as const };

    expect(
      afterReview(READY.record, reported(finding("important"), security, finding("nit"))).importantByRound,
    ).toEqual([2]);
  });

  test("a round counted over a record that has no count for an earlier round reads back, the missing one as null", () => {
    const old = recordOfJson(JSON.stringify({ reviewRounds: 2, reviewedPatch: "patch-0" }));
    const round3 = { ...reported(), request: { ...REQUEST, round: 3 as const } };
    const next = afterReview(old, round3);

    expect(next.importantByRound).toEqual([null, null, 0]);
    expect(recordOfJson(JSON.stringify(storedOfRecord(next)))).toEqual(next);
    expect(next).not.toHaveProperty("ownerHold");
  });

  test("a Review round 3 with an Important holds the PR for the Owner, with the count", () => {
    const round3 = {
      ...reported(finding("important"), finding("important"), finding("nit")),
      request: { ...REQUEST, round: 3 as const },
    };

    const next = afterReview({ ...READY.record, reviewRounds: 2, importantByRound: [0, 1] }, round3);

    expect(next.ownerHold).toBe("Review round 3 posted 2 Important finding(s).");
    expect(next.importantByRound).toEqual([0, 1, 2]);
    expect(afterReview(next, round3)).toEqual(next);
  });

  test("an Important in Review round 1 or 2 sets no hold", () => {
    for (const round of [1, 2] as const) {
      const result = { ...reported(finding("important")), request: { ...REQUEST, round } };

      expect(afterReview(READY.record, result)).not.toHaveProperty("ownerHold");
    }
  });
});
