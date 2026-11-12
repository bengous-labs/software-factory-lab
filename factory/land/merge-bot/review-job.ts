/**
 * The review the record asked of the review job, as a decision reads its run: the request waits, fails
 * past its deadline, or reports, and a report is posted, its round recorded and the Review check set.
 */

import { DELTA_READ } from "../../contract.ts";
import type { ReportedResult } from "../review/review-report.ts";
import type { ImportantThread } from "../shared/finding.ts";
import { reviewNameOf } from "../shared/review-round.ts";
import type { ReviewRound } from "../shared/review-round.ts";
import type { ReviewState, StateRecord } from "./record.ts";
import type { Snapshot } from "./snapshot.ts";
import { pending } from "./steps.ts";
import type { CheckState, Step } from "./steps.ts";

/** The Land gate's and the Review check's summary while the review of `round` runs. */
export const reviewRunningOf = (round: ReviewRound): string => `${reviewNameOf(round)} running.`;

/** How long after its dispatch a review the job has not reported counts as failed: past the job's 50-minute timeout. */
export const REVIEW_DEADLINE_MS = 65 * 60_000;

function withoutReview(record: StateRecord): StateRecord {
  const { review: _done, ...rest } = record;

  return rest;
}

const importantOf = (result: ReportedResult): number =>
  result.report.findings.filter((finding) => finding.severity === "important").length;

/** The counts with `count` at `round`'s index, whatever was there, and each earlier round they lack as null. */
function countedAt(
  counts: ReadonlyArray<number | null>,
  round: ReviewRound,
  count: number,
): ReadonlyArray<number | null> {
  return Array.from({ length: Math.max(counts.length, round) }, (_, index) =>
    index === round - 1 ? count : (counts[index] ?? null),
  );
}

/**
 * The record once the review of `result` is posted: the patch and the head it read, its round, its
 * Important count, and no review asked. A Review round 3 that posted an Important holds the PR for the Owner.
 * A Delta read leaves the rounds as they are and records only its patch; its Important holds the PR for
 * the Owner, and a PR held already keeps the hold it has.
 */
export function afterReview(record: StateRecord, result: ReportedResult): StateRecord {
  const { round } = result.request;
  const important = importantOf(result);

  if (round === DELTA_READ) {
    const read: StateRecord = { ...withoutReview(record), deltaReadPatch: result.request.patch };

    return important > 0 && record.ownerHold === undefined
      ? {
          ...read,
          ownerHold: `The Delta read of a push after Review round 3 posted ${important} Important finding(s).`,
        }
      : read;
  }

  const next: StateRecord = {
    ...withoutReview(record),
    reviewedPatch: result.request.patch,
    reviewedHead: result.request.head,
    reviewRounds: round,
    importantByRound: countedAt(record.importantByRound ?? [], round, important),
  };

  return round === 3 && important > 0
    ? { ...next, ownerHold: `Review round 3 posted ${important} Important finding(s).` }
    : next;
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

export const runningSteps = (round: ReviewRound): readonly Step[] => {
  const check = pending(reviewRunningOf(round));

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
        check: { kind: "failure", summary: `${reviewNameOf(review.round)} failed (run ${review.runId}): ${cause}` },
      },
      { kind: "land-gate", check: pending("Not landable: the Code review failed.") },
    ],
  };
}

/** What a reported round makes of the Important threads open before it. */
export interface EarlierImportants {
  /** The earlier threads the round reports again: they stay open, and each takes the round's finding as a reply. */
  readonly kept: readonly string[];
  /** The earlier threads the round no longer holds: the Merge bot resolves them. */
  readonly closed: readonly string[];
  /** The threads open before a round that named no earlier finding, a Review round 1 or one whose report predates the naming: they stay as they are. */
  readonly left: number;
}

/**
 * The fix of an Important is never declared by its author: a later read closes it. Each round after the
 * first, and each Delta read, which is shown the open Importants alone, reports again every earlier
 * Important that is still wrong, naming its thread in `earlier`; an open Important thread of an earlier
 * review that the read does not name is closed. A thread the review of `result` posted itself, when its
 * posting is retried, is not an earlier one. A report that was not asked to name the earlier findings
 * closes none.
 */
export function earlierImportantsOf(result: ReportedResult, open: readonly ImportantThread[]): EarlierImportants {
  const { patch, round } = result.request;

  const earlier = open.flatMap((found) =>
    found.review === null || found.review.patch !== patch || found.review.round !== round ? [found.thread] : [],
  );

  if (round === 1 || !result.report.namesEarlier) {
    return { kept: [], closed: [], left: earlier.length };
  }

  const again = new Set<string | null>();

  for (const finding of result.report.findings) {
    if (finding.severity === "important") {
      again.add(finding.earlier);
    }
  }

  return {
    kept: earlier.filter((thread) => again.has(thread)),
    closed: earlier.filter((thread) => !again.has(thread)),
    left: 0,
  };
}

/** The findings of `result` the review posts as new threads: all but an Important that reports again a thread of `heldOpen`, which takes it as a reply. */
export function postedFindingsOf(
  result: ReportedResult,
  heldOpen: readonly string[],
): ReportedResult["report"]["findings"] {
  return result.report.findings.filter(
    (finding) => !(finding.severity === "important" && heldOpen.some((thread) => thread === finding.earlier)),
  );
}

/**
 * Whether the review of `result` sends the PR back to draft, for its Author's turn: an Important does,
 * whoever opened the PR; a Nit does on a PR the Author's machine account opened, which then cannot land
 * before that Author's next stop. A PR the Owner opened stays ready after Nits alone. A Delta read on a PR
 * `record` holds for the Owner sends nothing back: the Owner, the last reader, is asked after each read,
 * and a draft would keep the Owner out while the Author pushes again. A Review round always asks its Author.
 */
function sendsBack(snapshot: Snapshot, record: StateRecord, result: ReportedResult): boolean {
  const reports = (severity: "important" | "nit"): boolean =>
    result.report.findings.some((finding) => finding.severity === severity);

  const heldRead = result.request.round === DELTA_READ && record.ownerHold !== undefined;

  return !snapshot.draft && !heldRead && (reports("important") || (reports("nit") && snapshot.openedByAuthor));
}

/**
 * The review is posted, the earlier Importants it no longer holds are resolved, the PR goes back to
 * draft when the round asks its Author for something, and only then is the round recorded: a run that
 * stops before the record does all of it again. The Review check counts the Important findings open
 * once the review is posted. A Delta read posts its Importants alone: a Nit after Review round 3 is not
 * worth another turn. A Land approval given before the review stops counting once it is posted
 * (`landApprovalCounts`), and the next decision removes it.
 */
function postedSteps(snapshot: Snapshot, record: StateRecord, reported: ReportedResult): readonly Step[] {
  const result: ReportedResult =
    reported.request.round === DELTA_READ
      ? {
          ...reported,
          report: {
            ...reported.report,
            findings: reported.report.findings.filter((finding) => finding.severity === "important"),
          },
        }
      : reported;

  const earlier = earlierImportantsOf(result, snapshot.openImportant);

  return [
    { kind: "post-review", result, heldOpen: earlier.kept },
    ...(earlier.closed.length === 0 ? [] : [{ kind: "resolve-threads", threads: earlier.closed } as const]),
    ...(sendsBack(snapshot, record, result) ? [{ kind: "to-draft" } as const] : []),
    { kind: "record", record: afterReview(record, result) },
    {
      kind: "review-check",
      check: importantCheckOf(importantOf(result) + earlier.left, snapshot.rejectedImportant),
    },
  ];
}

/** The Review check of the Important findings: red while one is open, and it counts those the Author rejected apart. */
export function importantCheckOf(open: number, rejected: number): CheckState {
  const rejectedText = rejected === 0 ? "" : `; ${rejected} rejected by the Author`;

  return open === 0
    ? { kind: "success", summary: `No Important finding open${rejectedText}.` }
    : { kind: "failure", summary: `${open} Important finding(s) open${rejectedText}.` };
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

  return { record, end: postedSteps(snapshot, record, outcome.result) };
}
