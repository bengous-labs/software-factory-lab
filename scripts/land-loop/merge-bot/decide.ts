/**
 * The Merge bot's decision, a pure function over a snapshot of one PR. Each Merge bot run re-reads
 * the whole state, so an event that arrives twice, late or not at all changes nothing. It returns the
 * steps to take in order; the adapter (`main.ts`) performs them and stops at the first that needs
 * a model's answer (`route`, `code-review`, `principal-judge`), then decides again with that answer
 * in the state record.
 */

/** Who lands a change: `auto`, the Merge bot alone, or `owner`, with a Land approval. */
export type LandRoute = "auto" | "owner";

/**
 * The Land route as the `land:*` labels and the state record store it. An external name: open PRs
 * and existing records carry `human` for `owner`, so the stored value stays; anything but `auto`
 * reads as `owner`, the safe side.
 */
export type StoredLandRoute = "auto" | "human";

export const landRouteOf = (stored: string): LandRoute => (stored === "auto" ? "auto" : "owner");

export const storedLandRouteOf = (route: LandRoute): StoredLandRoute => (route === "auto" ? "auto" : "human");

export type ReviewDepth = "none" | "light" | "deep";

const LAND_ROUTE_RANK: Record<LandRoute, number> = { auto: 0, owner: 1 };

const DEPTH_RANK: Record<ReviewDepth, number> = { none: 0, light: 1, deep: 2 };

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
  /** A change to the Land loop's own code only: land:auto holds only once the Principal judge answers OK. */
  readonly needsFable?: boolean;
}

/** Principal judge runs per patch that may give no verdict before the change goes to the owner. */
export const PRINCIPAL_JUDGE_TRIES = 2;

/** The record after one Principal judge run on `patch`: its verdict, or one more failure when it gave none. */
export function afterPrincipalJudge(
  record: StateRecord,
  patch: string,
  verdict: PrincipalJudgeVerdict | null,
): StateRecord {
  if (verdict !== null) {
    return { ...record, fable: { ...record.fable, [patch]: verdict } };
  }

  return {
    ...record,
    fableFailures: { ...record.fableFailures, [patch]: (record.fableFailures?.[patch] ?? 0) + 1 },
  };
}

export interface PrincipalJudgeVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * The record the App keeps in one comment per PR. Its keys are the stored record's format, an
 * external name: existing records must still read, so they stay as they are. `triage` holds the
 * Routing answers, `dequeued` the Ejection, `fable` the Principal judge.
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
  /** Important findings posted in a review's body, with no thread to resolve, per patch reviewed. */
  readonly bodyImportant?: Readonly<Record<string, number>>;
  /** The Principal judge's verdict on each patch that needs one, keyed by patch identity. */
  readonly fable?: Readonly<Record<string, PrincipalJudgeVerdict>>;
  /** Principal judge runs that gave no verdict, per patch. */
  readonly fableFailures?: Readonly<Record<string, number>>;
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

/** The record a comment stores, with each Land route read back from its stored value. */
export function recordOfStored(stored: StoredRecord): StateRecord {
  const triage = Object.entries(stored.triage).map(
    ([patch, routing]) => [patch, { ...routing, land: landRouteOf(routing.land) }] as const,
  );

  return { ...stored, triage: Object.fromEntries(triage) };
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

  return recordOfStored({ ...noReview, ...(JSON.parse(json) as Partial<StoredRecord>) });
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
  /** `validate` on the head: null while it has not completed. */
  readonly ci: "success" | "failure" | null;
  readonly labels: readonly string[];
  /** The Land approval label is on the PR and the owner put it there. */
  readonly landApprovalByOwner: boolean;
  readonly openImportant: number;
  readonly devRed: boolean;
  /** GitHub reads the PR as conflicting with its base: no CI runs on it and the queue refuses it. */
  readonly conflicting: boolean;
  readonly record: StateRecord;
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

/** Open Important findings: the unresolved threads, plus those posted with no thread, until the patch changes. */
export function openImportantOf(threads: number, record: StateRecord, patch: string): number {
  return threads + (record.bodyImportant?.[patch] ?? 0);
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
  | { readonly kind: "code-review"; readonly depth: Exclude<ReviewDepth, "none">; readonly reviewRound: 1 | 2 }
  | { readonly kind: "review-check"; readonly check: CheckState }
  | { readonly kind: "land-gate"; readonly check: CheckState }
  | { readonly kind: "needs-owner"; readonly reason: string }
  | { readonly kind: "record"; readonly record: StateRecord }
  | { readonly kind: "remove-land-approval" }
  | { readonly kind: "principal-judge"; readonly patch: string }
  | { readonly kind: "auto-merge" };

export type Decision =
  { readonly kind: "ignore"; readonly reason: string } | { readonly kind: "steps"; readonly steps: readonly Step[] };

/**
 * Labels only rise: the higher of what is on the PR and what the Routing answer says. The `land:*` and
 * `review:*` labels, read here and quoted in the check summaries below, are external names: open PRs
 * carry them, so the strings stay.
 */
export function risen(labels: readonly string[], routing: RoutingAnswer): { route: LandRoute; depth: ReviewDepth } {
  const onPrRoute: LandRoute = labels.includes(`land:${storedLandRouteOf("owner")}`) ? "owner" : "auto";
  const onPrDepth = (["deep", "light", "none"] as const).find((depth) => labels.includes(`review:${depth}`));

  return {
    route: LAND_ROUTE_RANK[onPrRoute] > LAND_ROUTE_RANK[routing.land] ? onPrRoute : routing.land,
    depth: onPrDepth !== undefined && DEPTH_RANK[onPrDepth] > DEPTH_RANK[routing.review] ? onPrDepth : routing.review,
  };
}

const pending = (summary: string): CheckState => ({ kind: "pending", summary });

/**
 * The record after reading the Land approval label, the only change a decision makes to it, and
 * whether the label goes. A label someone else put goes; one given for another patch goes and clears
 * its patch; a patch left in the record without the label is cleared, so a new Land approval counts.
 */
export function landApprovalOf(snapshot: Snapshot, record: StateRecord): { next: StateRecord; removeLabel: boolean } {
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

export function decide(snapshot: Snapshot): Decision {
  const { record } = snapshot;

  if (snapshot.state !== "OPEN") {
    return { kind: "ignore", reason: `#${snapshot.number} is ${snapshot.state.toLowerCase()}` };
  }

  if (!snapshot.sameRepository || !snapshot.openedByOwner) {
    return { kind: "ignore", reason: `#${snapshot.number} comes from outside the Owner's own branches` };
  }

  const steps: Step[] = [];
  const { next, removeLabel } = landApprovalOf(snapshot, record);

  if (removeLabel) {
    steps.push({ kind: "remove-land-approval" });
  }

  // Written now: a routing or a Code review below ends this decision before the Land gate is reached.
  if (next !== record) {
    steps.push({ kind: "record", record: next });
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
    return finish(pending("Waiting for validate."));
  }

  if (snapshot.ci === "failure") {
    return finish(pending("validate is red: the author's turn."));
  }

  const routing = next.triage[snapshot.patch];

  if (routing === undefined) {
    steps.push({ kind: "route", patch: snapshot.patch, patchDelta: next.reviewedPatch !== null });

    return { kind: "steps", steps };
  }

  const labels = risen(snapshot.labels, routing);
  steps.push({ kind: "labels", ...labels });

  let thirdRoundNeeded = false;

  if (next.reviewedPatch !== snapshot.patch && labels.depth !== "none") {
    if (next.reviewRounds === 0) {
      steps.push({ kind: "code-review", depth: labels.depth, reviewRound: 1 });

      return { kind: "steps", steps };
    }

    // A later patch is read again only when the Routing answer of its Patch delta asks for it.
    if (routing.secondRound && next.reviewRounds === 1) {
      steps.push({ kind: "code-review", depth: labels.depth, reviewRound: 2 });

      return { kind: "steps", steps };
    }

    if (routing.secondRound) {
      thirdRoundNeeded = true;
      steps.push(
        { kind: "labels", route: "owner", depth: labels.depth },
        { kind: "needs-owner", reason: "A third Review round would be needed: the Owner decides." },
      );
    }
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

  let route: LandRoute = thirdRoundNeeded ? "owner" : labels.route;

  // Not when a third Review round is needed: no Code review read the risky Patch delta it would judge.
  if (routing.needsFable === true && !thirdRoundNeeded) {
    const verdict = next.fable?.[snapshot.patch];

    if (verdict === undefined && (next.fableFailures?.[snapshot.patch] ?? 0) < PRINCIPAL_JUDGE_TRIES) {
      steps.push({ kind: "principal-judge", patch: snapshot.patch });

      return { kind: "steps", steps };
    }

    // No verdict after PRINCIPAL_JUDGE_TRIES failed runs counts as NOT OK.
    if (verdict?.ok !== true && route === "auto") {
      steps.push({ kind: "labels", route: "owner", depth: labels.depth });
      route = "owner";
    }
  }

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
