/**
 * The PR conductor's decision, a pure function over a snapshot of one PR. Each run re-reads the
 * whole state, so an event that arrives twice, late or not at all changes nothing. It returns the
 * steps to take in order; the adapter (`main.ts`) performs them and stops at the first that needs
 * a model's answer (`triage`, `review`), then runs again with that answer in the state record.
 */

export type Land = "auto" | "human";

export type Level = "none" | "light" | "deep";

const LAND_RANK: Record<Land, number> = { auto: 0, human: 1 };

const LEVEL_RANK: Record<Level, number> = { none: 0, light: 1, deep: 2 };

export interface Triage {
  readonly land: Land;
  readonly review: Level;
  /** On a delta after a fixed Important: whether the fix is risky enough for a second round. */
  readonly secondRound: boolean;
  readonly reason: string;
}

/** The record the App keeps in one comment per PR. */
export interface StateRecord {
  /** The patch the last review read, or null before any review. */
  readonly reviewedPatch: string | null;
  /** The head that review read, from which a round-2 delta is diffed. */
  readonly reviewedHead: string | null;
  /** Reviews that posted at least one Important. */
  readonly rounds: number;
  /** The triage of each patch, keyed by patch identity. */
  readonly triage: Readonly<Record<string, Triage>>;
  /** The patch the owner's `land-ok` was given for. */
  readonly landOkPatch: string | null;
  /** The queue removed the PR at this head, for this reason. */
  readonly dequeued: { readonly head: string; readonly reason: string } | null;
}

export const EMPTY_RECORD: StateRecord = {
  reviewedPatch: null,
  reviewedHead: null,
  rounds: 0,
  triage: {},
  landOkPatch: null,
  dequeued: null,
};

export interface Snapshot {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly sameRepository: boolean;
  /** The PR's author is the owner, the only author this public lab works for. */
  readonly ownAuthor: boolean;
  readonly draft: boolean;
  readonly head: string;
  readonly patch: string;
  /** `validate` on the head: null while it has not completed. */
  readonly ci: "success" | "failure" | null;
  readonly labels: readonly string[];
  /** `land-ok` is on the PR and the owner put it there. */
  readonly landOkByOwner: boolean;
  readonly openImportant: number;
  readonly devRed: boolean;
  readonly record: StateRecord;
}

export type CheckState =
  | { readonly kind: "pending"; readonly summary: string }
  | { readonly kind: "success"; readonly summary: string }
  | { readonly kind: "failure"; readonly summary: string };

export type Step =
  | { readonly kind: "triage"; readonly patch: string; readonly delta: boolean }
  | { readonly kind: "labels"; readonly land: Land; readonly review: Level }
  | { readonly kind: "review"; readonly level: Exclude<Level, "none">; readonly round: 1 | 2 }
  | { readonly kind: "agent-review"; readonly check: CheckState }
  | { readonly kind: "land-gate"; readonly check: CheckState }
  | { readonly kind: "needs-human"; readonly reason: string }
  | { readonly kind: "record"; readonly record: StateRecord }
  | { readonly kind: "remove-land-ok" }
  | { readonly kind: "auto-merge" };

export type Decision =
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "steps"; readonly steps: readonly Step[] };

/** Labels only rise: the higher of what is on the PR and what the triage answers. */
export function risen(labels: readonly string[], triage: Triage): { land: Land; review: Level } {
  const onPrLand: Land = labels.includes("land:human") ? "human" : "auto";
  const onPrReview = (["deep", "light", "none"] as const).find((level) => labels.includes(`review:${level}`));

  return {
    land: LAND_RANK[onPrLand] > LAND_RANK[triage.land] ? onPrLand : triage.land,
    review: onPrReview !== undefined && LEVEL_RANK[onPrReview] > LEVEL_RANK[triage.review] ? onPrReview : triage.review,
  };
}

const pending = (summary: string): CheckState => ({ kind: "pending", summary });

export function decide(snapshot: Snapshot): Decision {
  const { record } = snapshot;

  if (snapshot.state !== "OPEN") return { kind: "ignore", reason: `#${snapshot.number} is ${snapshot.state.toLowerCase()}` };

  if (!snapshot.sameRepository || !snapshot.ownAuthor) {
    return { kind: "ignore", reason: `#${snapshot.number} comes from outside the owner's own branches` };
  }

  const steps: Step[] = [];
  let next: StateRecord = record;

  if (snapshot.labels.includes("land-ok")) {
    if (!snapshot.landOkByOwner) steps.push({ kind: "remove-land-ok" });
    else if (record.landOkPatch === null) next = { ...next, landOkPatch: snapshot.patch };
    else if (record.landOkPatch !== snapshot.patch) {
      steps.push({ kind: "remove-land-ok" });
      next = { ...next, landOkPatch: null };
    }
  }

  const landOk = snapshot.landOkByOwner && next.landOkPatch === snapshot.patch;
  const finish = (gate: CheckState): Decision => {
    if (next !== record) steps.push({ kind: "record", record: next });
    steps.push({ kind: "land-gate", check: gate });

    return { kind: "steps", steps };
  };

  if (record.dequeued !== null && record.dequeued.head === snapshot.head) {
    return finish({ kind: "failure", summary: `The merge queue removed this PR: ${record.dequeued.reason}` });
  }

  if (snapshot.draft) return finish(pending("Draft: the author's turn."));

  if (snapshot.ci === null) return finish(pending("Waiting for validate."));

  if (snapshot.ci === "failure") return finish(pending("validate is red: the author's turn."));

  const triage = next.triage[snapshot.patch];

  if (triage === undefined) {
    steps.push({ kind: "triage", patch: snapshot.patch, delta: next.reviewedPatch !== null });

    return { kind: "steps", steps };
  }

  const labels = risen(snapshot.labels, triage);
  steps.push({ kind: "labels", ...labels });

  if (next.reviewedPatch !== snapshot.patch && labels.review !== "none") {
    if (next.reviewedPatch === null) {
      steps.push({ kind: "review", level: labels.review, round: 1 });

      return { kind: "steps", steps };
    }

    // A later patch is read again only when the triage of its delta asks for it.
    if (next.rounds < 2 && triage.secondRound) {
      steps.push({ kind: "review", level: labels.review, round: next.rounds === 0 ? 1 : 2 });

      return { kind: "steps", steps };
    }

    if (next.rounds >= 2 && triage.secondRound) {
      steps.push({ kind: "labels", land: "human", review: labels.review });
      steps.push({ kind: "needs-human", reason: "A third review round would be needed: the owner decides." });
    }
  }

  if (snapshot.openImportant > 0) {
    steps.push({ kind: "agent-review", check: { kind: "failure", summary: `${snapshot.openImportant} Important finding(s) open.` } });

    return finish(pending("Not converged: Important findings are open."));
  }

  steps.push({
    kind: "agent-review",
    check: { kind: "success", summary: labels.review === "none" ? "review:none, nothing to read." : "No Important finding open." },
  });

  const land = next.rounds >= 2 ? "human" : labels.land;

  if (snapshot.devRed) return finish(pending("dev is red: landing is on hold."));

  if (land === "auto" || landOk) {
    const gate = finish({ kind: "success", summary: land === "auto" ? "Converged, land:auto." : "Converged, land-ok from the owner." });

    if (gate.kind === "steps") return { kind: "steps", steps: [...gate.steps, { kind: "auto-merge" }] };
  }

  return finish(pending("Converged, land:human: waiting for the owner's land-ok."));
}
