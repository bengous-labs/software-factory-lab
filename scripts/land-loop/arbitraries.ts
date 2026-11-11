/**
 * The fast-check arbitraries the Land loop's tests share, with the lab's routing policy they draw
 * against and the helpers they read `decide` through. No test lives here, so a test file that imports
 * it runs only its own tests: a mutation pass runs every mutant against one test file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as fc from "fast-check";

import { FACTORY_CONFIG_PATH, factoryConfigOf } from "./factory-config.ts";
import { decide, LAND_APPROVAL_LABEL } from "./merge-bot/decide.ts";
import type {
  ImportantThread,
  ReviewJob,
  ReviewState,
  RoutingAnswer,
  Snapshot,
  StateRecord,
  Step,
} from "./merge-bot/decide.ts";
import type { ReportedFinding, ReviewResult } from "./review/review-report.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

export const CONFIG_JSON = readFileSync(join(REPO_ROOT, FACTORY_CONFIG_PATH), "utf8");

/** The lab's own routing policy, as the Merge bot reads it from the Trunk. */
export const LAB = factoryConfigOf(CONFIG_JSON).land.routing;

/** The Merge bot's guarantees are rare to reach in a snapshot: they search harder than fast-check's default. */
export const RUNS = { numRuns: 2000 };

export const SEGMENT = fc.stringMatching(/^[\w.-]{1,12}$/u).filter((segment) => segment !== "." && segment !== "..");

/** A path under `directory`, one to four segments deep. */
export const UNDER = (directory: string): fc.Arbitrary<string> =>
  fc.array(SEGMENT, { minLength: 1, maxLength: 4 }).map((segments) => [directory, ...segments].join("/"));

export const ROUTING: fc.Arbitrary<RoutingAnswer> = fc.record(
  {
    land: fc.constantFrom("auto", "owner"),
    review: fc.constantFrom("none", "light", "deep"),
    secondRound: fc.boolean(),
    reason: fc.string(),
    model: fc.option(fc.string(), { nil: null }),
    security: fc.boolean(),
  },
  { requiredKeys: ["land", "review", "secondRound", "reason", "model"] },
);

export const PATCH = fc.constantFrom("patch-1", "patch-2");

export const HEAD = fc.constantFrom("h1", "h2");

const ROUND = fc.constantFrom<1 | 2 | 3>(1, 2, 3);

/** When the arbitrary requests were dispatched: an arbitrary snapshot reads them before or after the deadline. */
const DISPATCHED_AT = "2026-11-07T11:00:00.000Z";

export const reviewStateOf = (patch: fc.Arbitrary<string>): fc.Arbitrary<ReviewState> =>
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
      ownerAskedPatch: patch,
      deltaReadPatch: patch,
      followUpIssue: fc.nat(),
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
  earlier: fc.constantFrom(null, "T-open-1", "T-open-2", "T-gone"),
  pass: fc.constantFrom("code", "security"),
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
    security: fc.boolean(),
  }),
  model: fc.constant(null),
  claudeCodeVersion: fc.constant(null),
  tokens: fc.constant(null),
  runUrl: fc.constant("https://github.com/o/r/actions/runs/1"),
};

const ARBITRARY_RESULT: fc.Arbitrary<ReviewResult> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("reported"),
    report: fc.record({ findings: fc.array(ARBITRARY_FINDING, { maxLength: 3 }), namesEarlier: fc.boolean() }),
    ...RUN_FACTS,
  }),
  fc.record({ kind: fc.constantFrom("failed"), cause: fc.string(), ...RUN_FACTS }),
);

export const ARBITRARY_JOB: fc.Arbitrary<ReviewJob | null> = fc.option(
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

/** Who set the PR's land:human: the Merge bot's App, the Author's machine account, another login, or nobody. */
export const HUMAN_LABEL_BY: fc.Arbitrary<Snapshot["humanLabelBy"]> = fc.constantFrom(
  "merge-bot",
  "author",
  "other",
  null,
);

/** Up to two open Important threads of the App, each posted by a review of either patch and any round, or by one that names none. */
export const OPEN_IMPORTANT: fc.Arbitrary<readonly ImportantThread[]> = fc.uniqueArray(
  fc.record({
    thread: fc.constantFrom("T-open-1", "T-open-2"),
    review: fc.option(fc.record({ patch: PATCH, round: ROUND }), { nil: null }),
  }),
  { selector: (found) => found.thread, maxLength: 2 },
);

/** Mostly open PRs from the Owner's own branches, the ones `decide` does more than ignore. */
export const SNAPSHOT: fc.Arbitrary<Snapshot> = fc.record({
  number: fc.constantFrom(9, 10),
  state: fc.oneof({ arbitrary: fc.constant("OPEN"), weight: 8 }, fc.constantFrom("CLOSED", "MERGED")),
  sameRepository: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, fc.constant(false)),
  openedByFactory: fc.oneof({ arbitrary: fc.constant(true), weight: 8 }, fc.constant(false)),
  openedByAuthor: fc.boolean(),
  draft: fc.boolean(),
  head: HEAD,
  patch: PATCH,
  empty: fc.oneof({ arbitrary: fc.constant(false), weight: 8 }, fc.constant(true)),
  ci: fc.constantFrom("success", "failure", null),
  labels: fc.subarray(LABELS),
  humanLabelBy: HUMAN_LABEL_BY,
  landApprovalByOwner: fc.boolean(),
  landApprovalPutByOwner: fc.boolean(),
  openImportant: OPEN_IMPORTANT,
  rejectedImportant: fc.nat({ max: 2 }),
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
