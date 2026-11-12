/**
 * What a decision of the Merge bot returns: the steps to take, in order. The shell (`main.live.ts`)
 * performs them and, after a step whose outcome the next decision reads (`route`, `post-review`), decides
 * again with it in the state record.
 */

import type { LandRoute, ReviewDepth } from "../../contract.ts";
import type { ReportedResult } from "../review/review-report.ts";
import type { ReviewRound } from "../shared/review-round.ts";
import type { StateRecord } from "./record.ts";

export type CheckState =
  | { readonly kind: "pending"; readonly summary: string }
  | { readonly kind: "success"; readonly summary: string }
  | { readonly kind: "failure"; readonly summary: string };

export type Step =
  | { readonly kind: "route"; readonly patch: string; readonly patchDelta: boolean }
  | { readonly kind: "labels"; readonly route: LandRoute; readonly depth: ReviewDepth }
  | {
      readonly kind: "request-review";
      readonly depth: Exclude<ReviewDepth, "none">;
      readonly reviewRound: ReviewRound;
      /** Whether the review runs a security pass after the Code review: the whole PR's Routing answer says so. */
      readonly security: boolean;
    }
  /** Posts the review of `result` once: a new thread per finding, but a reply in its own thread for an Important that reports again one of `heldOpen`. */
  | { readonly kind: "post-review"; readonly result: ReportedResult; readonly heldOpen: readonly string[] }
  /** Resolves review threads of the App: the Importants a later read no longer holds. */
  | { readonly kind: "resolve-threads"; readonly threads: readonly string[] }
  /** Opens the follow-up issue that lists the Important findings of `threads`, which the Owner's Land approval lands open, and records it. */
  | { readonly kind: "follow-up"; readonly threads: readonly string[] }
  /** Resolves the Important threads the Owner's Land approval lands open, each after a reply that says so (`landedOpenNoteOf`). */
  | { readonly kind: "land-open"; readonly threads: readonly string[] }
  /** Sends the PR back to draft: its Author's turn. */
  | { readonly kind: "to-draft" }
  | { readonly kind: "review-check"; readonly check: CheckState }
  | { readonly kind: "land-gate"; readonly check: CheckState }
  | { readonly kind: "record"; readonly record: StateRecord }
  | { readonly kind: "remove-land-approval" }
  /** A new comment on the PR, so that GitHub notifies the Owner: it does not notify an edit. */
  | { readonly kind: "owner-comment"; readonly body: string }
  | { readonly kind: "auto-merge" };

export type Decision =
  { readonly kind: "ignore"; readonly reason: string } | { readonly kind: "steps"; readonly steps: readonly Step[] };

export const pending = (summary: string): CheckState => ({ kind: "pending", summary });
