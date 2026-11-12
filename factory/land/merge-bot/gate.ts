/**
 * What the Land gate and the labels say of a PR, and why one waits: the labels that rise, the Owner's Land
 * approval as the record reads it, the wait for the Owner with the comment that asks, and the Review check
 * of a PR no review runs on.
 */

import { LAND_APPROVAL_LABEL, LAND_GATE, reviewLabelOf } from "../../contract.ts";
import type { LandRoute, ReviewDepth } from "../../contract.ts";
import { escapeInline } from "../../lib/markdown.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import { Round } from "../shared/review-round.ts";
import type { StateRecord } from "./record.ts";
import { importantCheckOf, reviewRunningOf } from "./review-job.ts";
import type { Snapshot } from "./snapshot.ts";
import { pending } from "./steps.ts";
import type { CheckState, Step } from "./steps.ts";

/**
 * The `land:*` label follows the route the decision computes, except a `land:human` that neither the
 * Merge bot's App nor the Author's machine account set: the Owner's veto, which stays. The `review:*` label only rises. The
 * `land:*` and `review:*` labels, read here and quoted in the check summaries below, are external names:
 * open PRs carry them, so the strings stay.
 */
export interface RisenLabels {
  readonly route: LandRoute;
  readonly depth: ReviewDepth;
}

export function risenDepth(labels: readonly string[], review: ReviewDepth): ReviewDepth {
  return (
    (["deep", "light", "none"] as const).find((depth) => depth === review || labels.includes(reviewLabelOf(depth))) ??
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

/**
 * The record after reading the Land approval label, the only change a decision makes to it, and
 * why the label goes, or null when it stays. A label someone else put goes; one given for another
 * patch goes and clears its patch; a patch left in the record without the label is cleared, so a new
 * Land approval counts.
 */
export interface LandApproval {
  readonly next: StateRecord;
  readonly removed: "earlier-patch" | "not-owner" | null;
}

export function landApprovalOf(snapshot: Snapshot, record: StateRecord): LandApproval {
  if (!snapshot.labels.includes(LAND_APPROVAL_LABEL)) {
    return { next: record.landOkPatch === null ? record : { ...record, landOkPatch: null }, removed: null };
  }

  if (!snapshot.landApprovalByOwner) {
    return {
      next: record.landOkPatch === null ? record : { ...record, landOkPatch: null },
      removed: snapshot.landApprovalPutByOwner ? "earlier-patch" : "not-owner",
    };
  }

  if (record.landOkPatch === null) {
    return { next: { ...record, landOkPatch: snapshot.patch }, removed: null };
  }

  if (record.landOkPatch !== snapshot.patch) {
    return { next: { ...record, landOkPatch: null }, removed: "earlier-patch" };
  }

  return { next: record, removed: null };
}

/** The comment that says why the Land approval label went. */
export const REMOVAL_COMMENTS: Readonly<Record<NonNullable<LandApproval["removed"]>, string>> = {
  "earlier-patch": `The Land approval (${LAND_APPROVAL_LABEL}) was given before this push or before its latest review, so the Merge bot removed it: an approval covers only what the Owner could read. The ${LAND_GATE} check of this push says whether it waits for the Owner.`,
  "not-owner": `Only the Owner's Land approval counts: the Merge bot removed a ${LAND_APPROVAL_LABEL} the Owner did not put.`,
};

const OWNER_WAIT = `Waiting for the Owner's Land approval (label ${LAND_APPROVAL_LABEL}).`;

/** How the Land gate's summary opens while the PR waits for the Owner's Land approval. */
const OWNER_HELD = "Held for the Owner:";

/**
 * What a pending Land gate's summary says the PR waits for: the Owner's Land approval, a review that
 * runs (a Review round or the Delta read), or neither (null). The watch of an orchestrating session reads it.
 */
export function gateWaitOf(summary: string): "owner" | "review" | null {
  if (summary.startsWith(OWNER_HELD)) {
    return "owner";
  }

  return Round.literals.some((round) => summary === reviewRunningOf(round)) ? "review" : null;
}

/**
 * Why a PR that waits for the Owner's Land approval waits, the first reason that applies: the Owner
 * hold, a `land:human` no agent set, then the Routing rules. `asked` is the reason the
 * comment that asks the Owner gives, null when no comment asks: the Owner set that label.
 */
export interface OwnerWait {
  readonly summary: string;
  readonly asked: string | null;
}

export function ownerWaitOf(
  ownerHold: string | undefined,
  humanLabelBy: Snapshot["humanLabelBy"],
  reason: string,
): OwnerWait {
  if (ownerHold !== undefined) {
    return {
      summary: `${OWNER_HELD} ${ownerHold} ${OWNER_WAIT}`,
      asked: ownerHold.endsWith(".") ? ownerHold.slice(0, -1) : ownerHold,
    };
  }

  if (humanLabelBy === "other") {
    return { summary: `${OWNER_HELD} a land:human the Merge bot did not set. ${OWNER_WAIT}`, asked: null };
  }

  return {
    summary: `${OWNER_HELD} ${reason}. ${OWNER_WAIT} To keep it held whatever later pushes change, remove land:human and add it back.`,
    asked: reason,
  };
}

/**
 * The steps that end a decision waiting for the Owner: the comment that asks the Owner, once per
 * patch, then the record of the patch it was posted for, then the Land gate. The comment goes before
 * the record, so a run that stops between them posts it again rather than never.
 */
export function ownerWaitSteps(next: StateRecord, patch: string, wait: OwnerWait): readonly Step[] {
  const gate: Step = { kind: "land-gate", check: pending(wait.summary) };

  if (wait.asked === null || next.ownerAskedPatch === patch) {
    return [gate];
  }

  return [
    {
      kind: "owner-comment",
      body: `This PR waits for the Owner's Land approval: ${escapeInline(wait.asked)}. Add the label ${LAND_APPROVAL_LABEL} to land it.`,
    },
    { kind: "record", record: { ...next, ownerAskedPatch: patch } },
    gate,
  ];
}

/**
 * The CI summary, with a sentence more while this push is not routed after an earlier push was: the
 * labels a human sees are the previous push's.
 */
export const ciSummary = (summary: string, record: StateRecord, patch: string): string =>
  record.triage[patch] !== undefined || Object.keys(record.triage).length === 0
    ? summary
    : `${summary} This push is not routed yet: its labels are the previous push's.`;

/**
 * The Review check of a PR no review is running or owed on: green when the Owner's Land approval closes
 * the open Importants or when none is open, red while one waits.
 */
export function reviewCheckOf(snapshot: Snapshot, depth: ReviewDepth, ownerCloses: boolean): CheckState {
  const open = snapshot.openImportant.length;

  if (ownerCloses) {
    return { kind: "success", summary: `${open} Important finding(s) closed by the Owner's Land approval.` };
  }

  if (open === 0 && depth === "none") {
    return { kind: "success", summary: "review:none, nothing to read." };
  }

  return importantCheckOf(open, snapshot.rejectedImportant);
}
