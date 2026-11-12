import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import { LAND_APPROVAL_LABEL } from "../../contract.ts";
import {
  HUMAN_LABEL_BY,
  LABELS,
  recordOf,
  ROUTING,
  RUNS,
  SNAPSHOT,
  stepsOrNone,
  withdrawn,
} from "../arbitraries.fixtures.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import { decide } from "./decide.ts";
import { gateWaitOf, risen } from "./gate.ts";
import { gate, important, kinds, LIGHT, P1, READY, stepsOf } from "./merge-bot.fixtures.ts";
import { EMPTY_RECORD, recordOfJson, storedOfRecord } from "./record.ts";
import type { CheckState, Step } from "./steps.ts";

const securityOf = (routing: RoutingAnswer, record = READY.record): boolean | null => {
  const review = stepsOf({ ...READY, record: { ...record, triage: { [P1]: routing } } }).find(
    (step) => step.kind === "request-review",
  );

  return review?.kind === "request-review" ? review.security : null;
};

describe("decide", () => {
  test("closed PRs, PRs from forks and PRs opened by neither the Owner nor the Author are ignored", () => {
    expect(decide({ ...READY, state: "MERGED" })).toEqual({ kind: "ignore", reason: "#9 is merged" });
    expect(decide({ ...READY, sameRepository: false }).kind).toBe("ignore");
    expect(decide({ ...READY, openedByFactory: false })).toEqual({
      kind: "ignore",
      reason: `#${READY.number} was not opened by the Owner or the Author`,
    });
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
      { kind: "request-review", depth: "light", reviewRound: 1, security: false },
      { kind: "review-check", check: running },
      { kind: "land-gate", check: running },
    ]);
  });

  test("the review asks a security pass exactly when the patch's Routing answer says so; an answer with no flag asks none", () => {
    const round2 = { ...READY.record, reviewedPatch: "patch-0", reviewRounds: 1 };

    expect(securityOf({ ...LIGHT, security: true })).toBe(true);
    expect(securityOf({ ...LIGHT, security: false })).toBe(false);
    expect(securityOf(LIGHT)).toBe(false);
    expect(securityOf({ ...LIGHT, secondRound: true, security: true }, round2)).toBe(true);
  });

  test("review:none sets the Review check green at once, and a land:auto PR goes to the queue", () => {
    const docs = { ...READY, record: { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, review: "none" as const } } } };

    expect(kinds(docs)).toEqual(["labels", "review-check", "land-gate", "auto-merge"]);
    expect(gate(docs)).toBe("success");
  });

  test("a reviewed patch with an open Important keeps the Review check red and the Land gate pending", () => {
    const snapshot = {
      ...READY,
      openImportant: important(1),
      record: { ...READY.record, reviewedPatch: P1, reviewRounds: 1 },
    };

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

    expect(stepsOf(owner).at(-1)).toEqual({
      kind: "land-gate",
      check: {
        kind: "pending",
        summary:
          "Held for the Owner: ordinary code. Waiting for the Owner's Land approval (label land-ok). To keep it held whatever later pushes change, remove land:human and add it back.",
      },
    });
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

  test("a Land approval label that someone else put, the Author's machine account included, or one given for another patch, is removed", () => {
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
    expect(decide({ ...READY, empty: true, openedByFactory: false }).kind).toBe("ignore");
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

const OWNER_WAIT = /waiting for the owner's land approval/iu;

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

  test("a decision that ends waiting for the Owner says so in its Land gate, and a waits comment comes only with such a gate", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const steps = stepsOrNone(snapshot);
        const labels = steps.find((step) => step.kind === "labels");
        const last = steps.at(-1);
        const summary = last?.kind === "land-gate" ? last.check.summary : "";

        // After Review round 3 the Owner is the last reader: an open Important does not keep a held PR from waiting for the Owner.
        const held =
          snapshot.record.ownerHold !== undefined ||
          steps.some((step) => step.kind === "record" && step.record.ownerHold !== undefined);

        const waitsForOwner =
          labels?.kind === "labels" &&
          labels.route === "owner" &&
          last?.kind === "land-gate" &&
          last.check.kind === "pending" &&
          !steps.some((step) => step.kind === "request-review") &&
          (snapshot.openImportant.length === 0 || held) &&
          !snapshot.devRed;

        expect(OWNER_WAIT.test(summary)).toBe(waitsForOwner);
        expect(gateWaitOf(summary) === "owner").toBe(waitsForOwner);

        if (steps.some((step) => step.kind === "owner-comment" && step.body.startsWith("This PR waits"))) {
          expect(waitsForOwner).toBe(true);
        }
      }),
      RUNS,
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
        const ignored = snapshot.state !== "OPEN" || !snapshot.sameRepository || !snapshot.openedByFactory;

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

  test("a decision that posts a review records the round, ends with its Review check and posts no Land gate: the next decision reads the review", () => {
    fc.assert(
      fc.property(SNAPSHOT, (snapshot) => {
        const steps = stepsOrNone(snapshot);
        const post = steps.findIndex((step) => step.kind === "post-review");

        if (post !== -1) {
          const after = steps.slice(post + 1).map((step) => step.kind);

          const before: ReadonlyArray<Step["kind"]> = [
            "resolve-threads",
            "to-draft",
            "remove-land-approval",
            "owner-comment",
          ];

          expect(after.filter((kind) => !before.includes(kind))).toEqual(["record", "review-check"]);

          for (const kind of before) {
            expect(after.indexOf(kind)).toBeLessThan(after.indexOf("record"));
          }

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
