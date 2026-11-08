import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import {
  HUMAN_LABEL_BY,
  LABELS,
  recordOf,
  ROUTING,
  RUNS,
  SNAPSHOT,
  stepsOrNone,
  withdrawn,
} from "../guarantees.test.ts";
import type { ReportedFinding, ReportedResult, ReviewResult } from "../review/review-report.ts";
import {
  afterReview,
  ciOf,
  conflictingOf,
  decide,
  EMPTY_RECORD,
  LAND_APPROVAL_LABEL,
  landApprovalCounts,
  patchDeltaStart,
  recordOfJson,
  recordOfStored,
  REVIEW_DEADLINE_MS,
  reviewStepsOf,
  risen,
  storedOfRecord,
} from "./decide.ts";
import type {
  CheckState,
  ReviewJob,
  ReviewState,
  RoutingAnswer,
  Snapshot,
  StateRecord,
  Step,
  StoredRecord,
} from "./decide.ts";

const P1 = "patch-1";

const LIGHT: RoutingAnswer = {
  land: "auto",
  review: "light",
  secondRound: false,
  reason: "ordinary code",
  model: "claude-haiku-5-5",
};

const READY: Snapshot = {
  number: 9,
  state: "OPEN",
  sameRepository: true,
  openedByOwner: true,
  draft: false,
  head: "h1",
  patch: P1,
  empty: false,
  ci: "success",
  labels: [],
  humanLabelBy: null,
  landApprovalByOwner: false,
  openImportant: 0,
  devRed: false,
  conflicting: false,
  record: { ...EMPTY_RECORD, triage: { [P1]: LIGHT } },
  now: "2026-11-07T12:00:00.000Z",
  reviewJob: null,
};

function stepsOf(snapshot: Snapshot): readonly Step[] {
  const decision = decide(snapshot);

  if (decision.kind !== "steps") {
    throw new Error(`ignored: ${decision.reason}`);
  }

  return decision.steps;
}

const kinds = (snapshot: Snapshot): string[] => stepsOf(snapshot).map((step) => step.kind);

const gate = (snapshot: Snapshot): string | undefined => {
  const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

  return step?.kind === "land-gate" ? step.check.kind : undefined;
};

describe("decide", () => {
  test("closed PRs, PRs from forks and PRs not opened by the Owner are ignored", () => {
    expect(decide({ ...READY, state: "MERGED" }).kind).toBe("ignore");
    expect(decide({ ...READY, sameRepository: false }).kind).toBe("ignore");
    expect(decide({ ...READY, openedByOwner: false }).kind).toBe("ignore");
  });

  test("a draft, a pending CI or a red CI leaves the Land gate pending and runs no model", () => {
    for (const snapshot of [
      { ...READY, draft: true },
      { ...READY, ci: null },
      { ...READY, ci: "failure" as const },
    ]) {
      expect(kinds(snapshot)).toEqual(["land-gate"]);
      expect(gate(snapshot)).toBe("pending");
    }
  });

  test("the Land gate names the CI it waits for, and the CI that is red", () => {
    expect(stepsOf({ ...READY, ci: null })).toEqual([
      { kind: "land-gate", check: { kind: "pending", summary: "Waiting for validate and mutation." } },
    ]);
    expect(stepsOf({ ...READY, ci: "failure" })).toEqual([
      { kind: "land-gate", check: { kind: "pending", summary: "validate or mutation is red: the author's turn." } },
    ]);
  });

  test("a ready PR with green CI and a patch with no Routing answer is routed first", () => {
    expect(stepsOf({ ...READY, record: EMPTY_RECORD })).toEqual([{ kind: "route", patch: P1, patchDelta: false }]);
  });

  test("a routed patch nobody reviewed asks the review job for Review round 1 at its Review depth, both checks pending", () => {
    const running: CheckState = { kind: "pending", summary: "Review round 1 running." };

    expect(stepsOf(READY)).toEqual([
      { kind: "labels", route: "auto", depth: "light" },
      { kind: "request-review", depth: "light", reviewRound: 1 },
      { kind: "review-check", check: running },
      { kind: "land-gate", check: running },
    ]);
  });

  test("review:none sets the Review check green at once, and a land:auto PR goes to the queue", () => {
    const docs = { ...READY, record: { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, review: "none" as const } } } };

    expect(kinds(docs)).toEqual(["labels", "review-check", "land-gate", "auto-merge"]);
    expect(gate(docs)).toBe("success");
  });

  test("a reviewed patch with an open Important keeps the Review check red and the Land gate pending", () => {
    const snapshot = { ...READY, openImportant: 1, record: { ...READY.record, reviewedPatch: P1, reviewRounds: 1 } };
    const review = stepsOf(snapshot).find((step) => step.kind === "review-check");

    expect(review?.kind === "review-check" && review.check.kind).toBe("failure");
    expect(gate(snapshot)).toBe("pending");
  });

  test("a nit-only review leaves the PR landable", () => {
    expect(gate({ ...READY, record: { ...READY.record, reviewedPatch: P1, reviewRounds: 1 } })).toBe("success");
  });

  test("a landable land:human PR waits for the owner's Land approval, bound to its patch", () => {
    const owner = {
      ...READY,
      record: {
        ...READY.record,
        reviewedPatch: P1,
        reviewRounds: 1,
        triage: { [P1]: { ...LIGHT, land: "owner" as const } },
      },
    };

    expect(gate(owner)).toBe("pending");
    expect(gate({ ...owner, labels: ["land-ok"], landApprovalByOwner: true })).toBe("success");
    expect(kinds({ ...owner, labels: ["land-ok"], landApprovalByOwner: true })).toContain("record");
  });

  test("a land:human PR lands only on the Owner's Land approval for this very patch", () => {
    const owner = {
      ...READY,
      labels: [LAND_APPROVAL_LABEL],
      record: {
        ...READY.record,
        reviewedPatch: P1,
        reviewRounds: 1,
        triage: { [P1]: { ...LIGHT, land: "owner" as const } },
      },
    };

    const someoneElse = { ...owner, landApprovalByOwner: false, record: { ...owner.record, landOkPatch: P1 } };
    const otherPatch = { ...owner, landApprovalByOwner: true, record: { ...owner.record, landOkPatch: "patch-0" } };

    for (const snapshot of [someoneElse, otherPatch]) {
      expect(gate(snapshot)).toBe("pending");
      expect(kinds(snapshot)).not.toContain("auto-merge");
    }
  });

  test("a Land approval label that someone else put, or one given for another patch, is removed", () => {
    const owner = { ...READY, labels: ["land-ok"], record: { ...READY.record, reviewedPatch: P1 } };

    expect(kinds({ ...owner, landApprovalByOwner: false })).toContain("remove-land-approval");
    expect(
      kinds({ ...owner, landApprovalByOwner: true, record: { ...owner.record, landOkPatch: "patch-0" } }),
    ).toContain("remove-land-approval");
  });

  test("a ready PR in conflict with dev gets a red Land gate that tells its author to rebase, and runs no model", () => {
    const snapshot = { ...READY, conflicting: true, ci: null, record: EMPTY_RECORD };
    const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

    expect(kinds(snapshot)).toEqual(["land-gate"]);
    expect(step?.kind === "land-gate" && step.check.kind).toBe("failure");
    expect(step?.kind === "land-gate" && step.check.summary).toContain("rebase");
    expect(gate({ ...snapshot, draft: true })).toBe("pending");
  });

  test("an empty change gets only a red Land gate, whatever its record and its labels: no route, review or auto-merge", () => {
    for (const snapshot of [
      { ...READY, empty: true, record: EMPTY_RECORD },
      { ...READY, empty: true },
      { ...READY, empty: true, draft: true, ci: null, labels: ["land:human", "land-ok"], landApprovalByOwner: true },
    ]) {
      expect(stepsOf(snapshot)).toEqual([
        { kind: "land-gate", check: { kind: "failure", summary: "Nothing to land: this PR changes no file." } },
      ]);
    }
  });

  test("an empty change that is closed or comes from outside is still ignored", () => {
    expect(decide({ ...READY, empty: true, state: "CLOSED" }).kind).toBe("ignore");
    expect(decide({ ...READY, empty: true, openedByOwner: false }).kind).toBe("ignore");
  });

  test("a red dev holds a landable PR", () => {
    expect(gate({ ...READY, devRed: true, record: { ...READY.record, reviewedPatch: P1 } })).toBe("pending");
  });

  test("an Ejection at this head gives a red Land gate with the reason", () => {
    const snapshot = { ...READY, record: { ...READY.record, dequeued: { head: "h1", reason: "merge conflict" } } };
    const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

    expect(step?.kind === "land-gate" && step.check).toEqual({
      kind: "failure",
      summary: "Ejected from the merge queue: merge conflict",
    });
    expect(gate({ ...snapshot, head: "h2" })).not.toBe("failure");
  });

  test("the same snapshot read twice gives the same steps", () => {
    expect(decide(READY)).toEqual(decide(READY));
  });
});

describe("Review rounds", () => {
  const RISKY = { ...LIGHT, secondRound: true };

  // Rounds run, the patch the last one read (P1 is this one), Routing answer, open Important; then the
  // Review round asked, the Owner asked, and the Land gate.
  const rows: Array<[string, number, string | null, RoutingAnswer, number, 1 | 2 | null, boolean, string | null]> = [
    ["no Review round yet: Review round 1", 0, null, LIGHT, 0, 1, false, "pending"],
    ["a Nit-only Review round 1, then a risky push: Review round 2", 1, "patch-0", RISKY, 0, 2, false, "pending"],
    [
      "a Nit-only Review round 1, then a push that needs no review: landable on its Land route",
      1,
      "patch-0",
      LIGHT,
      0,
      null,
      false,
      "success",
    ],
    [
      "an Important in Review round 1, then its risky fix: Review round 2, its thread still open",
      1,
      "patch-0",
      RISKY,
      1,
      2,
      false,
      "pending",
    ],
    [
      "an Important in Review round 1, then a fix that needs no review, resolved: landable",
      1,
      "patch-0",
      LIGHT,
      0,
      null,
      false,
      "success",
    ],
    [
      "two Review rounds, then a patch that needs another: the Owner, never a third",
      2,
      "patch-0",
      RISKY,
      0,
      null,
      true,
      "pending",
    ],
    [
      "two Review rounds, then a patch that needs none: it stays on its Land route",
      2,
      "patch-0",
      LIGHT,
      0,
      null,
      false,
      "success",
    ],
    [
      "two Review rounds, the last on this patch, no Important open: landable on its Land route",
      2,
      P1,
      LIGHT,
      0,
      null,
      false,
      "success",
    ],
    [
      "two Review rounds, the last on this risky patch: it was read, so no third, landable",
      2,
      P1,
      RISKY,
      0,
      null,
      false,
      "success",
    ],
  ];

  for (const [name, reviewRounds, reviewedPatch, routing, openImportant, reviewRound, toOwner, landGate] of rows) {
    test(name, () => {
      const record = {
        ...EMPTY_RECORD,
        reviewRounds,
        reviewedPatch,
        reviewedHead: reviewedPatch === null ? null : "h0",
        triage: { [P1]: routing },
      };

      const snapshot = { ...READY, openImportant, record };
      const steps = stepsOf(snapshot);
      const review = steps.find((step) => step.kind === "request-review");

      expect(review?.kind === "request-review" ? review.reviewRound : null).toBe(reviewRound);
      expect(steps.some((step) => step.kind === "needs-owner")).toBe(toOwner);
      expect(steps.some((step) => step.kind === "labels" && step.route === "owner")).toBe(toOwner);
      expect(gate(snapshot) ?? null).toBe(landGate);
      expect(steps.some((step) => step.kind === "auto-merge")).toBe(landGate === "success");
    });
  }

  test("Review round 2 reads the Patch delta from the head Review round 1 read, or the whole PR once that head left its history", () => {
    expect(patchDeltaStart("base", "h0", 0)).toBe("h0");
    expect(patchDeltaStart("base", "h0", 1)).toBe("base");
  });
});

describe("risen", () => {
  test("the review label only rises: a later Routing answer cannot lower review:deep", () => {
    expect(risen(["review:deep"], null, LIGHT)).toEqual({ route: "auto", depth: "deep" });
    expect(risen(["review:none"], null, LIGHT)).toEqual({ route: "auto", depth: "light" });
  });
});

const BOT_LABELED = { ...READY, labels: ["land:human"], humanLabelBy: "merge-bot" as const };

const landRoute = (snapshot: Snapshot): string | undefined => {
  const step = stepsOf(snapshot).find((found) => found.kind === "labels");

  return step?.kind === "labels" ? step.route : undefined;
};

const reviewed = (routing: RoutingAnswer, rest: Partial<StateRecord> = {}): StateRecord => ({
  ...EMPTY_RECORD,
  reviewedPatch: P1,
  reviewedHead: "h0",
  reviewRounds: 1,
  triage: { [P1]: routing },
  ...rest,
});

describe("a land:human label", () => {
  test("the Merge bot's App set falls to land:auto when the route decide computes is auto", () => {
    const snapshot = { ...BOT_LABELED, record: reviewed(LIGHT) };

    expect(landRoute(snapshot)).toBe("auto");
    expect(kinds(snapshot)).toContain("auto-merge");
  });

  test("the Merge bot's App set stays when the Routing answer says owner", () => {
    const snapshot = { ...BOT_LABELED, record: reviewed({ ...LIGHT, land: "owner" }) };

    expect(landRoute(snapshot)).toBe("owner");
    expect(kinds(snapshot)).not.toContain("auto-merge");
  });

  test("the Merge bot's App set stays when a third Review round would be needed, in one labels step", () => {
    const record = reviewed({ ...LIGHT, secondRound: true }, { reviewedPatch: "patch-0", reviewRounds: 2 });
    const steps = stepsOf({ ...BOT_LABELED, record });

    expect(steps.filter((step) => step.kind === "labels")).toEqual([
      { kind: "labels", route: "owner", depth: "light" },
    ]);
    expect(steps.some((step) => step.kind === "auto-merge")).toBe(false);
  });

  test("another login set is the Owner's veto and stays though the route is auto", () => {
    const snapshot = { ...BOT_LABELED, humanLabelBy: "other" as const, record: reviewed(LIGHT) };

    expect(landRoute(snapshot)).toBe("owner");
    expect(gate(snapshot)).toBe("pending");
    expect(kinds(snapshot)).not.toContain("auto-merge");
  });

  test("an unreadable actor, or no labeled event, reads as another login: the label stays", () => {
    const snapshot = { ...READY, labels: ["land:human"], humanLabelBy: "other" as const, record: reviewed(LIGHT) };

    expect(landRoute(snapshot)).toBe("owner");
    expect(kinds(snapshot)).not.toContain("auto-merge");
  });

  test("with no land:human on the PR, an owner route puts it", () => {
    expect(landRoute({ ...READY, record: reviewed({ ...LIGHT, land: "owner" }) })).toBe("owner");
  });

  test("a label that fell rises again when a later patch routes to owner", () => {
    const fell = { ...BOT_LABELED, record: reviewed(LIGHT) };
    const later = { ...READY, labels: ["land:auto"], record: reviewed({ ...LIGHT, land: "owner" }) };

    expect(landRoute(fell)).toBe("auto");
    expect(landRoute(later)).toBe("owner");
  });
});

describe("the stored record", () => {
  test("a stored human Land route reads as owner and is stored again as human; every other field is kept", () => {
    const stored: StoredRecord = {
      ...EMPTY_RECORD,
      reviewedPatch: P1,
      reviewRounds: 1,
      triage: { [P1]: { ...LIGHT, land: "human" }, "patch-2": { ...LIGHT, land: "auto" } },
    };

    const record = recordOfStored(stored);

    expect(record.triage[P1]?.land).toBe("owner");
    expect(record.triage["patch-2"]?.land).toBe("auto");
    expect(record).toMatchObject({ reviewedPatch: P1, reviewRounds: 1 });
    expect(storedOfRecord(record)).toEqual(stored);
  });

  test("a stored Land route that is not auto reads as owner, the safe side", () => {
    const stored = { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, land: "later" } } };

    expect(recordOfStored(stored).triage[P1]?.land).toBe("owner");
    expect(recordOfJson(JSON.stringify(stored)).triage[P1]?.land).toBe("owner");
  });

  test("an empty comment JSON reads as the record of a change no Review round read", () => {
    expect(recordOfJson("{}")).toEqual(EMPTY_RECORD);
  });

  test("a record written before the Routing answer named its model reads with no model", () => {
    const { model: _model, ...unnamed } = LIGHT;

    expect(recordOfJson(JSON.stringify({ triage: { [P1]: { ...unnamed, land: "auto" } } })).triage[P1]).toEqual({
      ...LIGHT,
      model: null,
    });
  });

  test("a record outside its schema is refused, naming the field", () => {
    expect(() => recordOfJson(JSON.stringify({ reviewRounds: "1" }))).toThrow(
      'the Merge bot state record: Expected number\n  at ["reviewRounds"]',
    );
    expect(() => recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, review: "skim" } } }))).toThrow(
      `at ["triage"]["${P1}"]["review"]`,
    );
  });

  test("a record with a review asked reads back the same, and one written before the field existed reads with none", () => {
    const review = {
      kind: "requested" as const,
      patch: P1,
      round: 2 as const,
      runId: 7,
      at: "2026-11-07T11:00:00.000Z",
    };

    const record = { ...EMPTY_RECORD, review };

    expect(recordOfJson(JSON.stringify(storedOfRecord(record)))).toEqual(record);
    expect(recordOfJson(JSON.stringify({ reviewRounds: 1 })).review).toBeUndefined();
    expect(() => recordOfJson(JSON.stringify({ review: { ...review, round: 3 } }))).toThrow('at ["review"]');
  });

  test("a record that counted Important findings posted in a review's body still reads, and the count is left out", () => {
    const record = recordOfJson(JSON.stringify({ reviewRounds: 1, reviewedPatch: P1, bodyImportant: { [P1]: 2 } }));

    expect(record).toEqual({ ...EMPTY_RECORD, reviewRounds: 1, reviewedPatch: P1 });
    expect(storedOfRecord(record)).not.toHaveProperty("bodyImportant");
    expect(() => recordOfJson(JSON.stringify({ bodyImportant: { [P1]: "2" } }))).toThrow('at ["bodyImportant"]');
  });

  test("a record written while the Principal judge existed still reads, and its fields are left out", () => {
    const record = recordOfJson(
      JSON.stringify({
        reviewRounds: 1,
        reviewedPatch: P1,
        triage: { [P1]: { ...LIGHT, needsFable: true } },
        fable: { [P1]: { ok: true, reason: "fine" } },
        fableFailures: { [P1]: 1 },
      }),
    );

    expect(record).toEqual({ ...EMPTY_RECORD, reviewRounds: 1, reviewedPatch: P1, triage: { [P1]: LIGHT } });
    expect(() => recordOfJson(JSON.stringify({ fable: { [P1]: { ok: "yes" } } }))).toThrow('at ["fable"]');
    expect(() => recordOfJson(JSON.stringify({ fableFailures: { [P1]: "1" } }))).toThrow('at ["fableFailures"]');
    expect(() => recordOfJson(JSON.stringify({ triage: { [P1]: { ...LIGHT, needsFable: "yes" } } }))).toThrow(
      `at ["triage"]["${P1}"]["needsFable"]`,
    );
  });

  test("a record is stored with its reviewRounds, and reads back the same", () => {
    const record = recordOfJson(
      JSON.stringify({ reviewRounds: 1, reviewedPatch: P1, triage: { [P1]: { ...LIGHT, land: "human" } } }),
    );

    const stored = storedOfRecord(record);

    expect(stored.reviewRounds).toBe(1);
    expect(recordOfJson(JSON.stringify(stored))).toEqual(record);
  });
});

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
});

describe("Land approval across a patch change", () => {
  test("a stale Land approval is removed and its patch cleared in the record, even when a routing ends the decision", () => {
    const snapshot = {
      ...READY,
      labels: ["land-ok"],
      landApprovalByOwner: true,
      record: { ...EMPTY_RECORD, landOkPatch: "patch-0" },
    };

    const steps = stepsOf(snapshot);

    expect(steps.map((step) => step.kind)).toEqual(["remove-land-approval", "record", "route"]);
    expect(steps[1]).toEqual({ kind: "record", record: { ...EMPTY_RECORD, landOkPatch: null } });
  });

  test("a Land approval patch left in the record without the label is cleared, so a new Land approval counts", () => {
    const record = { ...READY.record, reviewedPatch: P1, landOkPatch: "patch-0" };

    expect(stepsOf({ ...READY, record })).toContainEqual({ kind: "record", record: { ...record, landOkPatch: null } });
  });
});

describe("landApprovalCounts", () => {
  test("the owner's Land approval counts when put after the head was pushed, never before, and never someone else's", () => {
    expect(landApprovalCounts(true, "2026-11-05T20:00:00Z", "2026-11-05T19:00:00Z")).toBe(true);
    expect(landApprovalCounts(true, "2026-11-05T18:00:00Z", "2026-11-05T19:00:00Z")).toBe(false);
    expect(landApprovalCounts(false, "2026-11-05T20:00:00Z", "2026-11-05T19:00:00Z")).toBe(false);
    expect(landApprovalCounts(true, null, null)).toBe(false);
    expect(landApprovalCounts(true, "2026-11-05T20:00:00Z", null)).toBe(true);
  });
});

const finding = (severity: ReportedFinding["severity"]): ReportedFinding => ({
  file: "a.ts",
  line: 3,
  severity,
  summary: "s",
  failureScenario: "f",
  breaks: null,
});

const completed = (result: ReviewResult | null, conclusion = "success"): ReviewJob => ({
  kind: "completed",
  conclusion,
  result,
});

/** The Review check of a failed Review round 1 of run 42. */
const failure = (cause: string): Step => ({
  kind: "review-check",
  check: { kind: "failure", summary: `Review round 1 failed (run 42): ${cause}` },
});

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
  };

  const FACTS = {
    request: REQUEST,
    model: "claude-sonnet-5-5",
    claudeCodeVersion: "2.1.318",
    costUsd: 0.03,
    runUrl: "u",
  };

  const reported = (...findings: ReportedFinding[]): ReportedResult => ({
    kind: "reported",
    report: { findings },
    ...FACTS,
  });

  const running: CheckState = { kind: "pending", summary: "Review round 1 running." };

  const held: Step = {
    kind: "land-gate",
    check: { kind: "pending", summary: "Not landable: the Code review failed." },
  };

  const failedState = (cause: string): ReviewState => ({ kind: "failed", patch: P1, round: 1, runId: 42, cause });

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

  test("a completed run that reports for this PR, patch and round posts the review, even on a draft, then says whether it found an Important", () => {
    expect(stepsOf({ ...asked, reviewJob: completed(reported(finding("important"), finding("nit"))) })).toEqual([
      { kind: "post-review", result: reported(finding("important"), finding("nit")) },
      { kind: "review-check", check: { kind: "failure", summary: "1 Important finding(s) open." } },
    ]);
    expect(stepsOf({ ...asked, draft: true, reviewJob: completed(reported(finding("nit"))) })).toEqual([
      { kind: "post-review", result: reported(finding("nit")) },
      { kind: "review-check", check: { kind: "success", summary: "No Important finding open." } },
    ]);
  });

  test("a report with no Important still leaves the Review check red while an earlier round's Important is open", () => {
    expect(stepsOf({ ...asked, openImportant: 1, reviewJob: completed(reported(finding("nit"))) })).toEqual([
      { kind: "post-review", result: reported(finding("nit")) },
      { kind: "review-check", check: { kind: "failure", summary: "1 Important finding(s) open." } },
    ]);
    expect(
      stepsOf({ ...asked, openImportant: 1, reviewJob: completed(reported(finding("important"))) }),
    ).toContainEqual({ kind: "review-check", check: { kind: "failure", summary: "2 Important finding(s) open." } });
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

    expect(kinds({ ...failed, reviewJob: completed(reported()) })).toEqual(["post-review", "review-check"]);
  });

  test("a review asked for another patch is stale: it is cleared, and the decision goes on for this patch", () => {
    const stale = { ...asked, record: { ...asked.record, review: { ...REQUESTED, patch: "patch-0" } } };

    expect(stepsOf({ ...stale, reviewJob: completed(reported()) }).slice(0, 3)).toEqual([
      { kind: "record", record: READY.record },
      { kind: "labels", route: "auto", depth: "light" },
      { kind: "request-review", depth: "light", reviewRound: 1 },
    ]);
    expect(reviewStepsOf(READY, READY.record)).toEqual({ record: READY.record, end: null });
  });

  test("a run GitHub no longer gives back is asked again in the same decision, whether its review was asked or failed", () => {
    for (const review of [REQUESTED, failedState("c")]) {
      const gone = { ...asked, record: { ...asked.record, review }, reviewJob: { kind: "missing" as const } };

      expect(stepsOf(gone).slice(0, 3)).toEqual([
        { kind: "record", record: READY.record },
        { kind: "labels", route: "auto", depth: "light" },
        { kind: "request-review", depth: "light", reviewRound: 1 },
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

    expect(stepsOf(snapshot).slice(0, 2)).toEqual([
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

  test("a posted review records the patch and the head it read and its round, and clears the request", () => {
    const record = { ...asked.record, reviewedPatch: "patch-0", reviewedHead: "h0", reviewRounds: 1 };
    const round2 = { ...reported(), request: { ...REQUEST, round: 2 as const } };

    expect(afterReview(record, round2)).toEqual({
      ...READY.record,
      reviewedPatch: P1,
      reviewedHead: REQUEST.head,
      reviewRounds: 2,
    });
  });
});

const MODEL_STEPS: ReadonlySet<Step["kind"]> = new Set(["route"]);

const REVIEW_RANK: Readonly<Record<RoutingAnswer["review"], number>> = { none: 0, light: 1, deep: 2 };

describe("the Merge bot's invariants", () => {
  test("risen: the route is owner exactly when another login set land:human or the route given is owner", () => {
    fc.assert(
      fc.property(fc.subarray(LABELS), HUMAN_LABEL_BY, ROUTING, (labels, by, routing) => {
        const expected = by === "other" || routing.land === "owner" ? "owner" : "auto";

        expect(risen(labels, by, routing).route).toBe(expected);
      }),
    );
  });

  test("risen: the depth is the deepest of the PR's review labels and the answer's", () => {
    fc.assert(
      fc.property(fc.subarray(LABELS), ROUTING, (labels, routing) => {
        const onPr = (["none", "light", "deep"] as const).filter((depth) => labels.includes(`review:${depth}`));
        const deepest = Math.max(REVIEW_RANK[routing.review], ...onPr.map((depth) => REVIEW_RANK[depth]));

        expect(REVIEW_RANK[risen(labels, null, routing).depth]).toBe(deepest);
      }),
    );
  });

  test("a state record, stored then read back from its comment's JSON, is the same record", () => {
    fc.assert(
      fc.property(recordOf(fc.string()), (record) => {
        expect(recordOfJson(JSON.stringify(storedOfRecord(record)))).toEqual(record);
      }),
    );
  });

  test("decide ignores exactly the PRs that are not open or not from the Owner's own branches", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const ignored = snapshot.state !== "OPEN" || !snapshot.sameRepository || !snapshot.openedByOwner;

        expect(decide(snapshot).kind).toBe(ignored ? "ignore" : "steps");
      }),
      RUNS,
    );
  });

  test("a step that waits for a model's answer is the last, and no Land gate is posted before that answer", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const decision = decide(snapshot);
        const steps = decision.kind === "steps" ? decision.steps : [];
        const waiting = steps.findIndex((step) => MODEL_STEPS.has(step.kind));

        if (waiting !== -1) {
          expect(waiting).toBe(steps.length - 1);
          expect(steps.some((step) => step.kind === "land-gate")).toBe(false);
        }
      }),
      RUNS,
    );
  });

  test("at most one Land gate, followed by nothing but an auto-merge", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const decision = decide(snapshot);
        const steps = decision.kind === "steps" ? decision.steps : [];
        const gates = steps.flatMap((step, index) => (step.kind === "land-gate" ? [index] : []));
        const after = gates.length === 0 ? [] : steps.slice((gates[0] ?? 0) + 1).map((step) => step.kind);

        expect(gates.length).toBeLessThanOrEqual(1);
        expect(after.filter((kind) => kind !== "auto-merge")).toEqual([]);
      }),
      RUNS,
    );
  });

  test("a decision that posts a review ends with its Review check and posts no Land gate: the next decision reads the review", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const steps = stepsOrNone(snapshot);
        const post = steps.findIndex((step) => step.kind === "post-review");

        if (post !== -1) {
          expect(steps.slice(post + 1).map((step) => step.kind)).toEqual(["review-check"]);
          expect(steps.some((step) => step.kind === "land-gate")).toBe(false);
        }
      }),
      RUNS,
    );
  });

  test("while the review asked for this patch has no report, the Review check never turns green and no review is asked again", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const job = snapshot.reviewJob;
        const reported = job?.kind === "completed" && job.result?.kind === "reported";

        if (snapshot.record.review?.patch === snapshot.patch && !reported && !withdrawn(job)) {
          const steps = stepsOrNone(snapshot);

          expect(steps.some((step) => step.kind === "review-check" && step.check.kind === "success")).toBe(false);
          expect(steps.map((step) => step.kind)).not.toContain("request-review");
        }
      }),
      RUNS,
    );
  });

  test("a review is asked only of a ready PR with green CI, routed, with no live review asked for its patch, and the Land gate stays pending", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const steps = stepsOrNone(snapshot);

        if (steps.some((step) => step.kind === "request-review")) {
          expect(snapshot).toMatchObject({ draft: false, ci: "success", conflicting: false });
          expect(snapshot.record.triage[snapshot.patch]).toBeDefined();
          expect(snapshot.record.review?.patch !== snapshot.patch || withdrawn(snapshot.reviewJob)).toBe(true);
          expect(steps.at(-1)?.kind === "land-gate" && steps.at(-1)).toMatchObject({ check: { kind: "pending" } });
        }
      }),
      RUNS,
    );
  });
});
