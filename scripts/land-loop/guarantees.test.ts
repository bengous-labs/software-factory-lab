/**
 * The Land loop's safety guarantees, as properties over the pure decisions that enforce them: the
 * Routing rules and the Merge bot's `decide`. A change to that code that breaks one fails `bun check`;
 * a change that weakens one here shows in its diff, for the Code review to read. The generators they
 * share with the other tests of those modules live in `arbitraries.ts`.
 */

import { describe, expect, test } from "bun:test";

import * as fc from "fast-check";

import {
  ARBITRARY_JOB,
  CONFIG_JSON,
  HEAD,
  HUMAN_LABEL_BY,
  LAB,
  LABELS,
  OPEN_IMPORTANT,
  PATCH,
  recordOf,
  reviewStateOf,
  ROUTING,
  RUNS,
  SEGMENT,
  SNAPSHOT,
  stepsOrNone,
  UNDER,
  withdrawn,
} from "./arbitraries.ts";
import { FACTORY_CONFIG_PATH } from "./factory-config.ts";
import type { RoutingPolicy } from "./factory-config.ts";
import { LAND_APPROVAL_LABEL } from "./merge-bot/decide.ts";
import type { RoutingAnswer, Snapshot, StateRecord } from "./merge-bot/decide.ts";
import { judgeAskOf, NON_EXECUTABLE, routingOf, routingRulesOf } from "./routing/routing-rules.ts";
import type { RoutingInput } from "./routing/routing-rules.ts";

const ANY_PATH = fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"));

const GLOB_CHARS = /[*?[\]{}!\\]/u;

const INFIX = fc.stringMatching(/^[\w.-]{0,8}$/u);

// A directory, any depth under it, then a file name that ends with a suffix, as in `scripts/land-loop/**/*-prompt.ts`.
const SUFFIX_UNDER = /^(?<dir>[^*?[\]{}!\\]+)\/\*\*\/\*(?<suffix>[^*?[\]{}!\\/]+)$/u;

/**
 * The paths a glob of the config matches: `dir/**`, the files with a suffix at any depth under a
 * directory, a literal path, or one `*` inside a file name. A glob of another form throws, so a new form
 * in the config cannot slip past the guarantees unquantified.
 */
function pathsOf(glob: string): fc.Arbitrary<string> {
  if (glob.endsWith("/**") && !GLOB_CHARS.test(glob.slice(0, -3))) {
    return UNDER(glob.slice(0, -3));
  }

  const { dir, suffix: ending } = SUFFIX_UNDER.exec(glob)?.groups ?? {};

  if (dir !== undefined && ending !== undefined) {
    return fc
      .tuple(fc.array(SEGMENT, { maxLength: 3 }), INFIX)
      .map(([between, infix]) => [dir, ...between, `${infix}${ending}`].join("/"));
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

/**
 * A change that touches `path` among arbitrary others, at any size, with any commit messages, deleting
 * some of its paths: as often all of them as an arbitrary subset.
 */
const changeWith = (path: fc.Arbitrary<string>): fc.Arbitrary<RoutingInput> =>
  fc
    .record({
      path,
      others: fc.array(ANY_PATH, { maxLength: 4 }),
      at: fc.nat(),
      lines: LINES,
      messages: MESSAGES,
    })
    .chain(({ path: touched, others, at, lines, messages }) => {
      const paths = others.toSpliced(at % (others.length + 1), 0, touched);

      return fc
        .oneof(fc.constant(paths), fc.subarray(paths))
        .map((deletedPaths) => ({ paths, lines, deletedPaths, messages }));
    });

/** A change under `policy` and its Routing answer, whatever the Routing judge answers and whatever its Patch delta. */
const routedArbitrarily = (
  policy: RoutingPolicy,
  change: fc.Arbitrary<RoutingInput>,
): fc.Arbitrary<{ readonly input: RoutingInput; readonly answer: RoutingAnswer }> =>
  fc
    .record({
      change,
      delta: fc.option(changeWith(ANY_PATH), { nil: null }),
      judge: ROUTING,
    })
    .map(({ change: input, delta, judge }) => {
      const verdict = routingRulesOf(policy, input);
      const patchDelta = delta === null ? null : routingRulesOf(policy, delta);

      return {
        input,
        answer: routingOf(verdict, patchDelta, judgeAskOf(verdict, patchDelta).kind === "ask" ? judge : null),
      };
    });

const matches = (globs: readonly string[], path: string): boolean =>
  globs.some((glob) => new Bun.Glob(glob).match(path));

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
      fc.property(routedArbitrarily(LAB, changeWith(anyOf([FACTORY_CONFIG_PATH, ...LAB.ownerPaths]))), ({ answer }) => {
        expect(answer.land).toBe("owner");
      }),
    );
  });

  test("under any routing policy, a change that touches the factory config never lands auto, whatever the Routing judge answers", () => {
    fc.assert(
      fc.property(
        POLICY.chain((policy) => routedArbitrarily(policy, changeWith(fc.constant(FACTORY_CONFIG_PATH)))),
        ({ answer }) => {
          expect(answer.land).toBe("owner");
        },
      ),
    );
  });

  test("under the lab's config, a change that touches a factoryPaths or deepReviewPaths path gets a deep review, or a light one when every path is deleted and every such path is Markdown or text, whatever the Routing judge answers", () => {
    const deep = [...LAB.factoryPaths, ...LAB.deepReviewPaths];

    fc.assert(
      fc.property(routedArbitrarily(LAB, changeWith(anyOf(deep))), ({ input, answer }) => {
        const deleted = new Set(input.deletedPaths);

        const light =
          input.paths.every((path) => deleted.has(path)) &&
          input.paths.filter((path) => matches(deep, path)).every((path) => NON_EXECUTABLE.test(path));

        const ruledBefore = answer.land === "owner" || input.lines > LAB.lineCap;

        expect(answer.review).toBe(light && !ruledBefore ? "light" : "deep");
      }),
    );
  });

  test("the routing policy reads as written: the config's parser drops, adds or changes no glob", () => {
    const asWritten: unknown = JSON.parse(CONFIG_JSON);

    expect(asWritten).toMatchObject({ land: { routing: LAB } });
  });
});

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
    openedByAuthor: fc.boolean(),
    draft: mostly(false, fc.constant(true)),
    head: HEAD,
    patch: fc.constant(patch),
    empty: mostly(false, fc.constant(true)),
    ci: mostly<Snapshot["ci"]>("success", fc.constantFrom("failure", null)),
    labels: fc.subarray(LABELS),
    humanLabelBy: HUMAN_LABEL_BY,
    landApprovalByOwner: fc.boolean(),
    landApprovalPutByOwner: fc.boolean(),
    openImportant: mostly<Snapshot["openImportant"]>([], OPEN_IMPORTANT),
    rejectedImportant: fc.nat({ max: 2 }),
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
          devRed: false,
          conflicting: false,
        });
        expect(snapshot.record.dequeued?.head).not.toBe(snapshot.head);
        expect(snapshot.record.triage[snapshot.patch]).toBeDefined();
      }
    });
  });

  test("a PR with an open Important merges only when it is held for the Owner, with the Owner's Land approval for its patch, and the merge resolves each open Important thread", () => {
    holdsForSnapshots((snapshot) => {
      const { record } = snapshot;

      const pushAfterRound3 =
        record.reviewRounds === 3 &&
        record.reviewedPatch !== snapshot.patch &&
        record.triage[snapshot.patch]?.secondRound === true;

      if (merges(snapshot) && snapshot.openImportant.length > 0) {
        expect(record.ownerHold !== undefined || pushAfterRound3).toBe(true);
        expectLandApproval(snapshot);
        expect(stepsOrNone(snapshot)).toContainEqual({
          kind: "resolve-threads",
          threads: snapshot.openImportant.map((found) => found.thread),
        });
      }
    });
  });

  test("a round that reports an Important or a Nit on a ready PR its Author opened sends it to draft before the round is recorded, and merges nothing", () => {
    holdsForSnapshots((snapshot) => {
      const steps = stepsOrNone(snapshot);
      const kinds = steps.map((step) => step.kind);
      const post = steps.find((step) => step.kind === "post-review");

      const asksTheAuthor =
        post?.kind === "post-review" &&
        post.result.report.findings.some((finding) => finding.severity !== "pre_existing");

      if (asksTheAuthor && snapshot.openedByAuthor && !snapshot.draft) {
        expect(kinds).toContain("to-draft");
        expect(kinds.indexOf("to-draft")).toBeLessThan(kinds.lastIndexOf("record"));
        expect(kinds.indexOf("post-review")).toBeLessThan(kinds.indexOf("to-draft"));
        expect(kinds).not.toContain("auto-merge");
      }
    });
  });

  test("a patch after a Review round 1 that posted an Important never merges before Review round 2 read it", () => {
    holdsForSnapshots((snapshot) => {
      const { record } = snapshot;
      const round1 = record.importantByRound?.[0];
      const posted = round1 === undefined || round1 === null || round1 > 0;

      const roundTwoOwed =
        asksReview(snapshot) && record.reviewedPatch !== snapshot.patch && record.reviewRounds === 1 && posted;

      if (roundTwoOwed) {
        expect(merges(snapshot)).toBe(false);
      }
    });
  });

  test("an agent's land:human sends no PR to the Owner: only the label of another login holds one the route lands", () => {
    holdsForSnapshots((snapshot) => {
      const gate = stepsOrNone(snapshot).find((step) => step.kind === "land-gate");
      const summary = gate?.kind === "land-gate" ? gate.check.summary : "";

      if (snapshot.humanLabelBy !== "other") {
        expect(summary).not.toContain("a land:human the Merge bot did not set");
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
