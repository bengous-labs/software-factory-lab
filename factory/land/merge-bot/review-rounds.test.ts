import { describe, expect, test } from "bun:test";

import { LAND_APPROVAL_LABEL } from "../../contract.ts";
import type { ReportedResult } from "../review/review-report.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import {
  afterRound3,
  again,
  completed,
  EARLIER_PATCH_COMMENT,
  finding,
  gate,
  gateSummary,
  GREEN,
  important,
  kinds,
  LIGHT,
  P1,
  read,
  READY,
  red,
  stepsOf,
} from "./merge-bot.fixtures.ts";
import { EMPTY_RECORD } from "./record.ts";
import type { ReviewState, StateRecord } from "./record.ts";
import { afterReview, earlierImportantsOf } from "./review-job.ts";
import { patchDeltaStart } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { CheckState } from "./steps.ts";

describe("Review rounds", () => {
  const RISKY = { ...LIGHT, secondRound: true };

  interface Row {
    readonly name: string;
    readonly reviewRounds: number;
    /** The patch the last Review round read; P1 is this one. */
    readonly reviewedPatch: string | null;
    readonly routing: RoutingAnswer;
    /** The record's Important counts and Owner hold, when it has them. */
    readonly record?: Pick<StateRecord, "importantByRound" | "ownerHold">;
    readonly openImportant?: number;
    readonly labels?: readonly string[];
    /** The Review round asked, and at which depth. */
    readonly round: { readonly round: 1 | 2 | 3; readonly depth: "light" | "deep" } | null;
    readonly owner: boolean;
    readonly landGate: string;
  }

  const rows: readonly Row[] = [
    {
      name: "no Review round yet: Review round 1",
      reviewRounds: 0,
      reviewedPatch: null,
      routing: LIGHT,
      round: { round: 1, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a Nit-only Review round 1, then a push that needs a read: Review round 2",
      reviewRounds: 1,
      reviewedPatch: "patch-0",
      routing: RISKY,
      record: { importantByRound: [0] },
      round: { round: 2, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a Nit-only Review round 1, then a push that needs no read: landable on its Land route",
      reviewRounds: 1,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [0] },
      round: null,
      owner: false,
      landGate: "success",
    },
    {
      name: "an Important in Review round 1, then a push the Routing answer asks no read of: Review round 2 all the same",
      reviewRounds: 1,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [2] },
      round: { round: 2, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "an Important in Review round 1, then its fix that needs a read: Review round 2, its thread still open",
      reviewRounds: 1,
      reviewedPatch: "patch-0",
      routing: RISKY,
      record: { importantByRound: [1] },
      openImportant: 1,
      round: { round: 2, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a Review round 2 with an Important, then any push: Review round 3",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [0, 1] },
      round: { round: 3, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a Review round 2 with no Important, then a push that needs a read: Review round 3",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: RISKY,
      record: { importantByRound: [1, 0] },
      round: { round: 3, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a Review round 2 with no Important, then a push that needs no read: no round 3, landable on its Land route",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [3, 0] },
      round: null,
      owner: false,
      landGate: "success",
    },
    {
      name: "a Review round 2 with no Important, then a push that needs no read, on an owner route: it waits for the Owner",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: { ...LIGHT, land: "owner" },
      record: { importantByRound: [0, 0] },
      round: null,
      owner: true,
      landGate: "pending",
    },
    {
      name: "a record of two Review rounds with no count of their Important findings: Review round 3",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      round: { round: 3, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a count of round 1 only: Review round 3",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [0] },
      round: { round: 3, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a round 2 counted as unknown: Review round 3",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [0, null] },
      round: { round: 3, depth: "light" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "Review round 3 reads at the PR's review label, never lower than it",
      reviewRounds: 2,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [0, 1] },
      labels: ["review:deep"],
      round: { round: 3, depth: "deep" },
      owner: false,
      landGate: "pending",
    },
    {
      name: "a Review round 2 with an Important the Author rejected, no push: no round, landable on its Land route",
      reviewRounds: 2,
      reviewedPatch: P1,
      routing: RISKY,
      record: { importantByRound: [0, 1] },
      round: null,
      owner: false,
      landGate: "success",
    },
    {
      name: "a clean Review round 3, then a push that needs no read: landable on its Land route",
      reviewRounds: 3,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { importantByRound: [1, 1, 0] },
      round: null,
      owner: false,
      landGate: "success",
    },
    {
      name: "a clean Review round 3 on this patch: landable on its Land route",
      reviewRounds: 3,
      reviewedPatch: P1,
      routing: RISKY,
      record: { importantByRound: [1, 1, 0] },
      round: null,
      owner: false,
      landGate: "success",
    },
    {
      name: "a Review round 3, then a push that needs a read: never a round 4, held for the Owner",
      reviewRounds: 3,
      reviewedPatch: "patch-0",
      routing: RISKY,
      record: { importantByRound: [1, 1, 0] },
      round: null,
      owner: true,
      landGate: "pending",
    },
    {
      name: "an Owner hold, then a push that needs no read: still held for the Owner",
      reviewRounds: 3,
      reviewedPatch: "patch-0",
      routing: LIGHT,
      record: { ownerHold: "Review round 3 posted 1 Important finding(s)." },
      round: null,
      owner: true,
      landGate: "pending",
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const record: StateRecord = {
        ...EMPTY_RECORD,
        reviewRounds: row.reviewRounds,
        reviewedPatch: row.reviewedPatch,
        reviewedHead: row.reviewedPatch === null ? null : "h0",
        triage: { [P1]: row.routing },
        ...row.record,
      };

      const snapshot = { ...READY, labels: row.labels ?? [], openImportant: important(row.openImportant ?? 0), record };
      const steps = stepsOf(snapshot);
      const review = steps.find((step) => step.kind === "request-review");
      const labels = steps.flatMap((step) => (step.kind === "labels" ? [step.route] : []));

      expect(review?.kind === "request-review" ? { round: review.reviewRound, depth: review.depth } : null).toEqual(
        row.round,
      );
      expect(labels).toEqual([row.owner ? "owner" : "auto"]);
      expect(gate(snapshot) ?? null).toBe(row.landGate);
      expect(steps.some((step) => step.kind === "auto-merge")).toBe(row.landGate === "success");
    });
  }

  test("after a round 1 that posted an Important on a path no rule names, round 2 runs even when the Routing judge asks for none", () => {
    const judged: RoutingAnswer = {
      land: "auto",
      review: "light",
      secondRound: false,
      reason: "the Routing judge: a nit fix",
      model: "claude-haiku-5-5",
      security: false,
    };

    const uncounted: StateRecord = {
      ...EMPTY_RECORD,
      reviewRounds: 1,
      reviewedPatch: "patch-0",
      reviewedHead: "h0",
      triage: { [P1]: judged },
    };

    const after = (importantByRound: StateRecord["importantByRound"]): Snapshot => ({
      ...READY,
      openImportant: important(1),
      record: importantByRound === undefined ? uncounted : { ...uncounted, importantByRound },
    });

    for (const counts of [[1], [3], [null], undefined] as const) {
      expect(stepsOf(after(counts))).toContainEqual({
        kind: "request-review",
        depth: "light",
        reviewRound: 2,
        security: false,
      });
      expect(kinds(after(counts))).not.toContain("auto-merge");
    }

    expect(kinds({ ...after([0]), openImportant: [] })).not.toContain("request-review");
    expect(kinds({ ...after([0]), openImportant: [] })).toContain("auto-merge");
  });

  test("Review round 2 reads the Patch delta from the head Review round 1 read, or the whole PR once that head left its history", () => {
    expect(patchDeltaStart("base", "h0", 0)).toBe("h0");
    expect(patchDeltaStart("base", "h0", 1)).toBe("base");
  });
});

describe("the Delta read after Review round 3", () => {
  const RISKY = { ...LIGHT, secondRound: true };

  const ANSWERED: RoutingAnswer = {
    ...RISKY,
    deltaRead: true,
    reason: "a push after Review round 3 that only answers its Nits",
  };

  const running: CheckState = { kind: "pending", summary: "Delta read running." };
  const asked: ReviewState = { kind: "requested", patch: P1, round: 4, runId: 43, at: "2026-11-07T11:50:00.000Z" };

  const reading = (result: ReportedResult): Snapshot => ({
    ...READY,
    openedByAuthor: true,
    record: afterRound3(ANSWERED, { review: asked }),
    reviewJob: completed(result),
  });

  test("a push routed as only answering round 3's Nits, its tests included, gets a light Delta read and no hold for the Owner", () => {
    expect(stepsOf({ ...READY, labels: ["review:deep"], record: afterRound3(ANSWERED) })).toEqual([
      { kind: "labels", route: "auto", depth: "deep" },
      { kind: "request-review", depth: "light", reviewRound: 4, security: false },
      { kind: "review-check", check: running },
      { kind: "land-gate", check: running },
    ]);
  });

  test("the Delta read runs the security pass the change's Routing answer asks", () => {
    expect(stepsOf({ ...READY, record: afterRound3({ ...ANSWERED, security: true }) })).toContainEqual({
      kind: "request-review",
      depth: "light",
      reviewRound: 4,
      security: true,
    });
  });

  test("a Delta read that posts no Important posts none of its Nits, keeps the PR ready, records its patch apart from the rounds, and the PR lands by its route", () => {
    const result = read(finding("nit"), finding("pre_existing"));
    const record = { ...afterRound3(ANSWERED), deltaReadPatch: P1 };

    expect(stepsOf(reading(result))).toEqual([
      { kind: "post-review", result: read(), heldOpen: [] },
      { kind: "record", record },
      GREEN,
    ]);
    expect(afterReview(afterRound3(ANSWERED, { review: asked }), result)).toEqual(record);
    expect(kinds({ ...READY, record })).toEqual(["labels", "review-check", "land-gate", "auto-merge"]);
  });

  test("an Important from the Delta read sends the PR back to draft and holds it for the Owner", () => {
    const record = {
      ...afterRound3(ANSWERED),
      deltaReadPatch: P1,
      ownerHold: "The Delta read of a push after Review round 3 posted 1 Important finding(s).",
    };

    expect(stepsOf(reading(read(finding("important"), finding("nit"))))).toEqual([
      { kind: "post-review", result: read(finding("important")), heldOpen: [] },
      { kind: "to-draft" },
      { kind: "record", record },
      red(1),
    ]);

    const held = { ...READY, openImportant: important(1), record };

    expect(kinds(held)).not.toContain("auto-merge");
    expect(kinds(held)).not.toContain("request-review");
    expect(gateSummary(held)).toBe(
      "Held for the Owner: The Delta read of a push after Review round 3 posted 1 Important finding(s). Waiting for the Owner's Land approval (label land-ok).",
    );
  });

  describe("on a PR whose Importants are open after round 3", () => {
    const ROUND_3: Snapshot["openImportant"] = [
      { thread: "T1", review: { patch: "patch-0", round: 3 } },
      { thread: "T2", review: { patch: "patch-0", round: 3 } },
    ];

    const hold = "Review round 3 posted 2 Important finding(s).";

    /** Round 3 posted two Importants on patch-0 and held the PR; this push, P1, routed `routing`, answers them. */
    const answering = (routing: RoutingAnswer = LIGHT, rest: Partial<StateRecord> = {}): Snapshot => ({
      ...READY,
      openedByAuthor: true,
      openImportant: ROUND_3,
      record: afterRound3(routing, {
        importantByRound: [1, 1, 2],
        ownerHold: hold,
        ownerAskedPatch: "patch-0",
        ...rest,
      }),
    });

    test("a push after round 3 that answers its Importants gets a light Delta read, whatever its route and depth, and the PR stays held for the Owner, not asked yet", () => {
      for (const routing of [
        LIGHT,
        RISKY,
        { ...LIGHT, review: "none" as const },
        { ...LIGHT, land: "owner" as const },
      ]) {
        expect(stepsOf(answering(routing))).toEqual([
          { kind: "labels", route: "owner", depth: routing.review === "none" ? "none" : "light" },
          { kind: "request-review", depth: "light", reviewRound: 4, security: false },
          { kind: "review-check", check: running },
          { kind: "land-gate", check: running },
        ]);
      }
    });

    test("an Important the Delta read no longer reports is closed as fixed; one it reports again stays open, with its reply, and the held PR stays ready, so the Owner is asked next", () => {
      const result = read(again("T1"), finding("nit"));
      const asking = answering(LIGHT, { review: asked });

      const record = {
        ...afterRound3(LIGHT, { importantByRound: [1, 1, 2], ownerHold: hold, ownerAskedPatch: "patch-0" }),
        deltaReadPatch: P1,
      };

      expect(stepsOf({ ...asking, reviewJob: completed(result) })).toEqual([
        { kind: "post-review", result: read(again("T1")), heldOpen: ["T1"] },
        { kind: "resolve-threads", threads: ["T2"] },
        { kind: "record", record },
        red(1),
      ]);
      expect(earlierImportantsOf(read(again("T1")), ROUND_3)).toEqual({ kept: ["T1"], closed: ["T2"], left: 0 });
      expect(kinds({ ...READY, openImportant: ROUND_3.slice(0, 1), record })).toEqual([
        "labels",
        "review-check",
        "owner-comment",
        "record",
        "land-gate",
      ]);
    });

    test("a Delta read sends a held PR back to draft for no finding, new or reported again; on a PR it does not hold, its Important does", () => {
      const asking = answering(LIGHT, { review: asked });
      const { ownerHold: _hold, ...unheld } = asking.record;

      for (const result of [read(again("T1")), read(finding("important"))]) {
        expect(kinds({ ...asking, reviewJob: completed(result) })).not.toContain("to-draft");
        expect(kinds({ ...asking, record: unheld, reviewJob: completed(result) })).toContain("to-draft");
      }

      // A Review round asks its Author whatever the record holds.
      const round3: ReportedResult = { ...read(finding("important")), request: { ...read().request, round: 3 } };
      const asking3 = { ...asking, record: { ...asking.record, review: { ...asked, round: 3 as const } } };

      expect(kinds({ ...asking3, reviewJob: completed(round3) })).toContain("to-draft");
    });

    test("a Land approval the Owner gave while the Delta read ran stops counting once it posts: the next decision removes it, comment first, and lands nothing", () => {
      const read1 = answering(LIGHT, { deltaReadPatch: P1, landOkPatch: P1 });

      const before = {
        ...read1,
        openImportant: [...ROUND_3, { thread: "T3", review: { patch: P1, round: 4 } }],
        labels: [LAND_APPROVAL_LABEL],
        landApprovalByOwner: false,
        landApprovalPutByOwner: true,
      };

      const steps = stepsOf(before);

      expect(steps.slice(0, 3)).toEqual([
        { kind: "owner-comment", body: EARLIER_PATCH_COMMENT },
        { kind: "remove-land-approval" },
        { kind: "record", record: { ...read1.record, landOkPatch: null } },
      ]);
      expect(steps.map((step) => step.kind)).not.toContain("land-open");
      expect(steps.map((step) => step.kind)).not.toContain("auto-merge");
      expect(kinds({ ...before, landApprovalByOwner: true })).toContain("land-open");
    });

    test("on a PR no one holds for the Owner, an open Important owes no Delta read: only a push routed for one gets it", () => {
      const { ownerHold: _hold, ...unheld } = answering().record;

      expect(kinds({ ...answering(), record: unheld })).not.toContain("request-review");
      expect(
        stepsOf({ ...answering(), record: { ...unheld, triage: { [P1]: { ...RISKY, deltaRead: true } } } }),
      ).toContainEqual({ kind: "request-review", depth: "light", reviewRound: 4, security: false });
    });

    test("a Delta read that confirms every fix closes each thread, keeps the PR ready, and only then is the Owner asked, the hold kept", () => {
      const result = read();

      const record = {
        ...afterRound3(LIGHT, { importantByRound: [1, 1, 2], ownerHold: hold, ownerAskedPatch: "patch-0" }),
        deltaReadPatch: P1,
      };

      expect(stepsOf({ ...answering(LIGHT, { review: asked }), reviewJob: completed(result) })).toEqual([
        { kind: "post-review", result, heldOpen: [] },
        { kind: "resolve-threads", threads: ["T1", "T2"] },
        { kind: "record", record },
        GREEN,
      ]);
      expect(stepsOf({ ...READY, record })).toEqual([
        { kind: "labels", route: "owner", depth: "light" },
        { kind: "review-check", check: { kind: "success", summary: "No Important finding open." } },
        {
          kind: "owner-comment",
          body: `This PR waits for the Owner's Land approval: ${hold.slice(0, -1)}. Add the label land-ok to land it.`,
        },
        { kind: "record", record: { ...record, ownerAskedPatch: P1 } },
        {
          kind: "land-gate",
          check: {
            kind: "pending",
            summary: `Held for the Owner: ${hold} Waiting for the Owner's Land approval (label land-ok).`,
          },
        },
      ]);
    });

    test("an Important the Delta read finds that round 3 had not posted keeps the PR held, under the hold it has", () => {
      const unheld = afterRound3(LIGHT, { review: asked });

      expect(afterReview({ ...unheld, ownerHold: hold }, read(finding("important"))).ownerHold).toBe(hold);
      expect(afterReview(unheld, read(finding("important"))).ownerHold).toBe(
        "The Delta read of a push after Review round 3 posted 1 Important finding(s).",
      );
    });

    test("it converges: one Delta read per push, and a later push with an Important still open gets its own", () => {
      const P2 = "patch-2";
      const read1 = answering(LIGHT, { deltaReadPatch: P1, ownerAskedPatch: P1 });

      expect(kinds(read1)).not.toContain("request-review");
      expect(stepsOf({ ...read1, patch: P2, record: { ...read1.record, triage: { [P2]: LIGHT } } })).toContainEqual({
        kind: "request-review",
        depth: "light",
        reviewRound: 4,
        security: false,
      });
    });
  });

  test("a Delta read runs once per push: a later push in the bounds gets its own, a PR held for the Owner with no Important open none", () => {
    const P2 = "patch-2";
    const record = afterRound3(ANSWERED, { deltaReadPatch: P1, triage: { [P2]: ANSWERED } });
    const held = afterRound3(ANSWERED, { ownerHold: "Review round 3 posted 1 Important finding(s)." });

    expect(stepsOf({ ...READY, patch: P2, record })).toContainEqual({
      kind: "request-review",
      depth: "light",
      reviewRound: 4,
      security: false,
    });
    expect(kinds({ ...READY, record: held })).not.toContain("request-review");
  });

  test("a push routed for a Delta read at review:none still gets its light read: it never lands unread", () => {
    const unread = { ...READY, record: afterRound3({ ...ANSWERED, review: "none" }) };

    expect(stepsOf(unread)).toContainEqual({ kind: "request-review", depth: "light", reviewRound: 4, security: false });
    expect(kinds(unread)).not.toContain("auto-merge");
  });

  test("only a record of three Review rounds gets a Delta read: one whose count reads past 3 gets no review", () => {
    expect(kinds({ ...READY, record: afterRound3(ANSWERED, { reviewRounds: 4 }) })).not.toContain("request-review");
  });

  test("a push after Review round 3 outside the bounds is held for the Owner, as before", () => {
    expect(stepsOf({ ...READY, record: afterRound3(RISKY) })[0]).toEqual({
      kind: "record",
      record: { ...afterRound3(RISKY), ownerHold: "A push after Review round 3 needs a read." },
    });
    expect(kinds({ ...READY, record: afterRound3(RISKY) })).not.toContain("request-review");
  });

  test("a Delta read that failed names itself in the Review check", () => {
    const failed = {
      ...READY,
      record: afterRound3(ANSWERED, { review: asked }),
      reviewJob: completed(null, "failure"),
    };

    expect(stepsOf(failed)).toContainEqual({
      kind: "review-check",
      check: {
        kind: "failure",
        summary: "Delta read failed (run 43): the review job ended (failure) with no result that reads",
      },
    });
  });
});
