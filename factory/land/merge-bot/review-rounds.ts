/**
 * Which read a patch needs after the ones the change had: the next Review round, a Delta read after Review
 * round 3, or none, and the hold for the Owner when a push after round 3 needs a read no Delta read gives.
 */

import { DELTA_READ } from "../../contract.ts";
import type { ReviewDepth } from "../../contract.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import type { ReviewRound } from "../shared/review-round.ts";
import type { StateRecord } from "./record.ts";

/**
 * The record with an Owner hold when this patch, routed, comes after Review round 3 and its Patch delta
 * needs a read other than a Delta read: no Review round 4 runs. The same record otherwise.
 */
export function heldAfterRound3(record: StateRecord, patch: string): StateRecord {
  const routing = record.triage[patch];
  const needsRead = routing?.secondRound === true && routing.deltaRead !== true;

  return record.reviewRounds === 3 && record.reviewedPatch !== patch && needsRead && record.ownerHold === undefined
    ? { ...record, ownerHold: "A push after Review round 3 needs a read." }
    : record;
}

/** The Review round to request for this patch, at the PR's risen depth. */
export interface RoundNeed {
  readonly depth: Exclude<ReviewDepth, "none">;
  readonly round: ReviewRound;
}

/**
 * The Review round this patch needs; null when none. A later patch is read again when its Patch delta
 * needs a read, and always when the last round posted an Important, or its count is unknown, whatever
 * the Routing answer says of the delta. Review round 3 is the last; after it, a patch gets one Delta
 * read, light, once, whatever its depth: on a PR held for the Owner with an open Important, `open` of
 * them, so that a read says which are fixed before the Owner is asked, the PR held whatever it finds; and
 * on a PR no one holds for the Owner, when it is routed for one, since such a read holds no PR for the
 * Owner and a depth of none must not leave it unread.
 */
export function roundNeedOf(
  record: StateRecord,
  routing: RoutingAnswer,
  depth: ReviewDepth,
  { patch, open }: { readonly patch: string; readonly open: number },
): RoundNeed | null {
  if (record.reviewedPatch === patch) {
    return null;
  }

  if (record.reviewRounds === 3) {
    const owed = record.ownerHold === undefined ? routing.deltaRead === true : open > 0;
    const deltaRead = record.deltaReadPatch !== patch && owed;

    return deltaRead ? { depth: "light", round: DELTA_READ } : null;
  }

  if (depth === "none") {
    return null;
  }

  if (record.reviewRounds === 0) {
    return { depth, round: 1 };
  }

  if (record.reviewRounds !== 1 && record.reviewRounds !== 2) {
    return null;
  }

  const lastImportant = record.importantByRound?.[record.reviewRounds - 1] ?? null;
  const owed = routing.secondRound || lastImportant === null || lastImportant > 0;

  return owed ? { depth, round: record.reviewRounds === 1 ? 2 : 3 } : null;
}
