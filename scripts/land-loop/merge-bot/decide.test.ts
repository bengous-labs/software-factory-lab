import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import {
  afterPrincipalJudge,
  conflictingOf,
  decide,
  EMPTY_RECORD,
  LAND_APPROVAL_LABEL,
  landApprovalCounts,
  openImportantOf,
  patchDeltaStart,
  PRINCIPAL_JUDGE_TRIES,
  recordOfJson,
  recordOfStored,
  risen,
  storedOfRecord,
} from "./decide.ts";
import type { RoutingAnswer, Snapshot, StateRecord, Step, StoredRecord } from "./decide.ts";

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

  test("a ready PR with green CI and a patch with no Routing answer is routed first", () => {
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
  const LAND_LOOP: RoutingAnswer = {
    land: "auto",
    review: "deep",
    secondRound: true,
    reason: "land loop",
    model: null,
    needsFable: true,
  };

  const RISKY = { ...LIGHT, secondRound: true };

  // Rounds run, the patch the last one read (P1 is this one), Routing answer, open Important; then the
  // Review round asked, the Owner asked, the Principal judge asked, and the Land gate (null: a model step ends the decision first).
  const rows: Array<
    [string, number, string | null, RoutingAnswer, number, 1 | 2 | null, boolean, boolean, string | null]
  > = [
    ["no Review round yet: Review round 1", 0, null, LIGHT, 0, 1, false, false, null],
    ["a Nit-only Review round 1, then a risky push: Review round 2", 1, "patch-0", RISKY, 0, 2, false, false, null],
    [
      "a Nit-only Review round 1, then a push that needs no review: landable on its Land route",
      1,
      "patch-0",
      LIGHT,
      0,
      null,
      false,
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
      false,
      null,
    ],
    [
      "an Important in Review round 1, then a fix that needs no review, resolved: landable",
      1,
      "patch-0",
      LIGHT,
      0,
      null,
      false,
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
      false,
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
      false,
      "success",
    ],
    [
      "two Review rounds with no Important on the Land loop's own code: the Principal judge runs",
      2,
      P1,
      LAND_LOOP,
      0,
      null,
      false,
      true,
      null,
    ],
    [
      "two Review rounds on the Land loop's own code, then a patch that needs none: the Principal judge runs",
      2,
      "patch-0",
      { ...LAND_LOOP, secondRound: false },
      0,
      null,
      false,
      true,
      null,
    ],
    [
      "two Review rounds on the Land loop's own code, then a patch that needs another: the Owner, no Principal judge",
      2,
      "patch-0",
      LAND_LOOP,
      0,
      null,
      true,
      false,
      "pending",
    ],
  ];

  for (const [
    name,
    reviewRounds,
    reviewedPatch,
    routing,
    openImportant,
    reviewRound,
    toOwner,
    principalJudge,
    landGate,
  ] of rows) {
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
      const review = steps.find((step) => step.kind === "code-review");

      expect(review?.kind === "code-review" ? review.reviewRound : null).toBe(reviewRound);
      expect(steps.some((step) => step.kind === "needs-owner")).toBe(toOwner);
      expect(steps.some((step) => step.kind === "labels" && step.route === "owner")).toBe(toOwner);
      expect(steps.some((step) => step.kind === "principal-judge")).toBe(principalJudge);
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
  test("labels only rise: a later Routing answer cannot lower land:human or review:deep", () => {
    expect(risen(["land:human", "review:deep"], LIGHT)).toEqual({ route: "owner", depth: "deep" });
    expect(risen(["review:none"], LIGHT)).toEqual({ route: "auto", depth: "light" });
  });
});

describe("the stored record", () => {
  test("a stored human Land route reads as owner and is stored again as human; every other field is kept", () => {
    const stored: StoredRecord = {
      ...EMPTY_RECORD,
      reviewedPatch: P1,
      reviewRounds: 1,
      triage: { [P1]: { ...LIGHT, land: "human" }, "patch-2": { ...LIGHT, land: "auto" } },
      fableFailures: { [P1]: 1 },
    };

    const record = recordOfStored(stored);

    expect(record.triage[P1]?.land).toBe("owner");
    expect(record.triage["patch-2"]?.land).toBe("auto");
    expect(record).toMatchObject({ reviewedPatch: P1, reviewRounds: 1, fableFailures: { [P1]: 1 } });
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

  test("a record is stored with its reviewRounds, and reads back the same", () => {
    const record = recordOfJson(
      JSON.stringify({ reviewRounds: 1, reviewedPatch: P1, triage: { [P1]: { ...LIGHT, land: "human" } } }),
    );

    const stored = storedOfRecord(record);

    expect(stored.reviewRounds).toBe(1);
    expect(recordOfJson(JSON.stringify(stored))).toEqual(record);
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
  const LAND_LOOP: RoutingAnswer = {
    land: "auto",
    review: "deep",
    secondRound: true,
    reason: "land loop",
    model: null,
    needsFable: true,
  };

  const landable = {
    ...READY,
    record: { ...EMPTY_RECORD, reviewedPatch: P1, reviewRounds: 1, triage: { [P1]: LAND_LOOP } },
  };

  test("a landable change to the Land loop's own code asks the Principal judge before the Land gate can turn green", () => {
    expect(stepsOf(landable)).toContainEqual({ kind: "principal-judge", patch: P1 });
    expect(kinds(landable)).not.toContain("land-gate");
  });

  test("a Principal judge run with no verdict is asked again, up to PRINCIPAL_JUDGE_TRIES times per patch, then counts as NOT OK", () => {
    const cases: Array<[number, boolean]> = [
      [0, true],
      [PRINCIPAL_JUDGE_TRIES - 1, true],
      [PRINCIPAL_JUDGE_TRIES, false],
    ];

    for (const [failures, asked] of cases) {
      const snapshot = { ...landable, record: { ...landable.record, fableFailures: { [P1]: failures } } };

      expect(kinds(snapshot).includes("principal-judge")).toBe(asked);
    }

    const exhausted = { ...landable, record: { ...landable.record, fableFailures: { [P1]: PRINCIPAL_JUDGE_TRIES } } };

    expect(stepsOf(exhausted)).toContainEqual({ kind: "labels", route: "owner", depth: "deep" });
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
    const notOk = {
      ...landable,
      record: { ...landable.record, fable: { [P1]: { ok: false, reason: "gate bypass" } } },
    };

    expect(stepsOf(notOk)).toContainEqual({ kind: "labels", route: "owner", depth: "deep" });
    expect(gate(notOk)).toBe("pending");
    expect(kinds(notOk)).not.toContain("auto-merge");
  });

  test("a land:human change to the Land loop's own code still gets its Principal judge, then waits for the owner", () => {
    const owner = {
      ...landable,
      record: { ...landable.record, triage: { [P1]: { ...LAND_LOOP, land: "owner" as const } } },
    };

    expect(stepsOf(owner)).toContainEqual({ kind: "principal-judge", patch: P1 });

    const judged = { ...owner, record: { ...owner.record, fable: { [P1]: { ok: true, reason: "fine" } } } };

    expect(gate(judged)).toBe("pending");
    expect(kinds(judged)).not.toContain("auto-merge");
  });

  test("an open Important comes before the Principal judge: it never runs on a PR that is not landable", () => {
    expect(kinds({ ...landable, openImportant: 1 })).not.toContain("principal-judge");
  });
});

describe("afterPrincipalJudge", () => {
  test("a Principal judge run with no verdict adds one failure for its patch and sets no verdict; a verdict is kept and adds none", () => {
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
    const LAND_LOOP: RoutingAnswer = {
      land: "auto",
      review: "deep",
      secondRound: true,
      reason: "land loop",
      model: null,
      needsFable: true,
    };

    const record = afterPrincipalJudge(
      afterPrincipalJudge({ ...EMPTY_RECORD, reviewedPatch: P1, triage: { [P1]: LAND_LOOP } }, P1, null),
      P1,
      null,
    );

    expect(kinds({ ...READY, record })).not.toContain("principal-judge");
  });
});

const PATCH = fc.constantFrom(P1, "patch-2");

const HEAD = fc.constantFrom("h1", "h2");

const ROUTING: fc.Arbitrary<RoutingAnswer> = fc.record(
  {
    land: fc.constantFrom("auto", "owner"),
    review: fc.constantFrom("none", "light", "deep"),
    secondRound: fc.boolean(),
    reason: fc.string(),
    model: fc.option(fc.string(), { nil: null }),
    needsFable: fc.boolean(),
  },
  { requiredKeys: ["land", "review", "secondRound", "reason", "model"] },
);

/** A state record whose patches are `patch`, so that a snapshot's patch meets its entries. */
const recordOf = (patch: fc.Arbitrary<string>): fc.Arbitrary<StateRecord> =>
  fc.record(
    {
      reviewedPatch: fc.option(patch, { nil: null }),
      reviewedHead: fc.option(HEAD, { nil: null }),
      reviewRounds: fc.integer({ min: 0, max: 2 }),
      triage: fc.dictionary(patch, ROUTING),
      landOkPatch: fc.option(patch, { nil: null }),
      dequeued: fc.option(fc.record({ head: HEAD, reason: fc.string() }), { nil: null }),
      bodyImportant: fc.dictionary(patch, fc.nat({ max: 3 })),
      fable: fc.dictionary(patch, fc.record({ ok: fc.boolean(), reason: fc.string() })),
      fableFailures: fc.dictionary(patch, fc.nat({ max: 3 })),
    },
    { requiredKeys: ["reviewedPatch", "reviewedHead", "reviewRounds", "triage", "landOkPatch", "dequeued"] },
  );

const LABELS = ["land:auto", "land:human", "review:none", "review:light", "review:deep", LAND_APPROVAL_LABEL];

/** Mostly open PRs from the Owner's own branches, the ones `decide` does more than ignore. */
const SNAPSHOT: fc.Arbitrary<Snapshot> = fc.record({
  number: fc.nat(),
  state: fc.oneof({ arbitrary: fc.constant("OPEN"), weight: 8 }, fc.constantFrom("CLOSED", "MERGED")),
  sameRepository: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, fc.constant(false)),
  openedByOwner: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, fc.constant(false)),
  draft: fc.boolean(),
  head: HEAD,
  patch: PATCH,
  ci: fc.constantFrom("success", "failure", null),
  labels: fc.subarray(LABELS),
  landApprovalByOwner: fc.boolean(),
  openImportant: fc.nat({ max: 2 }),
  devRed: fc.boolean(),
  conflicting: fc.boolean(),
  record: recordOf(PATCH),
});

const RUNS = { numRuns: 2000 };

const MODEL_STEPS: ReadonlySet<Step["kind"]> = new Set(["route", "code-review", "principal-judge"]);

const REVIEW_RANK: Readonly<Record<RoutingAnswer["review"], number>> = { none: 0, light: 1, deep: 2 };

describe("the Merge bot's invariants", () => {
  test("risen: the route is owner exactly when the PR carries land:human or the answer says owner", () => {
    fc.assert(
      fc.property(fc.subarray(LABELS), ROUTING, (labels, routing) => {
        const expected = labels.includes("land:human") || routing.land === "owner" ? "owner" : "auto";

        expect(risen(labels, routing).route).toBe(expected);
      }),
    );
  });

  test("risen: the depth is the deepest of the PR's review labels and the answer's", () => {
    fc.assert(
      fc.property(fc.subarray(LABELS), ROUTING, (labels, routing) => {
        const onPr = (["none", "light", "deep"] as const).filter((depth) => labels.includes(`review:${depth}`));
        const deepest = Math.max(REVIEW_RANK[routing.review], ...onPr.map((depth) => REVIEW_RANK[depth]));

        expect(REVIEW_RANK[risen(labels, routing).depth]).toBe(deepest);
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

  test("an auto-merge comes last, after a green Land gate, on a PR that is ready, green, unblocked and routed", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const decision = decide(snapshot);
        const steps = decision.kind === "steps" ? decision.steps : [];
        const merge = steps.findIndex((step) => step.kind === "auto-merge");

        if (merge !== -1) {
          const gateStep = steps[merge - 1];

          expect(merge).toBe(steps.length - 1);
          expect(gateStep?.kind === "land-gate" ? gateStep.check.kind : undefined).toBe("success");
          expect(snapshot).toMatchObject({
            draft: false,
            ci: "success",
            openImportant: 0,
            devRed: false,
            conflicting: false,
          });
          expect(snapshot.record.dequeued?.head).not.toBe(snapshot.head);
          expect(snapshot.record.triage[snapshot.patch]).toBeDefined();
        }
      }),
      RUNS,
    );
  });

  test("without the Owner's Land approval, an auto-merge needs no land:human on the PR and an auto Routing answer", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const decision = decide(snapshot);
        const merged = decision.kind === "steps" && decision.steps.some((step) => step.kind === "auto-merge");
        const approved = snapshot.landApprovalByOwner && snapshot.labels.includes(LAND_APPROVAL_LABEL);

        if (merged && !approved) {
          expect(snapshot.labels).not.toContain("land:human");
          expect(snapshot.record.triage[snapshot.patch]?.land).toBe("auto");
        }
      }),
      RUNS,
    );
  });
});
