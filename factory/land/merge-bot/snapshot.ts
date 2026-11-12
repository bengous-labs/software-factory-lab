/**
 * What a decision of the Merge bot reads: a snapshot of one PR, and the small readings of GitHub's answers
 * that fill it. Each Merge bot run re-reads the whole state, so an event that arrives twice, late or not at
 * all changes nothing.
 */

import type { ReviewResult } from "../review/review-report.ts";
import type { ImportantThread } from "../shared/finding.ts";
import type { StateRecord } from "./record.ts";

export interface Snapshot {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly sameRepository: boolean;
  /** The PR was opened by the Owner or by the Author's machine account, the only logins this public lab works for. */
  readonly openedByFactory: boolean;
  /** The PR was opened by the Author's machine account: a round that posts a finding sends it back to draft. */
  readonly openedByAuthor: boolean;
  readonly draft: boolean;
  readonly head: string;
  readonly patch: string;
  /** The PR changes no file between its merge base and its head: it has nothing to land, and no route. */
  readonly empty: boolean;
  /** CI_CHECKS on the head, as `ciOf` reads them: null while one has not completed. */
  readonly ci: "success" | "failure" | null;
  readonly labels: readonly string[];
  /**
   * Who set the PR's `land:human`, by its latest `labeled` event: the Merge bot's App, the Author's
   * machine account, any other login (an actor that does not read, or no such event, included), or null
   * when the PR has no `land:human`. Only `other` holds the PR: the Owner's veto. An agent's label
   * follows the route.
   */
  readonly humanLabelBy: "merge-bot" | "author" | "other" | null;
  /** The Land approval label is on the PR and the owner put it there, after this head was pushed and after the App's latest review (`landApprovalCounts`). */
  readonly landApprovalByOwner: boolean;
  /** The Land approval label is on the PR and the owner put it there, before or after this head was pushed. */
  readonly landApprovalPutByOwner: boolean;
  /** The App's unresolved Important threads. */
  readonly openImportant: readonly ImportantThread[];
  /** The App's Important findings the Author resolved with a rejection. */
  readonly rejectedImportant: number;
  /** CI is red on the Trunk's head: validate or mutation completed other than success. A check still running, or not yet posted, does not read as red. */
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

/**
 * The owner's Land approval counts only when it was put after the head it would land was pushed, and
 * after the App's latest review, `reviewedAt`, was posted: it covers only the findings the Owner could
 * read, and a review posted after it, a round or a Delta read, may post one it would land open unread.
 * Within the second a review is posted, the Owner read none of it.
 */
export function landApprovalCounts(
  byOwner: boolean,
  labeledAt: string | null,
  { headPushedAt, reviewedAt }: { readonly headPushedAt: string | null; readonly reviewedAt: string | null },
): boolean {
  if (!byOwner || labeledAt === null) {
    return false;
  }

  const labeled = Date.parse(labeledAt);
  const afterPush = headPushedAt === null || labeled >= Date.parse(headPushedAt);

  return afterPush && (reviewedAt === null || labeled > Date.parse(reviewedAt));
}
