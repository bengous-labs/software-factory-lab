/**
 * The Merge bot's decision, a pure function over a snapshot of one PR. Each Merge bot run re-reads
 * the whole state, so an event that arrives twice, late or not at all changes nothing. It returns the
 * steps to take in order; the adapter (`main.ts`) performs them and, after a step whose outcome the
 * next decision reads (`route`, `post-review`), decides again with it in the
 * state record.
 */

import { Schema, Struct } from "effect";

import { decodeJson } from "../../lib/json.ts";
import type { ReportedResult, ReviewResult } from "../review/review-report.ts";

/** Who lands a change: `auto`, the Merge bot alone, or `owner`, with a Land approval. */
export type LandRoute = "auto" | "owner";

/**
 * The Land route as the `land:*` labels and the state record store it. An external name: open PRs
 * and existing records carry `human` for `owner`, so the stored value stays; anything but `auto`
 * reads as `owner`, the safe side.
 */
export type StoredLandRoute = "auto" | "human";

const landRouteOf = (stored: string): LandRoute => (stored === "auto" ? "auto" : "owner");

export const storedLandRouteOf = (route: LandRoute): StoredLandRoute => (route === "auto" ? "auto" : "human");

export type ReviewDepth = "none" | "light" | "deep";

/** The label of a Land approval. An external name: the owner puts it by hand, so the string stays. */
export const LAND_APPROVAL_LABEL = "land-ok";

/** The Review check's name. An external name: GitHub's ruleset requires it, so the string stays. */
export const REVIEW_CHECK = "agent-review";

/** The Land gate's check name. An external name: GitHub's ruleset requires it, so the string stays. */
export const LAND_GATE = "land-gate";

/**
 * The Routing answer of one patch. Its keys are the stored record's format, an external name: existing
 * records must still read, so they stay as they are. `land` holds the Land route.
 */
export interface RoutingAnswer {
  readonly land: LandRoute;
  readonly review: ReviewDepth;
  /**
   * On a Patch delta: whether it is risky enough to be read again. After Review round 1 it runs Review
   * round 2; after Review round 2 it sends the change to the Owner, since a third never runs.
   */
  readonly secondRound: boolean;
  readonly reason: string;
  /** The model asked, exact when it answered; null when the Routing rules decided. */
  readonly model: string | null;
}

const Round = Schema.Literals([1, 2]);

/** The review asked of the review job for one patch and round, and its run; `failed` once it gave no report. */
const ReviewState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("requested"),
    patch: Schema.String,
    round: Round,
    runId: Schema.Int,
    /** When the Merge bot dispatched it, as an ISO timestamp. */
    at: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    patch: Schema.String,
    round: Round,
    runId: Schema.Int,
    cause: Schema.String,
  }),
]);

export type ReviewState = typeof ReviewState.Type;

/**
 * The record the App keeps in one comment per PR. Its keys are the stored record's format, an
 * external name: existing records must still read, so they stay as they are. `triage` holds the
 * Routing answers, `dequeued` the Ejection.
 */
export interface StateRecord {
  /** The patch the last Code review read, or null before any review. */
  readonly reviewedPatch: string | null;
  /** The head that review read, from which the Patch delta of the next Review round is diffed. */
  readonly reviewedHead: string | null;
  /** The Review rounds run on the change, whether they posted findings or not: 0, 1 or 2. */
  readonly reviewRounds: number;
  /** The Routing answer of each patch, keyed by patch identity. */
  readonly triage: Readonly<Record<string, RoutingAnswer>>;
  /** The patch the owner's Land approval was given for. */
  readonly landOkPatch: string | null;
  /** The Ejection of the PR from the merge queue at this head, for this reason. */
  readonly dequeued: { readonly head: string; readonly reason: string } | null;
  /** The review asked of the review job, until its review is posted. Absent before any. */
  readonly review?: ReviewState;
}

export const EMPTY_RECORD: StateRecord = {
  reviewedPatch: null,
  reviewedHead: null,
  reviewRounds: 0,
  triage: {},
  landOkPatch: null,
  dequeued: null,
};

/** The state record as its comment stores it: each Routing answer's Land route in its stored value. */
export type StoredRecord = Omit<StateRecord, "triage"> & {
  readonly triage: Readonly<Record<string, Omit<RoutingAnswer, "land"> & { readonly land: StoredLandRoute }>>;
};

const Verdict = Schema.Struct({ ok: Schema.Boolean, reason: Schema.String });

/** A record as its comment holds it. A Land route reads as any string, so a value but `auto` reads as `owner`. */
const ReadRecord = Schema.Struct({
  reviewedPatch: Schema.NullOr(Schema.String),
  reviewedHead: Schema.NullOr(Schema.String),
  reviewRounds: Schema.Finite,
  triage: Schema.Record(
    Schema.String,
    Schema.Struct({
      land: Schema.String,
      review: Schema.Literals(["none", "light", "deep"]),
      secondRound: Schema.Boolean,
      reason: Schema.String,
      // Records written before the Routing answer named its model have none.
      model: Schema.optionalKey(Schema.NullOr(Schema.String)),
      // Records written while the Principal judge existed: the field still reads, and is left out.
      needsFable: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  landOkPatch: Schema.NullOr(Schema.String),
  dequeued: Schema.NullOr(Schema.Struct({ head: Schema.String, reason: Schema.String })),
  // Records written while an Important could be posted in a review's body, with no thread, count them
  // here: the field still reads, and counts no more.
  bodyImportant: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  // Records written while the Principal judge existed hold its verdicts and failed runs: they still read, and are left out.
  fable: Schema.optionalKey(Schema.Record(Schema.String, Verdict)),
  fableFailures: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
  review: Schema.optionalKey(ReviewState),
});

type ReadRecord = typeof ReadRecord.Type;

/** The comment's JSON: older records lack the fields added since they were written. */
const StoredJson = ReadRecord.mapFields(Struct.map(Schema.optionalKey));

/**
 * The record a comment stores, with each Land route read back from its stored value; `bodyImportant`,
 * `fable`, `fableFailures` and each answer's `needsFable` are left out.
 */
export function recordOfStored(stored: ReadRecord): StateRecord {
  const { bodyImportant: _uncounted, fable: _fable, fableFailures: _fableFailures, ...kept } = stored;

  const triage = Object.entries(kept.triage).map(
    ([patch, { needsFable: _needsFable, ...routing }]) =>
      [patch, { ...routing, land: landRouteOf(routing.land), model: routing.model ?? null }] as const,
  );

  return { ...kept, triage: Object.fromEntries(triage) };
}

/** The record its comment's JSON holds, each field it lacks read as in a record with no review yet. */
export function recordOfJson(json: string): StateRecord {
  const noReview: StoredRecord = {
    reviewedPatch: null,
    reviewedHead: null,
    reviewRounds: 0,
    triage: {},
    landOkPatch: null,
    dequeued: null,
  };

  return recordOfStored({ ...noReview, ...decodeJson(StoredJson, "the Merge bot state record", json) });
}

/** The record as its comment stores it, each Land route in its stored value. */
export function storedOfRecord(record: StateRecord): StoredRecord {
  const triage = Object.entries(record.triage).map(
    ([patch, routing]) => [patch, { ...routing, land: storedLandRouteOf(routing.land) }] as const,
  );

  return { ...record, triage: Object.fromEntries(triage) };
}

export interface Snapshot {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly sameRepository: boolean;
  /** The PR was opened under the Owner's GitHub login, the only one this public lab works for. */
  readonly openedByOwner: boolean;
  readonly draft: boolean;
  readonly head: string;
  readonly patch: string;
  /** The PR changes no file between its merge base and its head: it has nothing to land, and no route. */
  readonly empty: boolean;
  /** CI_CHECKS on the head, as `ciOf` reads them: null while one has not completed. */
  readonly ci: "success" | "failure" | null;
  readonly labels: readonly string[];
  /**
   * Who set the PR's `land:human`, by its latest `labeled` event: the Merge bot's App, any other login
   * (an actor that does not read, or no such event, included), or null when the PR has no `land:human`.
   */
  readonly humanLabelBy: "merge-bot" | "other" | null;
  /** The Land approval label is on the PR and the owner put it there. */
  readonly landApprovalByOwner: boolean;
  readonly openImportant: number;
  readonly devRed: boolean;
  /** GitHub reads the PR as conflicting with its base: no CI runs on it and the queue refuses it. */
  readonly conflicting: boolean;
  readonly record: StateRecord;
  /** When the Merge bot read the PR, as an ISO timestamp: a review requested too long before it has failed. */
  readonly now: string;
  /** The run of `record.review` as this decision read it; null when the record holds no review. */
  readonly reviewJob: ReviewJob | null;
}

export type ReviewJob =
  | { readonly kind: "running" }
  /** `result` is null when the run ended without an artifact that reads. */
  | { readonly kind: "completed"; readonly conclusion: string; readonly result: ReviewResult | null }
  /** GitHub answers 404 for the run: it was deleted, and its result with it. */
  | { readonly kind: "missing" };

/**
 * The CI checks a change lands on, the jobs of `.github/workflows/ci.yml`. External names: the workflow
 * names its jobs so, so the strings stay. The ruleset requires `validate` alone; the Land gate waits for both.
 */
export const CI_CHECKS = ["validate", "mutation"] as const;

interface CiCheck {
  readonly status: string;
  readonly conclusion: string | null;
}

/** The CI of the head, from the latest run of each of CI_CHECKS: red once one ended other than green, null while one has not. */
export function ciOf(checks: ReadonlyArray<CiCheck | undefined>): Snapshot["ci"] {
  if (checks.some((check) => check?.status === "completed" && check.conclusion !== "success")) {
    return "failure";
  }

  return checks.every((check) => check?.status === "completed") ? "success" : null;
}

/** GitHub's `mergeable_state` of one PR, from the single-PR endpoint: `dirty` is a conflict with the base. */
export function conflictingOf(mergeableState: string | null | undefined): boolean {
  return mergeableState === "dirty";
}

/**
 * Where a Patch delta starts: the head the last review read, only while `git merge-base --is-ancestor`
 * exits 0 for it. A rebase (exit 1) or an object git does not know (exit 128) makes the Patch delta the
 * whole PR again.
 */
export function patchDeltaStart(base: string, reviewedHead: string | null, ancestorExit: number | null): string {
  return reviewedHead !== null && ancestorExit === 0 ? reviewedHead : base;
}

/** The owner's Land approval counts only when it was put after the head it would land was pushed. */
export function landApprovalCounts(byOwner: boolean, labeledAt: string | null, headPushedAt: string | null): boolean {
  if (!byOwner || labeledAt === null) {
    return false;
  }

  return headPushedAt === null || Date.parse(labeledAt) >= Date.parse(headPushedAt);
}

export type CheckState =
  | { readonly kind: "pending"; readonly summary: string }
  | { readonly kind: "success"; readonly summary: string }
  | { readonly kind: "failure"; readonly summary: string };

export type Step =
  | { readonly kind: "route"; readonly patch: string; readonly patchDelta: boolean }
  | { readonly kind: "labels"; readonly route: LandRoute; readonly depth: ReviewDepth }
  | { readonly kind: "request-review"; readonly depth: Exclude<ReviewDepth, "none">; readonly reviewRound: 1 | 2 }
  | { readonly kind: "post-review"; readonly result: ReportedResult }
  | { readonly kind: "review-check"; readonly check: CheckState }
  | { readonly kind: "land-gate"; readonly check: CheckState }
  | { readonly kind: "needs-owner"; readonly reason: string }
  | { readonly kind: "record"; readonly record: StateRecord }
  | { readonly kind: "remove-land-approval" }
  | { readonly kind: "auto-merge" };

export type Decision =
  { readonly kind: "ignore"; readonly reason: string } | { readonly kind: "steps"; readonly steps: readonly Step[] };

/**
 * The `land:*` label follows the route the decision computes, except a `land:human` that a login other
 * than the Merge bot's App set: the Owner's veto, which stays. The `review:*` label only rises. The
 * `land:*` and `review:*` labels, read here and quoted in the check summaries below, are external names:
 * open PRs carry them, so the strings stay.
 */
export interface RisenLabels {
  readonly route: LandRoute;
  readonly depth: ReviewDepth;
}

function risenDepth(labels: readonly string[], review: ReviewDepth): ReviewDepth {
  return (
    (["deep", "light", "none"] as const).find((depth) => depth === review || labels.includes(`review:${depth}`)) ??
    review
  );
}

/** `routing.land` is the route the decision computes, every hold included. */
export function risen(
  labels: readonly string[],
  humanLabelBy: Snapshot["humanLabelBy"],
  routing: Pick<RoutingAnswer, "land" | "review">,
): RisenLabels {
  return {
    route: humanLabelBy === "other" ? "owner" : routing.land,
    depth: risenDepth(labels, routing.review),
  };
}

const pending = (summary: string): CheckState => ({ kind: "pending", summary });

/**
 * The record after reading the Land approval label, the only change a decision makes to it, and
 * whether the label goes. A label someone else put goes; one given for another patch goes and clears
 * its patch; a patch left in the record without the label is cleared, so a new Land approval counts.
 */
interface LandApproval {
  readonly next: StateRecord;
  readonly removeLabel: boolean;
}

function landApprovalOf(snapshot: Snapshot, record: StateRecord): LandApproval {
  if (!snapshot.labels.includes(LAND_APPROVAL_LABEL)) {
    return { next: record.landOkPatch === null ? record : { ...record, landOkPatch: null }, removeLabel: false };
  }

  if (!snapshot.landApprovalByOwner) {
    return { next: record, removeLabel: true };
  }

  if (record.landOkPatch === null) {
    return { next: { ...record, landOkPatch: snapshot.patch }, removeLabel: false };
  }

  if (record.landOkPatch !== snapshot.patch) {
    return { next: { ...record, landOkPatch: null }, removeLabel: true };
  }

  return { next: record, removeLabel: false };
}

/** How long after its dispatch a review the job has not reported counts as failed: past the job's 30-minute timeout. */
export const REVIEW_DEADLINE_MS = 45 * 60_000;

function withoutReview(record: StateRecord): StateRecord {
  const { review: _done, ...rest } = record;

  return rest;
}

/** The record once the review of `result` is posted: the patch and the head it read, its round, and no review asked. */
export function afterReview(record: StateRecord, result: ReportedResult): StateRecord {
  return {
    ...withoutReview(record),
    reviewedPatch: result.request.patch,
    reviewedHead: result.request.head,
    reviewRounds: result.request.round,
  };
}

/** The review machine's outcome: the record it leaves, and the steps that end the decision, or null when it goes on. */
interface ReviewMachine {
  readonly record: StateRecord;
  readonly end: readonly Step[] | null;
}

type JobOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "missing" }
  | { readonly kind: "reported"; readonly result: ReportedResult }
  | { readonly kind: "failed"; readonly cause: string };

/** What the run of `review` gave, as the snapshot read it; an artifact of another PR, patch or round is refused. */
function outcomeOf(snapshot: Snapshot, review: ReviewState): JobOutcome {
  const job = snapshot.reviewJob;

  if (job === null || job.kind === "running") {
    return { kind: "waiting" };
  }

  if (job.kind === "missing") {
    return job;
  }

  const { result } = job;

  if (result === null) {
    return { kind: "failed", cause: `the review job ended (${job.conclusion}) with no result that reads` };
  }

  const { request } = result;

  if (request.pr !== snapshot.number || request.patch !== review.patch || request.round !== review.round) {
    return { kind: "failed", cause: "the artifact does not match the request" };
  }

  return result.kind === "reported" ? { kind: "reported", result } : { kind: "failed", cause: result.cause };
}

const runningSteps = (round: 1 | 2): readonly Step[] => {
  const check = pending(`Review round ${round} running.`);

  return [
    { kind: "review-check", check },
    { kind: "land-gate", check },
  ];
};

/** A review that failed: recorded once, when its request first fails; only a report moves it on. */
function failedOf(record: StateRecord, review: ReviewState, cause: string): ReviewMachine {
  const failed: ReviewState = { kind: "failed", patch: review.patch, round: review.round, runId: review.runId, cause };

  return {
    record: review.kind === "failed" ? record : { ...record, review: failed },
    end: [
      {
        kind: "review-check",
        check: { kind: "failure", summary: `Review round ${review.round} failed (run ${review.runId}): ${cause}` },
      },
      { kind: "land-gate", check: pending("Not landable: the Code review failed.") },
    ],
  };
}

/**
 * The review is posted, then its Review check counts the Important findings open once it is: those it
 * posts and those of an earlier round still open.
 */
function postedSteps(snapshot: Snapshot, result: ReportedResult): readonly Step[] {
  const posted = result.report.findings.filter((finding) => finding.severity === "important").length;
  const open = posted + snapshot.openImportant;

  return [
    { kind: "post-review", result },
    {
      kind: "review-check",
      check:
        open === 0
          ? { kind: "success", summary: "No Important finding open." }
          : { kind: "failure", summary: `${open} Important finding(s) open.` },
    },
  ];
}

/** A review whose run has not completed: a request waits up to the deadline, a failed review stays failed. */
function waitingOf(snapshot: Snapshot, record: StateRecord, review: ReviewState): ReviewMachine {
  if (review.kind === "failed") {
    return failedOf(record, review, review.cause);
  }

  return Date.parse(snapshot.now) - Date.parse(review.at) > REVIEW_DEADLINE_MS
    ? failedOf(record, review, "the review job did not report")
    : { record, end: runningSteps(review.round) };
}

/**
 * The review the record asked of the review job, read before any other exit of the decision, a draft
 * included, so a result that comes while the author holds the PR is not lost. A request for another
 * patch is stale and cleared; the decision then goes on for this one. While the run has not reported,
 * the decision waits, and a request that waited past the deadline fails. A failed review stays failed
 * until a run reports for its patch and round, such as the Owner's rerun of that run.
 */
export function reviewStepsOf(snapshot: Snapshot, record: StateRecord): ReviewMachine {
  const { review } = record;

  if (review === undefined) {
    return { record, end: null };
  }

  if (review.patch !== snapshot.patch) {
    return { record: withoutReview(record), end: null };
  }

  const outcome = outcomeOf(snapshot, review);

  // A deleted run took its result with it: the request is asked again. A cancelled run is a failure,
  // like any run that ended with no result: the review job has no concurrency group, so GitHub never
  // cancels one of its runs, and a cancelled run was stopped by a person or by the job's timeout.
  if (outcome.kind === "missing") {
    return { record: withoutReview(record), end: null };
  }

  if (outcome.kind === "waiting") {
    return waitingOf(snapshot, record, review);
  }

  if (outcome.kind === "failed") {
    return failedOf(record, review, outcome.cause);
  }

  return { record, end: postedSteps(snapshot, outcome.result) };
}

/** What the Review rounds ask of this patch: a round to request, or the Owner instead of a third. */
type RoundNeed =
  | { readonly kind: "request"; readonly depth: Exclude<ReviewDepth, "none">; readonly round: 1 | 2 }
  | { readonly kind: "third" };

/** The Review rounds' need for this patch; null when they ask nothing of it. */
function roundNeedOf(record: StateRecord, routing: RoutingAnswer, depth: ReviewDepth, patch: string): RoundNeed | null {
  if (depth === "none" || record.reviewedPatch === patch) {
    return null;
  }

  if (record.reviewRounds === 0) {
    return { kind: "request", depth, round: 1 };
  }

  // A later patch is read again only when the Routing answer of its Patch delta asks for it.
  if (!routing.secondRound) {
    return null;
  }

  return record.reviewRounds === 1 ? { kind: "request", depth, round: 2 } : { kind: "third" };
}

/** The decision on a PR that gets no route: one closed or from outside is ignored, an empty one has nothing to land. */
function unroutedOf(snapshot: Snapshot): Decision | null {
  if (snapshot.state !== "OPEN") {
    return { kind: "ignore", reason: `#${snapshot.number} is ${snapshot.state.toLowerCase()}` };
  }

  if (!snapshot.sameRepository || !snapshot.openedByOwner) {
    return { kind: "ignore", reason: `#${snapshot.number} comes from outside the Owner's own branches` };
  }

  if (snapshot.empty) {
    return {
      kind: "steps",
      steps: [{ kind: "land-gate", check: { kind: "failure", summary: "Nothing to land: this PR changes no file." } }],
    };
  }

  return null;
}

export function decide(snapshot: Snapshot): Decision {
  const { record } = snapshot;
  const unrouted = unroutedOf(snapshot);

  if (unrouted !== null) {
    return unrouted;
  }

  const steps: Step[] = [];
  const approval = landApprovalOf(snapshot, record);
  const machine = reviewStepsOf(snapshot, approval.next);
  const next = machine.record;

  if (approval.removeLabel) {
    steps.push({ kind: "remove-land-approval" });
  }

  // Written now: a routing or a review below ends this decision before the Land gate is reached.
  if (next !== record) {
    steps.push({ kind: "record", record: next });
  }

  if (machine.end !== null) {
    return { kind: "steps", steps: [...steps, ...machine.end] };
  }

  const landApproved = snapshot.landApprovalByOwner && next.landOkPatch === snapshot.patch;

  const finish = (gate: CheckState): Decision => {
    steps.push({ kind: "land-gate", check: gate });

    return { kind: "steps", steps };
  };

  if (record.dequeued !== null && record.dequeued.head === snapshot.head) {
    return finish({ kind: "failure", summary: `Ejected from the merge queue: ${record.dequeued.reason}` });
  }

  if (snapshot.draft) {
    return finish(pending("Draft: the author's turn."));
  }

  if (snapshot.conflicting) {
    return finish({ kind: "failure", summary: "This PR conflicts with dev: rebase it onto origin/dev, then stop." });
  }

  if (snapshot.ci === null) {
    return finish(pending("Waiting for validate and mutation."));
  }

  if (snapshot.ci === "failure") {
    return finish(pending("validate or mutation is red: the author's turn."));
  }

  const routing = next.triage[snapshot.patch];

  if (routing === undefined) {
    steps.push({ kind: "route", patch: snapshot.patch, patchDelta: next.reviewedPatch !== null });

    return { kind: "steps", steps };
  }

  const need = roundNeedOf(next, routing, risenDepth(snapshot.labels, routing.review), snapshot.patch);
  const thirdRoundNeeded = need?.kind === "third";

  const labels = risen(snapshot.labels, snapshot.humanLabelBy, {
    land: thirdRoundNeeded ? "owner" : routing.land,
    review: routing.review,
  });

  steps.push({ kind: "labels", ...labels });

  if (need?.kind === "request") {
    steps.push({ kind: "request-review", depth: need.depth, reviewRound: need.round }, ...runningSteps(need.round));

    return { kind: "steps", steps };
  }

  if (thirdRoundNeeded) {
    steps.push({ kind: "needs-owner", reason: "A third Review round would be needed: the Owner decides." });
  }

  if (snapshot.openImportant > 0) {
    steps.push({
      kind: "review-check",
      check: { kind: "failure", summary: `${snapshot.openImportant} Important finding(s) open.` },
    });

    return finish(pending("Not landable: Important findings are open."));
  }

  steps.push({
    kind: "review-check",
    check: {
      kind: "success",
      summary: labels.depth === "none" ? "review:none, nothing to read." : "No Important finding open.",
    },
  });

  const { route } = labels;

  if (snapshot.devRed) {
    return finish(pending("dev is red: landing is on hold."));
  }

  if (route === "auto" || landApproved) {
    const gate = finish({
      kind: "success",
      summary:
        route === "auto"
          ? "Landable, land:auto."
          : `Landable, with the Owner's Land approval (label ${LAND_APPROVAL_LABEL}).`,
    });

    if (gate.kind === "steps") {
      return { kind: "steps", steps: [...gate.steps, { kind: "auto-merge" }] };
    }
  }

  return finish(pending("Landable, land:human: waiting for the Owner's Land approval."));
}
