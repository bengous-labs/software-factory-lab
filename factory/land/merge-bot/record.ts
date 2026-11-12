/**
 * The state record the App keeps in one comment per PR, and the comment that stores it. Its keys and its
 * marker are external names: existing records must still read, so they stay as they are.
 */

import { Schema, Struct } from "effect";

import { landRouteOf, MERGE_BOT_STATE_MARKER, storedLandRouteOf } from "../../contract.ts";
import type { StoredLandRoute } from "../../contract.ts";
import { decodeJson } from "../../lib/json.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import { Round } from "../shared/review-round.ts";

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
  /** The Review rounds posted on the change, whether they posted findings or not: 0 to 3. */
  readonly reviewRounds: number;
  /**
   * The Important findings each Review round posted, index 0 for round 1; null for a round posted before
   * the count was kept. Absent before any count. A missing or null count reads as an Important posted.
   */
  readonly importantByRound?: ReadonlyArray<number | null>;
  /** Why the PR is held for the Owner, who alone lands it then. Absent: no hold. Set once, never cleared. */
  readonly ownerHold?: string;
  /** The patch the Owner was last asked in a comment to give the Land approval for. Absent: never asked. */
  readonly ownerAskedPatch?: string;
  /** The patch the last Delta read read. Absent: none ran. */
  readonly deltaReadPatch?: string;
  /** The issue the Merge bot opened for the Important findings the Owner's Land approval landed open. Absent: none opened. */
  readonly followUpIssue?: number;
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
      security: Schema.optionalKey(Schema.Boolean),
      deltaRead: Schema.optionalKey(Schema.Boolean),
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
  importantByRound: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.Finite))),
  ownerHold: Schema.optionalKey(Schema.String),
  ownerAskedPatch: Schema.optionalKey(Schema.String),
  deltaReadPatch: Schema.optionalKey(Schema.String),
  followUpIssue: Schema.optionalKey(Schema.Int),
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

/**
 * The record's line in its comment: a line of its own, which no line of the ledger is, since each of
 * those opens with the ledger's own words. `JSON.stringify` writes no line break.
 */
const RECORD_LINE = new RegExp(`(?<=^|\\n)${MERGE_BOT_STATE_MARKER} ([^\\n]*) -->(?=\\n|$)`, "u");

/** The body of the comment that holds the state record: a line for the reader, the ledger, then the record. */
export function stateCommentOf(record: StateRecord, ledger: string): string {
  return [
    "Merge bot state for this PR. Do not edit.",
    ledger,
    `${MERGE_BOT_STATE_MARKER} ${JSON.stringify(storedOfRecord(record))} -->`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The record the comment `body` holds, with a ledger or from before the ledger; the empty record when it holds none. */
export function recordOfComment(body: string): StateRecord {
  const json = RECORD_LINE.exec(body)?.[1];

  return json === undefined ? EMPTY_RECORD : recordOfJson(json);
}
