/**
 * The Land loop's safety guarantees, as properties over the pure decisions that enforce them: the
 * Routing rules and the Merge bot's `decide`. A change to that code that breaks one fails `bun check`;
 * a change that weakens one here shows in its diff, for the Code review to read. The generators the
 * guarantees draw from live here too; the other tests of those modules import them, so a mutation pass
 * of either module runs these guarantees.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as fc from "fast-check";

import { FACTORY_CONFIG_PATH, factoryConfigOf } from "./factory-config.ts";
import type { RoutingPolicy } from "./factory-config.ts";
import { decide, LAND_APPROVAL_LABEL } from "./merge-bot/decide.ts";
import type { ReviewJob, ReviewState, RoutingAnswer, Snapshot, StateRecord, Step } from "./merge-bot/decide.ts";
import type { ReportedFinding, ReviewResult } from "./review/review-report.ts";
import { judgeAskOf, routingOf, routingRulesOf } from "./routing/routing-rules.ts";
import type { RoutingInput } from "./routing/routing-rules.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

const CONFIG_JSON = readFileSync(join(REPO_ROOT, FACTORY_CONFIG_PATH), "utf8");

/** The lab's own routing policy, as the Merge bot reads it from the Trunk. */
export const LAB = factoryConfigOf(CONFIG_JSON).land.routing;

/** The Merge bot's guarantees are rare to reach in a snapshot: they search harder than fast-check's default. */
export const RUNS = { numRuns: 2000 };

export const SEGMENT = fc.stringMatching(/^[\w.-]{1,12}$/u).filter((segment) => segment !== "." && segment !== "..");

/** A path under `directory`, one to four segments deep. */
export const UNDER = (directory: string): fc.Arbitrary<string> =>
  fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => [directory, ...segments].join("/"));

const ANY_PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"));

const GLOB_CHARS = /[*?[\]{}!\\]/u;

/**
 * The paths a glob of the config matches: `dir/**`, a literal path, or one `*` inside a file name. A
 * glob of another form throws, so a new form in the config cannot slip past the guarantees unquantified.
 */
function pathsOf(glob: string): fc.Arbitrary<string> {
  if (glob.endsWith("/**") && !GLOB_CHARS.test(glob.slice(0, -3))) {
    return UNDER(glob.slice(0, -3));
  }

  if (!GLOB_CHARS.test(glob)) {
    return fc.constant(glob);
  }

  const [prefix = "", suffix = "", ...more] = glob.split("*");

  if (more.length > 0 || GLOB_CHARS.test(prefix + suffix) || prefix.includes("/") || suffix.includes("/")) {
    throw new Error(`the guarantees cannot draw the paths of the glob ${JSON.stringify(glob)}: add its form`);
  }

  return fc.stringMatching(/^[\w.-]{0,8}$/u).map((infix) => `${prefix}${infix}${suffix}`);
}

const anyOf = (globs: readonly string[]): fc.Arbitrary<string> => fc.oneof(...globs.map((glob) => pathsOf(glob)));

const MESSAGES = fc.array(
  fc.oneof({ arbitrary: fc.string(), weight: 4 }, fc.constantFrom("feat!: x", "fix: y\n\nBREAKING CHANGE: z")),
  { maxLength: 3 },
);

/** Changed lines, as often under the lab's cap as past it. */
const LINES = fc.oneof(fc.integer({ min: 0, max: LAB.lineCap }), fc.integer({ min: 0, max: 5000 }));

/** A change that touches `path` among arbitrary others, at any size, with any commit messages. */
const changeWith = (path: fc.Arbitrary<string>): fc.Arbitrary<RoutingInput> =>
  fc
    .record({
      path,
      others: fc.array(ANY_PATH, { maxLength: 4 }),
      at: fc.nat(),
      lines: LINES,
      messages: MESSAGES,
    })
    .map(({ path: touched, others, at, lines, messages }) => ({
      paths: others.toSpliced(at % (others.length + 1), 0, touched),
      lines,
      messages,
    }));

export const ROUTING: fc.Arbitrary<RoutingAnswer> = fc.record({
  land: fc.constantFrom("auto", "owner"),
  review: fc.constantFrom("none", "light", "deep"),
  secondRound: fc.boolean(),
  reason: fc.string(),
  model: fc.option(fc.string(), { nil: null }),
});

/** The Routing answer of a change under `policy`, whatever the Routing judge answers and whatever its Patch delta. */
const routedArbitrarily = (policy: RoutingPolicy, change: fc.Arbitrary<RoutingInput>): fc.Arbitrary<RoutingAnswer> =>
  fc
    .record({
      change,
      delta: fc.option(changeWith(ANY_PATH), { nil: null }),
      judge: ROUTING,
    })
    .map(({ change: input, delta, judge }) => {
      const verdict = routingRulesOf(policy, input);
      const patchDelta = delta === null ? null : routingRulesOf(policy, delta);

      return routingOf(verdict, patchDelta, judgeAskOf(verdict, patchDelta).kind === "ask" ? judge : null);
    });

const GLOBS = fc.array(
  fc.oneof(fc.string(), fc.constantFrom("**", "*", ".github/**", "*.json", ".github/*", FACTORY_CONFIG_PATH)),
  { maxLength: 4 },
);

const POLICY: fc.Arbitrary<RoutingPolicy> = fc.record({
  ownerPaths: GLOBS,
  factoryPaths: GLOBS,
  deepReviewPaths: GLOBS,
  lineCap: fc.integer({ min: 0, max: 5000 }),
});

describe("the Routing rules' guarantees", () => {
  test("under the lab's config, a change that touches an ownerPaths path or the factory config never lands auto, whatever the Routing judge answers", () => {
    fc.assert(
      fc.property(routedArbitrarily(LAB, changeWith(anyOf([FACTORY_CONFIG_PATH, ...LAB.ownerPaths]))), (answer) => {
        expect(answer.land).toBe("owner");
      }),
    );
  });

  test("under any routing policy, a change that touches the factory config never lands auto, whatever the Routing judge answers", () => {
    fc.assert(
      fc.property(
        POLICY.chain((policy) => routedArbitrarily(policy, changeWith(fc.constant(FACTORY_CONFIG_PATH)))),
        (answer) => {
          expect(answer.land).toBe("owner");
        },
      ),
    );
  });

  test("under the lab's config, a change that touches a factoryPaths or deepReviewPaths path gets a deep review, whatever the Routing judge answers", () => {
    fc.assert(
      fc.property(
        routedArbitrarily(LAB, changeWith(anyOf([...LAB.factoryPaths, ...LAB.deepReviewPaths]))),
        (answer) => {
          expect(answer.review).toBe("deep");
        },
      ),
    );
  });

  test("the routing policy reads as written: the config's parser drops, adds or changes no glob", () => {
    const asWritten: unknown = JSON.parse(CONFIG_JSON);

    expect(asWritten).toMatchObject({ land: { routing: LAB } });
  });
});

const PATCH = fc.constantFrom("patch-1", "patch-2");

const HEAD = fc.constantFrom("h1", "h2");

const ROUND = fc.constantFrom<1 | 2 | 3>(1, 2, 3);

/** When the arbitrary requests were dispatched: an arbitrary snapshot reads them before or after the deadline. */
const DISPATCHED_AT = "2026-11-07T11:00:00.000Z";

const reviewStateOf = (patch: fc.Arbitrary<string>): fc.Arbitrary<ReviewState> =>
  fc.oneof(
    fc.record({
      kind: fc.constantFrom("requested"),
      patch,
      round: ROUND,
      runId: fc.nat(),
      at: fc.constant(DISPATCHED_AT),
    }),
    fc.record({
      kind: fc.constantFrom("failed"),
      patch,
      round: ROUND,
      runId: fc.nat(),
      cause: fc.string(),
    }),
  );

/** A state record whose patches are `patch`, so that a snapshot's patch meets its entries. */
export const recordOf = (patch: fc.Arbitrary<string>): fc.Arbitrary<StateRecord> =>
  fc.record(
    {
      reviewedPatch: fc.option(patch, { nil: null }),
      reviewedHead: fc.option(HEAD, { nil: null }),
      reviewRounds: fc.integer({ min: 0, max: 3 }),
      triage: fc.dictionary(patch, ROUTING),
      landOkPatch: fc.option(patch, { nil: null }),
      dequeued: fc.option(fc.record({ head: HEAD, reason: fc.string() }), { nil: null }),
      review: reviewStateOf(patch),
      importantByRound: fc.array(fc.option(fc.nat({ max: 2 }), { nil: null }), { maxLength: 3 }),
      ownerHold: fc.string(),
    },
    {
      requiredKeys: ["reviewedPatch", "reviewedHead", "reviewRounds", "triage", "landOkPatch", "dequeued"],
    },
  );

const ARBITRARY_FINDING: fc.Arbitrary<ReportedFinding> = fc.record({
  file: fc.constant("a.ts"),
  line: fc.constant(3),
  severity: fc.constantFrom("important", "nit", "pre_existing"),
  summary: fc.constant("s"),
  failureScenario: fc.constant("f"),
  breaks: fc.constant(null),
});

const RUN_FACTS = {
  request: fc.record({
    pr: fc.constantFrom(9, 10),
    head: HEAD,
    base: fc.constant("b0"),
    patch: PATCH,
    round: ROUND,
    model: fc.constant("sonnet"),
    effort: fc.constantFrom("medium"),
  }),
  model: fc.constant(null),
  claudeCodeVersion: fc.constant(null),
  costUsd: fc.constant(null),
  runUrl: fc.constant("https://github.com/o/r/actions/runs/1"),
};

const ARBITRARY_RESULT: fc.Arbitrary<ReviewResult> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("reported"),
    report: fc.record({ findings: fc.array(ARBITRARY_FINDING, { maxLength: 3 }) }),
    ...RUN_FACTS,
  }),
  fc.record({ kind: fc.constantFrom("failed"), cause: fc.string(), ...RUN_FACTS }),
);

const ARBITRARY_JOB: fc.Arbitrary<ReviewJob | null> = fc.option(
  fc.oneof(
    fc.record({ kind: fc.constantFrom("running") }),
    fc.record({
      kind: fc.constantFrom("completed"),
      conclusion: fc.constantFrom("success", "failure", "cancelled"),
      result: fc.option(ARBITRARY_RESULT, { nil: null }),
    }),
    fc.record({ kind: fc.constantFrom("missing") }),
  ),
  { nil: null },
);

export const LABELS = ["land:auto", "land:human", "review:none", "review:light", "review:deep", LAND_APPROVAL_LABEL];

/** Who set the PR's land:human: the Merge bot's App, another login, or nobody. */
export const HUMAN_LABEL_BY: fc.Arbitrary<Snapshot["humanLabelBy"]> = fc.constantFrom("merge-bot", "other", null);

/** Mostly open PRs from the Owner's own branches, the ones `decide` does more than ignore. */
export const SNAPSHOT: fc.Arbitrary<Snapshot> = fc.record({
  number: fc.constantFrom(9, 10),
  state: fc.oneof({ arbitrary: fc.constant("OPEN"), weight: 8 }, fc.constantFrom("CLOSED", "MERGED")),
  sameRepository: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, fc.constant(false)),
  openedByFactory: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, fc.constant(false)),
  draft: fc.boolean(),
  head: HEAD,
  patch: PATCH,
  empty: fc.oneof({ arbitrary: fc.constant(false), weight: 8 }, fc.constant(true)),
  ci: fc.constantFrom("success", "failure", null),
  labels: fc.subarray(LABELS),
  humanLabelBy: HUMAN_LABEL_BY,
  landApprovalByOwner: fc.boolean(),
  openImportant: fc.nat({ max: 2 }),
  devRed: fc.boolean(),
  conflicting: fc.boolean(),
  record: recordOf(PATCH),
  now: fc.constantFrom("2026-11-07T11:30:00.000Z", "2026-11-07T12:00:00.000Z"),
  reviewJob: ARBITRARY_JOB,
});

/** A run GitHub no longer gives back: its request is withdrawn and asked again. */
export const withdrawn = (job: ReviewJob | null): boolean => job?.kind === "missing";

export const stepsOrNone = (snapshot: Snapshot): readonly Step[] => {
  const decision = decide(snapshot);

  return decision.kind === "steps" ? decision.steps : [];
};

const merges = (snapshot: Snapshot): boolean => stepsOrNone(snapshot).some((step) => step.kind === "auto-merge");

/** `good` six times in seven, else `bad`: a snapshot drawn so is landable but for one thing or two. */
const mostly = <T>(good: T, bad: fc.Arbitrary<T>): fc.Arbitrary<T> =>
  fc.oneof({ arbitrary: fc.constant(good), weight: 6 }, { arbitrary: bad, weight: 1 });

/** What the Review rounds read of the change before: its patch, an earlier patch only, or nothing. */
const READ = fc.constantFrom("patch", "earlier-patch", "unread");

const nearLandableRecord = (patch: string): fc.Arbitrary<StateRecord> =>
  fc
    .record({
      drawn: recordOf(PATCH),
      routing: ROUTING,
      read: READ,
      review: fc.oneof({ arbitrary: fc.constant(null), weight: 3 }, reviewStateOf(fc.constant(patch))),
      ejected: mostly(false, fc.constant(true)),
    })
    .map(({ drawn, routing, read, review, ejected }) => {
      const { review: _drawn, ...rest } = drawn;

      const reviewed = {
        patch: { reviewedPatch: patch },
        "earlier-patch": { reviewedPatch: `${patch}-earlier`, reviewRounds: Math.max(1, drawn.reviewRounds) },
        unread: { reviewedPatch: null, reviewedHead: null, reviewRounds: 0 },
      }[read];

      const record: StateRecord = {
        ...rest,
        ...reviewed,
        triage: { ...drawn.triage, [patch]: routing },
        dequeued: ejected ? drawn.dequeued : null,
      };

      return review === null ? record : { ...record, review };
    });

/**
 * Open, routed PRs from the Owner's own branches, each fact that holds a landing back absent six times in
 * seven: an auto-merge is common, so a guard that stops holding it back is soon caught merging.
 */
const NEAR_LANDABLE: fc.Arbitrary<Snapshot> = PATCH.chain((patch) =>
  fc.record({
    number: fc.constantFrom(9, 10),
    state: fc.constant("OPEN"),
    sameRepository: fc.constant(true),
    openedByFactory: fc.constant(true),
    draft: mostly(false, fc.constant(true)),
    head: HEAD,
    patch: fc.constant(patch),
    empty: mostly(false, fc.constant(true)),
    ci: mostly<Snapshot["ci"]>("success", fc.constantFrom("failure", null)),
    labels: fc.subarray(LABELS),
    humanLabelBy: HUMAN_LABEL_BY,
    landApprovalByOwner: fc.boolean(),
    openImportant: mostly(0, fc.integer({ min: 1, max: 2 })),
    devRed: mostly(false, fc.constant(true)),
    conflicting: mostly(false, fc.constant(true)),
    record: nearLandableRecord(patch),
    now: fc.constantFrom("2026-11-07T11:30:00.000Z", "2026-11-07T12:00:00.000Z"),
    reviewJob: ARBITRARY_JOB,
  }),
);

/** The Review depth of the PR's patch is not none, by its Routing answer or a label on the PR. */
const asksReview = (snapshot: Snapshot): boolean =>
  snapshot.record.triage[snapshot.patch]?.review !== "none" ||
  snapshot.labels.some((label) => label === "review:light" || label === "review:deep");

/** The Owner's Land approval covers the PR's patch: the label, put by the Owner, for no other patch. */
function expectLandApproval(snapshot: Snapshot): void {
  expect(snapshot.labels).toContain(LAND_APPROVAL_LABEL);
  expect(snapshot.landApprovalByOwner).toBe(true);
  expect([null, snapshot.patch]).toContain(snapshot.record.landOkPatch);
}

/** `check` over arbitrary snapshots, then over near-landable ones. */
function holdsForSnapshots(check: (snapshot: Snapshot) => void): void {
  for (const snapshots of [SNAPSHOT, NEAR_LANDABLE]) {
    fc.assert(fc.property(snapshots, check), RUNS);
  }
}

describe("the Merge bot's guarantees", () => {
  test("a PR the Owner holds, by a land:human another login than the Merge bot's App set or an owner Routing answer, merges only with the Owner's Land approval for this very patch", () => {
    holdsForSnapshots((snapshot) => {
      const held = snapshot.humanLabelBy === "other" || snapshot.record.triage[snapshot.patch]?.land !== "auto";

      if (merges(snapshot) && held) {
        expectLandApproval(snapshot);
      }
    });
  });

  test("a PR with an Owner hold merges only with the Owner's Land approval for its current patch", () => {
    holdsForSnapshots((snapshot) => {
      const { record } = snapshot;

      const pushAfterRound3 =
        record.reviewRounds === 3 &&
        record.reviewedPatch !== snapshot.patch &&
        record.triage[snapshot.patch]?.secondRound === true;

      if (merges(snapshot) && (record.ownerHold !== undefined || pushAfterRound3)) {
        expectLandApproval(snapshot);
      }
    });
  });

  test("a Patch delta that needs a read after Review round 2 never merges before Review round 3 read it", () => {
    holdsForSnapshots((snapshot) => {
      const { record } = snapshot;

      const roundThreeOwed =
        asksReview(snapshot) &&
        record.reviewedPatch !== snapshot.patch &&
        record.reviewRounds === 2 &&
        record.triage[snapshot.patch]?.secondRound === true;

      if (roundThreeOwed) {
        expect(merges(snapshot)).toBe(false);
      }
    });
  });

  test("a patch after a Review round 2 that posted an Important never merges before Review round 3 read it", () => {
    holdsForSnapshots((snapshot) => {
      const { record } = snapshot;
      const round2 = record.importantByRound?.[1];
      const posted = round2 === undefined || round2 === null || round2 > 0;

      const roundThreeOwed =
        asksReview(snapshot) && record.reviewedPatch !== snapshot.patch && record.reviewRounds === 2 && posted;

      if (roundThreeOwed) {
        expect(merges(snapshot)).toBe(false);
      }
    });
  });

  test("an auto-merge comes last, after a green Land gate, on a PR that is ready, green, unblocked and routed", () => {
    holdsForSnapshots((snapshot) => {
      const steps = stepsOrNone(snapshot);
      const merge = steps.findIndex((step) => step.kind === "auto-merge");

      if (merge !== -1) {
        const gateStep = steps[merge - 1];

        expect(merge).toBe(steps.length - 1);
        expect(gateStep?.kind === "land-gate" ? gateStep.check.kind : undefined).toBe("success");
        expect(snapshot).toMatchObject({
          draft: false,
          empty: false,
          ci: "success",
          openImportant: 0,
          devRed: false,
          conflicting: false,
        });
        expect(snapshot.record.dequeued?.head).not.toBe(snapshot.head);
        expect(snapshot.record.triage[snapshot.patch]).toBeDefined();
      }
    });
  });

  test("nothing merges while the review asked for this patch has no report", () => {
    holdsForSnapshots((snapshot) => {
      const job = snapshot.reviewJob;
      const reported = job?.kind === "completed" && job.result?.kind === "reported";

      if (snapshot.record.review?.patch === snapshot.patch && !reported && !withdrawn(job)) {
        expect(merges(snapshot)).toBe(false);
      }
    });
  });

  test("a change whose Review depth is not none merges only once a Review round read it", () => {
    holdsForSnapshots((snapshot) => {
      const read = snapshot.record.reviewedPatch !== null || snapshot.record.reviewRounds > 0;

      if (merges(snapshot) && asksReview(snapshot)) {
        expect(read).toBe(true);
      }
    });
  });

  test("a Patch delta its Routing answer asks to read again never merges before Review round 2 read it", () => {
    holdsForSnapshots((snapshot) => {
      const { record } = snapshot;

      const roundTwoOwed =
        asksReview(snapshot) &&
        record.reviewedPatch !== snapshot.patch &&
        record.reviewRounds === 1 &&
        record.triage[snapshot.patch]?.secondRound === true;

      if (roundTwoOwed) {
        expect(merges(snapshot)).toBe(false);
      }
    });
  });
});
