import { describe, expect, test } from "bun:test";

import { LAND_APPROVAL_LABEL } from "../../contract.ts";
import { important, kinds, LIGHT, P1, READY, stepsOf } from "./merge-bot.fixtures.ts";
import { ciOf, conflictingOf, landApprovalCounts, patchDeltaStart } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { CheckState } from "./steps.ts";

describe("ciOf", () => {
  const green = { status: "completed", conclusion: "success" };
  const red = { status: "completed", conclusion: "failure" };
  const running = { status: "in_progress", conclusion: null };

  test("CI is green only once every check completed green", () => {
    expect(ciOf([green, green])).toBe("success");
  });

  test("CI is red once one check ended other than green, even while another runs or is missing", () => {
    expect(ciOf([green, red])).toBe("failure");
    expect(ciOf([running, { status: "completed", conclusion: "cancelled" }])).toBe("failure");
    expect(ciOf([undefined, { status: "completed", conclusion: null }])).toBe("failure");
  });

  test("CI is pending while a check runs or has not reported", () => {
    expect(ciOf([green, running])).toBeNull();
    expect(ciOf([green, undefined])).toBeNull();
  });
});

describe("conflictingOf", () => {
  test("only GitHub's dirty state is a conflict; unknown, blocked, clean and a missing field are not", () => {
    expect(conflictingOf("dirty")).toBe(true);

    for (const state of ["unknown", "blocked", "clean", "behind", null, undefined]) {
      expect(conflictingOf(state)).toBe(false);
    }
  });
});

describe("patchDeltaStart", () => {
  test("the Patch delta starts at the reviewed head only while it is an ancestor of this head", () => {
    expect(patchDeltaStart("base", "reviewed", 0)).toBe("reviewed");
  });

  test("after a rebase, an unknown object, or with no review yet, the Patch delta is the whole PR", () => {
    expect(patchDeltaStart("base", "reviewed", 1)).toBe("base");
    expect(patchDeltaStart("base", "reviewed", 128)).toBe("base");
    expect(patchDeltaStart("base", null, null)).toBe("base");
  });

  test("with no reviewed head, the Patch delta is the whole PR whatever the exit read", () => {
    expect(patchDeltaStart("base", null, 0)).toBe("base");
  });
});

/** The summaries of the Review check and the Land gate a decision posts, in order. */
const checksOf = (snapshot: Snapshot): string[] =>
  stepsOf(snapshot).flatMap((step) =>
    step.kind === "review-check" || step.kind === "land-gate" ? [step.check.summary] : [],
  );

/** The times a Land approval is weighed against: the head pushed at `headPushedAt`, and no review of the App. */
const pushedOnly = (headPushedAt: string | null) => ({ headPushedAt, reviewedAt: null });

describe("landApprovalCounts", () => {
  test("the owner's Land approval counts when put after the head was pushed, never before, and never someone else's", () => {
    expect(landApprovalCounts(true, "2026-11-05T20:00:00Z", pushedOnly("2026-11-05T19:00:00Z"))).toBe(true);
    expect(landApprovalCounts(true, "2026-11-05T18:00:00Z", pushedOnly("2026-11-05T19:00:00Z"))).toBe(false);
    expect(landApprovalCounts(false, "2026-11-05T20:00:00Z", pushedOnly("2026-11-05T19:00:00Z"))).toBe(false);
    expect(landApprovalCounts(true, null, pushedOnly(null))).toBe(false);
    expect(landApprovalCounts(true, "2026-11-05T20:00:00Z", pushedOnly(null))).toBe(true);
    expect(landApprovalCounts(true, "2026-11-05T19:00:00Z", pushedOnly("2026-11-05T19:00:00Z"))).toBe(true);
  });

  test("the owner's Land approval counts only when put after the App's latest review, never within its second: it covers only the findings the Owner could read", () => {
    const times = { headPushedAt: "2026-11-05T19:00:00Z", reviewedAt: "2026-11-05T20:00:00Z" };

    expect(landApprovalCounts(true, "2026-11-05T20:00:01Z", times)).toBe(true);
    expect(landApprovalCounts(true, "2026-11-05T20:00:00Z", times)).toBe(false);
    expect(landApprovalCounts(true, "2026-11-05T19:30:00Z", times)).toBe(false);
    expect(landApprovalCounts(true, "2026-11-05T18:30:00Z", { ...times, reviewedAt: "2026-11-05T18:00:00Z" })).toBe(
      false,
    );
    expect(landApprovalCounts(true, "2026-11-05T20:00:01Z", { headPushedAt: null, reviewedAt: times.reviewedAt })).toBe(
      true,
    );
    expect(landApprovalCounts(false, "2026-11-05T21:00:00Z", times)).toBe(false);
  });

  test("the checks of a landable PR say why: no Important open or review:none, then its land:auto or the Owner's Land approval", () => {
    const landable = { ...READY, record: { ...READY.record, reviewedPatch: P1, reviewRounds: 1 } };
    const unread = { ...READY, record: { ...READY.record, triage: { [P1]: { ...LIGHT, review: "none" as const } } } };

    const approved = {
      ...landable,
      labels: [LAND_APPROVAL_LABEL],
      landApprovalByOwner: true,
      record: { ...landable.record, triage: { [P1]: { ...LIGHT, land: "owner" as const } }, landOkPatch: P1 },
    };

    expect(checksOf(landable)).toEqual(["No Important finding open.", "Landable, land:auto."]);
    expect(checksOf(unread)).toEqual(["review:none, nothing to read.", "Landable, land:auto."]);
    expect(checksOf(approved)).toEqual([
      "No Important finding open.",
      "Landable, with the Owner's Land approval (label land-ok).",
    ]);
  });

  test("the Review check of a read PR counts the Importants the Author rejected apart; its conclusion follows the open count alone", () => {
    const read = { ...READY, record: { ...READY.record, reviewedPatch: P1, reviewRounds: 1 } };

    const rows: Array<[number, number, CheckState]> = [
      [0, 0, { kind: "success", summary: "No Important finding open." }],
      [0, 2, { kind: "success", summary: "No Important finding open; 2 rejected by the Author." }],
      [1, 0, { kind: "failure", summary: "1 Important finding(s) open." }],
      [1, 2, { kind: "failure", summary: "1 Important finding(s) open; 2 rejected by the Author." }],
    ];

    for (const [openImportant, rejectedImportant, check] of rows) {
      expect(stepsOf({ ...read, openImportant: important(openImportant), rejectedImportant })).toContainEqual({
        kind: "review-check",
        check,
      });
    }

    const unread = { ...READY, record: { ...READY.record, triage: { [P1]: { ...LIGHT, review: "none" as const } } } };

    expect(checksOf({ ...unread, rejectedImportant: 2 })[0]).toBe("review:none, nothing to read.");
  });

  test("an owner's Land approval already recorded for the current patch stays, and lands it", () => {
    const approved = {
      ...READY,
      labels: [LAND_APPROVAL_LABEL],
      landApprovalByOwner: true,
      record: { ...READY.record, reviewedPatch: P1, landOkPatch: P1 },
    };

    expect(kinds(approved)).not.toContain("remove-land-approval");
    expect(kinds(approved)).not.toContain("record");
    expect(kinds(approved)).toContain("auto-merge");
  });
});
