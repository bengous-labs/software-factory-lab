import { describe, expect, test } from "bun:test";

import { LAND_APPROVAL_LABEL } from "../../contract.ts";
import { gateWaitOf, risen } from "./gate.ts";
import {
  afterRound3,
  EARLIER_PATCH_COMMENT,
  gate,
  gateSummary,
  important,
  kinds,
  LIGHT,
  P1,
  READY,
  reviewed,
  stepsOf,
} from "./merge-bot.fixtures.ts";
import { EMPTY_RECORD, recordOfJson, storedOfRecord } from "./record.ts";
import type { Snapshot } from "./snapshot.ts";

describe("an Owner hold", () => {
  const RISKY = { ...LIGHT, secondRound: true };

  test("a push after Review round 3 that needs a read sets the hold in the record written first, with its reason", () => {
    const record = afterRound3(RISKY);
    const steps = stepsOf({ ...READY, record });

    expect(steps[0]).toEqual({
      kind: "record",
      record: { ...record, ownerHold: "A push after Review round 3 needs a read." },
    });
    expect(steps.at(-1)).toEqual({
      kind: "land-gate",
      check: {
        kind: "pending",
        summary:
          "Held for the Owner: A push after Review round 3 needs a read. Waiting for the Owner's Land approval (label land-ok).",
      },
    });
  });

  describe("after Review round 3, the Owner is the last reader", () => {
    const held = afterRound3(LIGHT, {
      reviewedPatch: P1,
      importantByRound: [1, 1, 2],
      ownerHold: "Review round 3 posted 2 Important finding(s).",
      ownerAskedPatch: P1,
    });

    const open = { ...READY, openImportant: important(2), record: held };

    const approved = {
      ...open,
      labels: [LAND_APPROVAL_LABEL],
      landApprovalByOwner: true,
      record: { ...held, landOkPatch: P1 },
    };

    test("a PR with an open Important lands with the Owner's Land approval for its patch, which opens one follow-up issue for them, then lands each open thread open", () => {
      expect(stepsOf(approved)).toEqual([
        { kind: "labels", route: "owner", depth: "light" },
        { kind: "follow-up", threads: ["T1", "T2"] },
        { kind: "land-open", threads: ["T1", "T2"] },
        {
          kind: "review-check",
          check: { kind: "success", summary: "2 Important finding(s) closed by the Owner's Land approval." },
        },
        {
          kind: "land-gate",
          check: { kind: "success", summary: "Landable, with the Owner's Land approval (label land-ok)." },
        },
        { kind: "auto-merge" },
      ]);
    });

    test("it does not land without it: its Review check stays red, and its Land gate waits for the Owner", () => {
      expect(stepsOf(open)).toEqual([
        { kind: "labels", route: "owner", depth: "light" },
        { kind: "review-check", check: { kind: "failure", summary: "2 Important finding(s) open." } },
        {
          kind: "land-gate",
          check: {
            kind: "pending",
            summary:
              "Held for the Owner: Review round 3 posted 2 Important finding(s). Waiting for the Owner's Land approval (label land-ok).",
          },
        },
      ]);
    });

    test("the Owner is asked once per patch, though Important threads are open", () => {
      const { ownerAskedPatch: _asked, ...unasked } = held;

      expect(kinds({ ...open, record: unasked })).toEqual([
        "labels",
        "review-check",
        "owner-comment",
        "record",
        "land-gate",
      ]);
    });

    test("a second run over the approved PR opens no second follow-up issue: the record holds the first", () => {
      const followed = { ...approved, record: { ...approved.record, followUpIssue: 31 } };

      expect(stepsOf(followed)).toEqual([
        { kind: "labels", route: "owner", depth: "light" },
        { kind: "land-open", threads: ["T1", "T2"] },
        {
          kind: "review-check",
          check: { kind: "success", summary: "2 Important finding(s) closed by the Owner's Land approval." },
        },
        {
          kind: "land-gate",
          check: { kind: "success", summary: "Landable, with the Owner's Land approval (label land-ok)." },
        },
        { kind: "auto-merge" },
      ]);
      expect(kinds({ ...followed, openImportant: [] })).toEqual(["labels", "review-check", "land-gate", "auto-merge"]);
    });

    test("a Land approval given for another patch, or by another login, closes nothing, lands nothing and opens no issue", () => {
      const earlier = { ...approved, record: { ...held, landOkPatch: "patch-0" } };
      const notOwner = { ...approved, landApprovalByOwner: false };

      for (const snapshot of [earlier, notOwner]) {
        expect(kinds(snapshot)).not.toContain("land-open");
        expect(kinds(snapshot)).not.toContain("follow-up");
        expect(kinds(snapshot)).not.toContain("auto-merge");
      }
    });

    test("with no Owner hold, a Land approval lands no PR whose Important is open: a round or a rejection closes it", () => {
      const { ownerHold: _hold, ...unheld } = held;
      const snapshot = { ...approved, record: { ...unheld, reviewRounds: 2, landOkPatch: P1 } };

      expect(kinds(snapshot)).not.toContain("land-open");
      expect(kinds(snapshot)).not.toContain("follow-up");
      expect(kinds(snapshot)).not.toContain("auto-merge");
      expect(stepsOf(snapshot).at(-1)).toEqual({
        kind: "land-gate",
        check: { kind: "pending", summary: "Not landable: Important findings are open." },
      });
    });

    test("while dev is red the approved PR waits: it does not land, so its threads stay open and no issue says they landed", () => {
      expect(stepsOf({ ...approved, devRed: true })).toEqual([
        { kind: "labels", route: "owner", depth: "light" },
        { kind: "review-check", check: { kind: "failure", summary: "2 Important finding(s) open." } },
        { kind: "land-gate", check: { kind: "pending", summary: "dev is red: landing is on hold." } },
      ]);
    });

    test("with no Important open, every one fixed or rejected, the approved PR lands as any other: nothing to resolve, no issue", () => {
      expect(kinds({ ...approved, openImportant: [], rejectedImportant: 1 })).toEqual([
        "labels",
        "review-check",
        "land-gate",
        "auto-merge",
      ]);
    });

    test("with no Important open, the approved PR lands as any other: nothing to resolve", () => {
      expect(stepsOf({ ...approved, openImportant: [] })).toEqual([
        { kind: "labels", route: "owner", depth: "light" },
        { kind: "review-check", check: { kind: "success", summary: "No Important finding open." } },
        {
          kind: "land-gate",
          check: { kind: "success", summary: "Landable, with the Owner's Land approval (label land-ok)." },
        },
        { kind: "auto-merge" },
      ]);
    });

    test("an open Important keeps the Review check red on a held PR whose depth is none", () => {
      const unread = { ...held, triage: { [P1]: { ...LIGHT, review: "none" as const } } };

      expect(stepsOf({ ...open, record: unread })).toContainEqual({
        kind: "review-check",
        check: { kind: "failure", summary: "2 Important finding(s) open." },
      });
    });
  });

  test("a push after Review round 3 that needs no read, or a patch not routed yet, sets no hold", () => {
    expect(kinds({ ...READY, record: afterRound3(LIGHT) })).not.toContain("record");
    expect(stepsOf({ ...READY, record: { ...afterRound3(RISKY), triage: {} } })).toEqual([
      { kind: "route", patch: P1, patchDelta: true },
    ]);
  });

  test("a push after a clean Review round 3 routed as only answering its Nits sets no hold: it lands on land:auto, and waits for the Owner on land:human", () => {
    const answered = { ...RISKY, secondRound: false, reason: "a push after Review round 3 that only answers its Nits" };
    const auto = { ...READY, record: afterRound3(answered) };
    const human = { ...READY, record: afterRound3({ ...answered, land: "owner" }) };

    expect(kinds(auto)).not.toContain("record");
    expect(kinds(auto)).toContain("auto-merge");
    expect(stepsOf(human).filter((step) => step.kind === "record" && step.record.ownerHold !== undefined)).toEqual([]);
    expect(kinds(human)).not.toContain("auto-merge");
    expect(gate(human)).toBe("pending");
  });

  test("a held PR lands only with the Owner's Land approval on its current patch, and a later push removes that approval", () => {
    const held = {
      ...READY,
      record: afterRound3(LIGHT, { ownerHold: "Review round 3 posted 2 Important finding(s)." }),
    };

    const approved = { ...held, labels: [LAND_APPROVAL_LABEL], landApprovalByOwner: true };

    expect(kinds(held)).not.toContain("auto-merge");
    expect(stepsOf(held).at(-1)).toEqual({
      kind: "land-gate",
      check: {
        kind: "pending",
        summary:
          "Held for the Owner: Review round 3 posted 2 Important finding(s). Waiting for the Owner's Land approval (label land-ok).",
      },
    });
    expect(kinds(approved)).toContain("auto-merge");

    const pushed = { ...approved, record: { ...approved.record, landOkPatch: "patch-0" } };

    expect(kinds(pushed)).toContain("remove-land-approval");
    expect(kinds(pushed)).not.toContain("auto-merge");
    expect(stepsOf(pushed)).toContainEqual({ kind: "record", record: { ...pushed.record, landOkPatch: null } });
  });

  test("the hold keeps a land:human the Merge bot set, in one labels step", () => {
    const record = afterRound3(LIGHT, { ownerHold: "A push after Review round 3 needs a read." });
    const steps = stepsOf({ ...READY, labels: ["land:human"], humanLabelBy: "merge-bot", record });

    expect(steps.filter((step) => step.kind === "labels")).toEqual([
      { kind: "labels", route: "owner", depth: "light" },
    ]);
  });

  test("the hold set once stays, and the record is not written again", () => {
    const record = afterRound3(RISKY, {
      ownerHold: "Review round 3 posted 1 Important finding(s).",
      ownerAskedPatch: P1,
    });

    expect(kinds({ ...READY, record })).not.toContain("record");
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

  test("the Author's machine account set sends no PR to the Owner: it falls to land:auto when the route is auto", () => {
    const snapshot = { ...BOT_LABELED, humanLabelBy: "author" as const, record: reviewed(LIGHT) };

    expect(landRoute(snapshot)).toBe("auto");
    expect(kinds(snapshot)).toContain("auto-merge");
    expect(landRoute({ ...snapshot, record: reviewed({ ...LIGHT, land: "owner" }) })).toBe("owner");
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

describe("Land approval across a patch change", () => {
  test("a stale Land approval is removed and its patch cleared in the record, even when a routing ends the decision", () => {
    const snapshot = {
      ...READY,
      labels: ["land-ok"],
      landApprovalByOwner: true,
      record: { ...EMPTY_RECORD, landOkPatch: "patch-0" },
    };

    const steps = stepsOf(snapshot);

    expect(steps.map((step) => step.kind)).toEqual(["owner-comment", "remove-land-approval", "record", "route"]);
    expect(steps[2]).toEqual({ kind: "record", record: { ...EMPTY_RECORD, landOkPatch: null } });
  });

  test("a Land approval patch left in the record without the label is cleared, so a new Land approval counts", () => {
    const record = { ...READY.record, reviewedPatch: P1, landOkPatch: "patch-0" };

    expect(stepsOf({ ...READY, record })).toContainEqual({ kind: "record", record: { ...record, landOkPatch: null } });
  });
});

const NOT_OWNER_COMMENT =
  "Only the Owner's Land approval counts: the Merge bot removed a land-ok the Owner did not put.";

const NOT_ROUTED = " This push is not routed yet: its labels are the previous push's.";

const OWNER_PATH = {
  ...LIGHT,
  land: "owner" as const,
  reason: "touches a path the Owner lands: .github/workflows/ci.yml",
};

const commentsOf = (snapshot: Snapshot): string[] =>
  stepsOf(snapshot).flatMap((step) => (step.kind === "owner-comment" ? [step.body] : []));

describe("why a PR is held, where the Owner looks", () => {
  test("a land:human the Merge bot did not set names itself as the reason", () => {
    const vetoed = { ...READY, labels: ["land:human"], humanLabelBy: "other" as const, record: reviewed(LIGHT) };

    expect(gateSummary(vetoed)).toBe(
      "Held for the Owner: a land:human the Merge bot did not set. Waiting for the Owner's Land approval (label land-ok).",
    );
    expect(gateSummary({ ...vetoed, record: reviewed(OWNER_PATH) })).toBe(gateSummary(vetoed));
  });

  test("the Routing rules' reason is named, with the gesture that keeps the PR held", () => {
    const breaking = { ...OWNER_PATH, reason: "a breaking commit: feat(app)!: drop the v1 task file" };

    expect(gateSummary({ ...READY, record: reviewed(OWNER_PATH) })).toBe(
      "Held for the Owner: touches a path the Owner lands: .github/workflows/ci.yml. Waiting for the Owner's Land approval (label land-ok). To keep it held whatever later pushes change, remove land:human and add it back.",
    );
    expect(gateSummary({ ...READY, record: reviewed(breaking) })).toBe(
      "Held for the Owner: a breaking commit: feat(app)!: drop the v1 task file. Waiting for the Owner's Land approval (label land-ok). To keep it held whatever later pushes change, remove land:human and add it back.",
    );
  });

  test("the Owner hold comes first, before a land:human the Merge bot did not set", () => {
    const held = reviewed(OWNER_PATH, { ownerHold: "Review round 3 posted 1 Important finding(s)." });

    expect(gateSummary({ ...READY, labels: ["land:human"], humanLabelBy: "other", record: held })).toBe(
      "Held for the Owner: Review round 3 posted 1 Important finding(s). Waiting for the Owner's Land approval (label land-ok).",
    );
  });

  test("gateWaitOf reads a held PR's Land gate as the Owner's wait, a running Review round's as the review's, any other as neither", () => {
    expect(gateWaitOf(gateSummary({ ...READY, record: reviewed(OWNER_PATH) }) ?? "")).toBe("owner");
    expect(gateWaitOf(gateSummary(READY) ?? "")).toBe("review");
    expect(gateWaitOf("Review round 3 running.")).toBe("review");
    expect(gateWaitOf("Delta read running.")).toBe("review");
    expect(gateWaitOf("Review round 4 running.")).toBeNull();
    expect(gateWaitOf(gateSummary({ ...READY, ci: null }) ?? "")).toBeNull();
    expect(gateWaitOf("Landable, land:auto.")).toBeNull();
  });

  test("a push not routed yet says its labels are the previous push's, while CI runs and once it is red", () => {
    const unrouted = { ...READY, record: { ...EMPTY_RECORD, triage: { "patch-0": LIGHT } } };

    expect(gateSummary({ ...unrouted, ci: null })).toBe(`Waiting for validate and mutation.${NOT_ROUTED}`);
    expect(gateSummary({ ...unrouted, ci: "failure" })).toBe(
      `validate or mutation is red: the author's turn.${NOT_ROUTED}`,
    );
  });

  test("a routed push, a rerun's included, and the first push of a PR keep their CI summaries", () => {
    for (const snapshot of [READY, { ...READY, record: EMPTY_RECORD }]) {
      expect(gateSummary({ ...snapshot, ci: null })).toBe("Waiting for validate and mutation.");
      expect(gateSummary({ ...snapshot, ci: "failure" })).toBe("validate or mutation is red: the author's turn.");
    }
  });

  test("a land-ok given for an earlier push is removed with a comment that says so", () => {
    const stale = {
      ...READY,
      labels: [LAND_APPROVAL_LABEL],
      landApprovalByOwner: true,
      record: reviewed(LIGHT, { landOkPatch: "patch-0" }),
    };

    expect(stepsOf(stale).slice(0, 2)).toEqual([
      { kind: "owner-comment", body: EARLIER_PATCH_COMMENT },
      { kind: "remove-land-approval" },
    ]);
  });

  test("a land-ok the Owner put before a push, which no longer counts, is removed as given for an earlier push, recorded or not", () => {
    const pushed = { ...READY, labels: [LAND_APPROVAL_LABEL], landApprovalPutByOwner: true, record: reviewed(LIGHT) };

    expect(stepsOf(pushed).slice(0, 2)).toEqual([
      { kind: "owner-comment", body: EARLIER_PATCH_COMMENT },
      { kind: "remove-land-approval" },
    ]);

    for (const landOkPatch of ["patch-0", P1]) {
      expect(stepsOf({ ...pushed, record: reviewed(LIGHT, { landOkPatch }) }).slice(0, 3)).toEqual([
        { kind: "owner-comment", body: EARLIER_PATCH_COMMENT },
        { kind: "remove-land-approval" },
        { kind: "record", record: reviewed(LIGHT) },
      ]);
    }
  });

  test("a land-ok the Owner did not put is removed with a comment that says so, though the Owner's was recorded before", () => {
    const foreign = { ...READY, labels: [LAND_APPROVAL_LABEL], record: reviewed(LIGHT) };

    for (const snapshot of [foreign, { ...foreign, record: reviewed(LIGHT, { landOkPatch: P1 }) }]) {
      expect(stepsOf(snapshot).slice(0, 2)).toEqual([
        { kind: "owner-comment", body: NOT_OWNER_COMMENT },
        { kind: "remove-land-approval" },
      ]);
    }

    expect(kinds(foreign)).not.toContain("record");
  });

  test("a PR the Routing rules hold asks the Owner in a comment, then records the patch, before the Land gate", () => {
    const steps = stepsOf({ ...READY, record: reviewed(OWNER_PATH) });

    expect(steps.slice(-3, -1)).toEqual([
      {
        kind: "owner-comment",
        body: "This PR waits for the Owner's Land approval: touches a path the Owner lands: .github/workflows/ci.yml. Add the label land-ok to land it.",
      },
      { kind: "record", record: reviewed(OWNER_PATH, { ownerAskedPatch: P1 }) },
    ]);
    expect(steps.at(-1)?.kind).toBe("land-gate");
  });

  test("a placeholder in the hold is escaped for GitHub in the comment that asks the Owner", () => {
    const record = reviewed(LIGHT, { ownerHold: "rewrites <file> paths." });

    expect(commentsOf({ ...READY, record })).toEqual([
      String.raw`This PR waits for the Owner's Land approval: rewrites &lt;file> paths. Add the label land-ok to land it.`,
    ]);
  });

  test("a PR the Owner hold holds asks the Owner with the hold, its final period left out", () => {
    const record = reviewed(LIGHT, { ownerHold: "Review round 3 posted 2 Important finding(s)." });

    expect(commentsOf({ ...READY, record })).toEqual([
      "This PR waits for the Owner's Land approval: Review round 3 posted 2 Important finding(s). Add the label land-ok to land it.",
    ]);
  });

  test("the waits comment is posted once per patch, and again on a new patch", () => {
    const asked = { ...READY, record: reviewed(OWNER_PATH, { ownerAskedPatch: P1 }) };

    expect(commentsOf(asked)).toEqual([]);
    expect(kinds(asked)).not.toContain("record");
    expect(commentsOf({ ...asked, record: { ...asked.record, ownerAskedPatch: "patch-0" } })).toHaveLength(1);
  });

  test("no comment when a land:human the Merge bot did not set holds the PR, or when it lands", () => {
    const vetoed = { ...READY, labels: ["land:human"], humanLabelBy: "other" as const, record: reviewed(OWNER_PATH) };

    const approved = {
      ...READY,
      labels: [LAND_APPROVAL_LABEL],
      landApprovalByOwner: true,
      record: reviewed(OWNER_PATH),
    };

    expect(commentsOf(vetoed)).toEqual([]);
    expect(commentsOf(approved)).toEqual([]);
    expect(commentsOf({ ...READY, record: reviewed(LIGHT) })).toEqual([]);
  });

  test("a record without ownerAskedPatch reads as no comment posted, and one with it reads back the same", () => {
    const record = { ...EMPTY_RECORD, ownerAskedPatch: P1 };

    expect(recordOfJson(JSON.stringify({ reviewRounds: 1 })).ownerAskedPatch).toBeUndefined();
    expect(recordOfJson(JSON.stringify(storedOfRecord(record)))).toEqual(record);
    expect(() => recordOfJson(JSON.stringify({ ownerAskedPatch: 1 }))).toThrow('at ["ownerAskedPatch"]');
  });
});
