import { describe, expect, test } from "bun:test";

import {
  afterPrincipalJudge,
  conflictingOf,
  decide,
  EMPTY_RECORD,
  landApprovalCounts,
  openImportantOf,
  patchDeltaStart,
  PRINCIPAL_JUDGE_TRIES,
  risen,
  type Routing,
  type Snapshot,
  type Step,
} from "./decide.ts";

const P1 = "patch-1";

const LIGHT: Routing = { land: "auto", review: "light", secondRound: false, reason: "ordinary code", model: "claude-haiku-5-5" };

const READY: Snapshot = {
  number: 9,
  state: "OPEN",
  sameRepository: true,
  openedByOwner: true,
  draft: false,
  head: "h1",
  patch: P1,
  ci: "success",
  labels: [],
  landApprovalByOwner: false,
  openImportant: 0,
  devRed: false,
  conflicting: false,
  record: { ...EMPTY_RECORD, triage: { [P1]: LIGHT } },
};

function stepsOf(snapshot: Snapshot): readonly Step[] {
  const decision = decide(snapshot);

  if (decision.kind !== "steps") throw new Error(`ignored: ${decision.reason}`);

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
    for (const snapshot of [{ ...READY, draft: true }, { ...READY, ci: null }, { ...READY, ci: "failure" as const }]) {
      expect(kinds(snapshot)).toEqual(["land-gate"]);
      expect(gate(snapshot)).toBe("pending");
    }
  });

  test("a ready PR with green CI and a patch with no Routing is routed first", () => {
    expect(stepsOf({ ...READY, record: EMPTY_RECORD })).toEqual([{ kind: "route", patch: P1, patchDelta: false }]);
  });

  test("a routed patch nobody reviewed gets a Code review at its Review depth, Review round 1", () => {
    expect(stepsOf(READY)).toContainEqual({ kind: "code-review", depth: "light", reviewRound: 1 });
  });

  test("review:none sets the Review check green at once, and a land:auto PR goes to the queue", () => {
    const docs = { ...READY, record: { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, review: "none" as const } } } };

    expect(kinds(docs)).toEqual(["labels", "review-check", "land-gate", "auto-merge"]);
    expect(gate(docs)).toBe("success");
  });

  test("a reviewed patch with an open Important keeps the Review check red and the Land gate pending", () => {
    const snapshot = { ...READY, openImportant: 1, record: { ...READY.record, reviewedPatch: P1, rounds: 1 } };
    const review = stepsOf(snapshot).find((step) => step.kind === "review-check");

    expect(review?.kind === "review-check" && review.check.kind).toBe("failure");
    expect(gate(snapshot)).toBe("pending");
  });

  test("a nit-only review leaves the PR landable", () => {
    expect(gate({ ...READY, record: { ...READY.record, reviewedPatch: P1, rounds: 0 } })).toBe("success");
  });

  test("after one Review round, a fix is reviewed again only when the Routing judges it risky", () => {
    const record = { ...READY.record, reviewedPatch: "patch-0", rounds: 1 };

    expect(kinds({ ...READY, record })).not.toContain("code-review");
    expect(
      stepsOf({ ...READY, record: { ...record, triage: { [P1]: { ...LIGHT, secondRound: true } } } }),
    ).toContainEqual({ kind: "code-review", depth: "light", reviewRound: 2 });
  });

  test("after a review with no Important, a new patch is read again only when the Routing of its Patch delta asks", () => {
    const record = { ...READY.record, reviewedPatch: "patch-0", rounds: 0 };

    expect(kinds({ ...READY, record })).not.toContain("code-review");
    expect(gate({ ...READY, record })).toBe("success");
    expect(
      stepsOf({ ...READY, record: { ...record, triage: { [P1]: { ...LIGHT, secondRound: true } } } }),
    ).toContainEqual({ kind: "code-review", depth: "light", reviewRound: 1 });
  });

  test("a third review round never runs: the PR goes to land:human and needs the owner", () => {
    const steps = stepsOf({
      ...READY,
      record: { ...READY.record, reviewedPatch: "patch-0", rounds: 2, triage: { [P1]: { ...LIGHT, secondRound: true } } },
    });

    expect(steps.map((step) => step.kind)).not.toContain("code-review");
    expect(steps).toContainEqual({ kind: "labels", land: "human", depth: "light" });
    expect(steps.map((step) => step.kind)).toContain("needs-human");
    expect(steps.map((step) => step.kind)).not.toContain("auto-merge");
  });

  test("a landable land:human PR waits for the owner's Land approval, bound to its patch", () => {
    const human = { ...READY, record: { ...READY.record, reviewedPatch: P1, triage: { [P1]: { ...LIGHT, land: "human" as const } } } };

    expect(gate(human)).toBe("pending");
    expect(gate({ ...human, labels: ["land-ok"], landApprovalByOwner: true })).toBe("success");
    expect(kinds({ ...human, labels: ["land-ok"], landApprovalByOwner: true })).toContain("record");
  });

  test("a Land approval label that someone else put, or one given for another patch, is removed", () => {
    const human = { ...READY, labels: ["land-ok"], record: { ...READY.record, reviewedPatch: P1 } };

    expect(kinds({ ...human, landApprovalByOwner: false })).toContain("remove-land-approval");
    expect(kinds({ ...human, landApprovalByOwner: true, record: { ...human.record, landOkPatch: "patch-0" } })).toContain(
      "remove-land-approval",
    );
  });

  test("a ready PR in conflict with dev gets a red Land gate that tells its author to rebase, and runs no model", () => {
    const snapshot = { ...READY, conflicting: true, ci: null, record: EMPTY_RECORD };
    const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

    expect(kinds(snapshot)).toEqual(["land-gate"]);
    expect(step?.kind === "land-gate" && step.check.kind).toBe("failure");
    expect(step?.kind === "land-gate" && step.check.summary).toContain("rebase");
    expect(gate({ ...snapshot, draft: true })).toBe("pending");
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

describe("risen", () => {
  test("labels only rise: a later Routing cannot lower land:human or review:deep", () => {
    expect(risen(["land:human", "review:deep"], LIGHT)).toEqual({ land: "human", depth: "deep" });
    expect(risen(["review:none"], LIGHT)).toEqual({ land: "auto", depth: "light" });
  });
});

describe("conflictingOf", () => {
  test("only GitHub's dirty state is a conflict; unknown, blocked, clean and a missing field are not", () => {
    expect(conflictingOf("dirty")).toBe(true);

    for (const state of ["unknown", "blocked", "clean", "behind", null, undefined]) expect(conflictingOf(state)).toBe(false);
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
  test("a stale Land approval is removed and its patch cleared in the record, even when a routing ends the run", () => {
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

describe("openImportantOf", () => {
  test("an Important posted with no thread stays open until the patch changes", () => {
    const record = { ...EMPTY_RECORD, bodyImportant: { [P1]: 1 } };

    expect(openImportantOf(0, record, P1)).toBe(1);
    expect(openImportantOf(2, record, P1)).toBe(3);
    expect(openImportantOf(0, record, "patch-2")).toBe(0);
    expect(openImportantOf(0, EMPTY_RECORD, P1)).toBe(0);
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

describe("changes to the Land loop's own code and the Principal judge", () => {
  const LAND_LOOP: Routing = { land: "auto", review: "deep", secondRound: true, reason: "land loop", model: null, needsFable: true };
  const landable = { ...READY, record: { ...EMPTY_RECORD, reviewedPatch: P1, triage: { [P1]: LAND_LOOP } } };

  test("a landable change to the Land loop's own code asks the Principal judge before the Land gate can turn green", () => {
    expect(stepsOf(landable)).toContainEqual({ kind: "principal-judge", patch: P1 });
    expect(kinds(landable)).not.toContain("land-gate");
  });

  test("a Principal judge run with no verdict is asked again, up to PRINCIPAL_JUDGE_TRIES times per patch, then counts as NOT OK", () => {
    const cases: [number, boolean][] = [
      [0, true],
      [PRINCIPAL_JUDGE_TRIES - 1, true],
      [PRINCIPAL_JUDGE_TRIES, false],
    ];

    for (const [failures, asked] of cases) {
      const snapshot = { ...landable, record: { ...landable.record, fableFailures: { [P1]: failures } } };

      expect(kinds(snapshot).includes("principal-judge")).toBe(asked);
    }

    const exhausted = { ...landable, record: { ...landable.record, fableFailures: { [P1]: PRINCIPAL_JUDGE_TRIES } } };

    expect(stepsOf(exhausted)).toContainEqual({ kind: "labels", land: "human", depth: "deep" });
    expect(gate(exhausted)).toBe("pending");
    expect(kinds(exhausted)).not.toContain("auto-merge");
  });

  test("failures on another patch do not count for this one", () => {
    const other = { ...landable, record: { ...landable.record, fableFailures: { "patch-0": PRINCIPAL_JUDGE_TRIES } } };

    expect(stepsOf(other)).toContainEqual({ kind: "principal-judge", patch: P1 });
  });

  test("a Principal judge OK lands it as land:auto", () => {
    const ok = { ...landable, record: { ...landable.record, fable: { [P1]: { ok: true, reason: "fine" } } } };

    expect(gate(ok)).toBe("success");
    expect(kinds(ok)).toContain("auto-merge");
  });

  test("any other Principal judge verdict raises it to land:human, waiting for the owner", () => {
    const notOk = { ...landable, record: { ...landable.record, fable: { [P1]: { ok: false, reason: "gate bypass" } } } };

    expect(stepsOf(notOk)).toContainEqual({ kind: "labels", land: "human", depth: "deep" });
    expect(gate(notOk)).toBe("pending");
    expect(kinds(notOk)).not.toContain("auto-merge");
  });

  test("a land:human change to the Land loop's own code still gets its Principal judge, then waits for the owner", () => {
    const human = { ...landable, record: { ...landable.record, triage: { [P1]: { ...LAND_LOOP, land: "human" as const } } } };

    expect(stepsOf(human)).toContainEqual({ kind: "principal-judge", patch: P1 });

    const judged = { ...human, record: { ...human.record, fable: { [P1]: { ok: true, reason: "fine" } } } };

    expect(gate(judged)).toBe("pending");
    expect(kinds(judged)).not.toContain("auto-merge");
  });

  test("an open Important comes before the Principal judge: it never runs on a PR that is not landable", () => {
    expect(kinds({ ...landable, openImportant: 1 })).not.toContain("principal-judge");
  });
});

describe("afterPrincipalJudge", () => {
  test("a run with no verdict adds one failure for its patch and sets no verdict; a verdict is kept and adds none", () => {
    const once = afterPrincipalJudge(EMPTY_RECORD, P1, null);
    const twice = afterPrincipalJudge(once, P1, null);

    expect(once.fableFailures).toEqual({ [P1]: 1 });
    expect(once.fable).toBeUndefined();
    expect(twice.fableFailures).toEqual({ [P1]: 2 });
    expect(afterPrincipalJudge(twice, "patch-2", null).fableFailures).toEqual({ [P1]: 2, "patch-2": 1 });

    const ok = afterPrincipalJudge(twice, P1, { ok: true, reason: "fine" });

    expect(ok.fable).toEqual({ [P1]: { ok: true, reason: "fine" } });
    expect(ok.fableFailures).toEqual({ [P1]: 2 });
  });

  test("two failed runs on a patch end the retries: decide then asks the Principal judge no more", () => {
    const LAND_LOOP: Routing = { land: "auto", review: "deep", secondRound: true, reason: "land loop", model: null, needsFable: true };
    const record = afterPrincipalJudge(afterPrincipalJudge({ ...EMPTY_RECORD, reviewedPatch: P1, triage: { [P1]: LAND_LOOP } }, P1, null), P1, null);

    expect(kinds({ ...READY, record })).not.toContain("principal-judge");
  });
});
