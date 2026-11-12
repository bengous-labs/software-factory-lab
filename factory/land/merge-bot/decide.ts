/**
 * The Merge bot's decision, a pure function over a snapshot of one PR. Each Merge bot run re-reads
 * the whole state, so an event that arrives twice, late or not at all changes nothing. It returns the
 * steps to take in order. This file assembles the rules: the state record (`record.ts`), the review the
 * record asked (`review-job.ts`), the read a patch needs (`review-rounds.ts`), and what the gate and the
 * labels say (`gate.ts`).
 */

import { LAND_APPROVAL_LABEL } from "../../contract.ts";
import { TRUNK } from "../../install/host.ts";
import {
  ciSummary,
  landApprovalOf,
  ownerWaitOf,
  ownerWaitSteps,
  REMOVAL_COMMENTS,
  reviewCheckOf,
  risen,
  risenDepth,
} from "./gate.ts";
import type { StateRecord } from "./record.ts";
import { importantCheckOf, reviewStepsOf, runningSteps } from "./review-job.ts";
import { heldAfterRound3, roundNeedOf } from "./review-rounds.ts";
import type { Snapshot } from "./snapshot.ts";
import { pending } from "./steps.ts";
import type { CheckState, Decision, Step } from "./steps.ts";

/**
 * After Review round 3 the Owner is the last reader: an Important still open on a PR held for the Owner
 * lands open with the Owner's Land approval for this patch, whatever threads are open, once it lands,
 * `landing`. The follow-up issue goes first and is recorded, so a run that stops before the threads close
 * opens none again. No step when no Important is open or the PR does not land.
 */
function landedOpenSteps(snapshot: Snapshot, record: StateRecord, landing: boolean): readonly Step[] {
  const threads = snapshot.openImportant.map((found) => found.thread);

  if (threads.length === 0 || !landing) {
    return [];
  }

  return [
    ...(record.followUpIssue === undefined ? [{ kind: "follow-up", threads } as const] : []),
    { kind: "land-open", threads },
  ];
}

/** The decision on a PR that gets no route: one closed or from outside is ignored, an empty one has nothing to land. */
function unroutedOf(snapshot: Snapshot): Decision | null {
  if (snapshot.state !== "OPEN") {
    return { kind: "ignore", reason: `#${snapshot.number} is ${snapshot.state.toLowerCase()}` };
  }

  if (!snapshot.sameRepository || !snapshot.openedByFactory) {
    return { kind: "ignore", reason: `#${snapshot.number} was not opened by the Owner or the Author` };
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
  const machine = reviewStepsOf(snapshot, heldAfterRound3(approval.next, snapshot.patch));
  const next = machine.record;

  // The comment goes first: a run that stops between them posts it again rather than never, since the
  // next run, with the label gone, has no approval left to remove.
  if (approval.removed !== null) {
    steps.push({ kind: "owner-comment", body: REMOVAL_COMMENTS[approval.removed] }, { kind: "remove-land-approval" });
  }

  // Written now: a routing or a review below ends this decision before the Land gate is reached.
  if (next !== record) {
    steps.push({ kind: "record", record: next });
  }

  if (machine.end !== null) {
    return { kind: "steps", steps: [...steps, ...machine.end] };
  }

  const landApproved = snapshot.landApprovalByOwner && next.landOkPatch === snapshot.patch;

  const finish = (gate: CheckState): Extract<Decision, { readonly kind: "steps" }> => {
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
    return finish({
      kind: "failure",
      summary: `This PR conflicts with ${TRUNK}: rebase it onto origin/${TRUNK}, then stop.`,
    });
  }

  const routing = next.triage[snapshot.patch];

  if (snapshot.ci === null) {
    return finish(pending(ciSummary("Waiting for validate and mutation.", next, snapshot.patch)));
  }

  if (snapshot.ci === "failure") {
    return finish(pending(ciSummary("validate or mutation is red: the author's turn.", next, snapshot.patch)));
  }

  if (routing === undefined) {
    steps.push({ kind: "route", patch: snapshot.patch, patchDelta: next.reviewedPatch !== null });

    return { kind: "steps", steps };
  }

  const open = snapshot.openImportant.length;

  const need = roundNeedOf(next, routing, risenDepth(snapshot.labels, routing.review), {
    patch: snapshot.patch,
    open,
  });

  const labels = risen(snapshot.labels, snapshot.humanLabelBy, {
    land: next.ownerHold === undefined ? routing.land : "owner",
    review: routing.review,
  });

  steps.push({ kind: "labels", ...labels });

  if (need !== null) {
    steps.push(
      { kind: "request-review", depth: need.depth, reviewRound: need.round, security: routing.security === true },
      ...runningSteps(need.round),
    );

    return { kind: "steps", steps };
  }

  if (open > 0 && next.ownerHold === undefined) {
    steps.push({ kind: "review-check", check: importantCheckOf(open, snapshot.rejectedImportant) });

    return finish(pending("Not landable: Important findings are open."));
  }

  // While the Trunk is red the PR does not land: its threads stay open, and no issue says they landed.
  const landedOpen = landedOpenSteps(snapshot, next, landApproved && !snapshot.devRed);

  steps.push(...landedOpen, {
    kind: "review-check",
    check: reviewCheckOf(snapshot, labels.depth, landedOpen.length > 0),
  });

  const { route } = labels;

  if (snapshot.devRed) {
    return finish(pending(`${TRUNK} is red: landing is on hold.`));
  }

  if (route === "auto" || landApproved) {
    const gate = finish({
      kind: "success",
      summary:
        route === "auto"
          ? "Landable, land:auto."
          : `Landable, with the Owner's Land approval (label ${LAND_APPROVAL_LABEL}).`,
    });

    return { kind: "steps", steps: [...gate.steps, { kind: "auto-merge" }] };
  }

  steps.push(
    ...ownerWaitSteps(next, snapshot.patch, ownerWaitOf(next.ownerHold, snapshot.humanLabelBy, routing.reason)),
  );

  return { kind: "steps", steps };
}
