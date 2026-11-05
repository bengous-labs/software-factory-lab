import { describe, expect, test } from "bun:test";

import { decide, EMPTY_RECORD, risen, type Snapshot, type Step, type Triage } from "./decide.ts";

const P1 = "patch-1";

const LIGHT: Triage = { land: "auto", review: "light", secondRound: false, reason: "ordinary code", model: "claude-haiku-5-5" };

const READY: Snapshot = {
  number: 9,
  state: "OPEN",
  sameRepository: true,
  ownAuthor: true,
  draft: false,
  head: "h1",
  patch: P1,
  ci: "success",
  labels: [],
  landOkByOwner: false,
  openImportant: 0,
  devRed: false,
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
  test("closed PRs, PRs from forks and PRs of other authors are ignored", () => {
    expect(decide({ ...READY, state: "MERGED" }).kind).toBe("ignore");
    expect(decide({ ...READY, sameRepository: false }).kind).toBe("ignore");
    expect(decide({ ...READY, ownAuthor: false }).kind).toBe("ignore");
  });

  test("a draft, a pending CI or a red CI leaves land-gate pending and runs no model", () => {
    for (const snapshot of [{ ...READY, draft: true }, { ...READY, ci: null }, { ...READY, ci: "failure" as const }]) {
      expect(kinds(snapshot)).toEqual(["land-gate"]);
      expect(gate(snapshot)).toBe("pending");
    }
  });

  test("a ready PR with green CI and an untriaged patch is triaged first", () => {
    expect(stepsOf({ ...READY, record: EMPTY_RECORD })).toEqual([{ kind: "triage", patch: P1, delta: false }]);
  });

  test("a triaged patch nobody reviewed is reviewed at the triage's level, round 1", () => {
    expect(stepsOf(READY)).toContainEqual({ kind: "review", level: "light", round: 1 });
  });

  test("review:none sets agent-review green at once, and a land:auto PR goes to the queue", () => {
    const docs = { ...READY, record: { ...EMPTY_RECORD, triage: { [P1]: { ...LIGHT, review: "none" as const } } } };

    expect(kinds(docs)).toEqual(["labels", "agent-review", "land-gate", "auto-merge"]);
    expect(gate(docs)).toBe("success");
  });

  test("a reviewed patch with an open Important keeps agent-review red and land-gate pending", () => {
    const snapshot = { ...READY, openImportant: 1, record: { ...READY.record, reviewedPatch: P1, rounds: 1 } };
    const review = stepsOf(snapshot).find((step) => step.kind === "agent-review");

    expect(review?.kind === "agent-review" && review.check.kind).toBe("failure");
    expect(gate(snapshot)).toBe("pending");
  });

  test("a nit-only review leaves the PR converged", () => {
    expect(gate({ ...READY, record: { ...READY.record, reviewedPatch: P1, rounds: 0 } })).toBe("success");
  });

  test("after one round, a fix is reviewed again only when the triage judges it risky", () => {
    const record = { ...READY.record, reviewedPatch: "patch-0", rounds: 1 };

    expect(kinds({ ...READY, record })).not.toContain("review");
    expect(
      stepsOf({ ...READY, record: { ...record, triage: { [P1]: { ...LIGHT, secondRound: true } } } }),
    ).toContainEqual({ kind: "review", level: "light", round: 2 });
  });

  test("after a review with no Important, a new patch is read again only when the triage of its delta asks", () => {
    const record = { ...READY.record, reviewedPatch: "patch-0", rounds: 0 };

    expect(kinds({ ...READY, record })).not.toContain("review");
    expect(gate({ ...READY, record })).toBe("success");
    expect(
      stepsOf({ ...READY, record: { ...record, triage: { [P1]: { ...LIGHT, secondRound: true } } } }),
    ).toContainEqual({ kind: "review", level: "light", round: 1 });
  });

  test("a third round never runs: the PR goes to land:human and needs the owner", () => {
    const steps = stepsOf({
      ...READY,
      record: { ...READY.record, reviewedPatch: "patch-0", rounds: 2, triage: { [P1]: { ...LIGHT, secondRound: true } } },
    });

    expect(steps.map((step) => step.kind)).not.toContain("review");
    expect(steps).toContainEqual({ kind: "labels", land: "human", review: "light" });
    expect(steps.map((step) => step.kind)).toContain("needs-human");
    expect(steps.map((step) => step.kind)).not.toContain("auto-merge");
  });

  test("a converged land:human PR waits for the owner's land-ok, bound to its patch", () => {
    const human = { ...READY, record: { ...READY.record, reviewedPatch: P1, triage: { [P1]: { ...LIGHT, land: "human" as const } } } };

    expect(gate(human)).toBe("pending");
    expect(gate({ ...human, labels: ["land-ok"], landOkByOwner: true })).toBe("success");
    expect(kinds({ ...human, labels: ["land-ok"], landOkByOwner: true })).toContain("record");
  });

  test("a land-ok that someone else put, or one given for another patch, is removed", () => {
    const human = { ...READY, labels: ["land-ok"], record: { ...READY.record, reviewedPatch: P1 } };

    expect(kinds({ ...human, landOkByOwner: false })).toContain("remove-land-ok");
    expect(kinds({ ...human, landOkByOwner: true, record: { ...human.record, landOkPatch: "patch-0" } })).toContain(
      "remove-land-ok",
    );
  });

  test("a red dev holds a converged PR", () => {
    expect(gate({ ...READY, devRed: true, record: { ...READY.record, reviewedPatch: P1 } })).toBe("pending");
  });

  test("a PR the queue removed at this head gets a red land-gate with the reason", () => {
    const snapshot = { ...READY, record: { ...READY.record, dequeued: { head: "h1", reason: "merge conflict" } } };
    const step = stepsOf(snapshot).find((found) => found.kind === "land-gate");

    expect(step?.kind === "land-gate" && step.check).toEqual({
      kind: "failure",
      summary: "The merge queue removed this PR: merge conflict",
    });
    expect(gate({ ...snapshot, head: "h2" })).not.toBe("failure");
  });

  test("the same snapshot read twice gives the same steps", () => {
    expect(decide(READY)).toEqual(decide(READY));
  });
});

describe("risen", () => {
  test("labels only rise: a later triage cannot lower land:human or review:deep", () => {
    expect(risen(["land:human", "review:deep"], LIGHT)).toEqual({ land: "human", review: "deep" });
    expect(risen(["review:none"], LIGHT)).toEqual({ land: "auto", review: "light" });
  });
});
