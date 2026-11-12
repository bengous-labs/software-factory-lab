import { describe, expect, test } from "bun:test";

import type { LedgerFinding } from "../shared/finding.ts";
import { stateBodyOf } from "./ledger.ts";
import type { LedgerInputs, StateRead } from "./ledger.ts";
import { read } from "./merge-bot.fixtures.ts";
import { EMPTY_RECORD } from "./record.ts";
import type { StateRecord } from "./record.ts";
import { stepsDone } from "./steps-run.ts";
import type { Step } from "./steps.ts";

/** An open Important of round 1, as the ledger reads its thread. */
const OPEN_IMPORTANT: LedgerFinding = {
  thread: "T1",
  url: "https://github.com/o/r/pull/12#discussion_r1",
  where: "a.ts:3",
  file: "a.ts",
  severity: "important",
  security: false,
  summary: "off by one",
  round: 1,
  resolved: false,
  closedByApp: false,
  landedOpen: false,
  outdated: false,
  rejection: null,
  ownerAnswer: null,
  again: [],
};

const OPEN: LedgerInputs = { findings: [OPEN_IMPORTANT], fixed: new Set() };

/** The same Important, its thread closed by the App. */
const CLOSED: LedgerInputs = { findings: [{ ...OPEN_IMPORTANT, resolved: true, closedByApp: true }], fixed: new Set() };

const ROUND_1: StateRecord = { ...EMPTY_RECORD, reviewedPatch: "p1", reviewRounds: 1, importantByRound: [1] };

/** What a run of `stepsDone` over fakes did: whether to decide again, each write with the id it named, and how often it read the findings. */
interface StepsRun {
  readonly decideAgain: boolean;
  readonly writes: ReadonlyArray<{ readonly id: number | null; readonly body: string }>;
  readonly reads: number;
}

/**
 * `steps` done over the state comment `read`, from `record` and `inputs`: a `record` step writes its
 * record, a `route` step a routed one, a `follow-up` step one with issue 31, the step of kind `stopAt`
 * stops the run, and any other changes nothing. The findings read again are `reread`; a new comment gets id 99.
 */
async function stepsRun(
  steps: readonly Step[],
  start: { readonly read: StateRead; readonly record: StateRecord; readonly inputs: LedgerInputs },
  { reread, stopAt = null }: { readonly reread: LedgerInputs; readonly stopAt?: Step["kind"] | null },
): Promise<StepsRun> {
  const writes: Array<{ id: number | null; body: string }> = [];
  let reads = 0;

  const decideAgain = await stepsDone(steps, start, {
    perform: async (step, record, write) => {
      if (step.kind === stopAt) {
        return null;
      }

      const next =
        step.kind === "record"
          ? step.record
          : step.kind === "route"
            ? { ...record, triage: { [step.patch]: ROUTED } }
            : step.kind === "follow-up"
              ? { ...record, followUpIssue: 31 }
              : record;

      if (next !== record) {
        await write(next);
      }

      return next;
    },
    findings: () => {
      reads += 1;

      return Promise.resolve(reread.findings);
    },
    write: (id, body) => {
      writes.push({ id, body });

      return Promise.resolve(id ?? 99);
    },
  });

  return { decideAgain, writes, reads };
}

const ROUTED = {
  land: "auto",
  review: "light",
  secondRound: false,
  reason: "ordinary code",
  model: null,
} as const;

describe("stepsDone", () => {
  const check = { kind: "success", summary: "ok" } as const;

  test("the Owner's Land approval lands the open Importants open and no decision follows: the follow-up issue is recorded, the findings are read again and the comment shows them landed open", async () => {
    const steps: Step[] = [
      { kind: "labels", route: "owner", depth: "light" },
      { kind: "follow-up", threads: ["T1"] },
      { kind: "land-open", threads: ["T1"] },
      { kind: "review-check", check },
      { kind: "land-gate", check },
      { kind: "auto-merge" },
    ];

    const landed: LedgerInputs = {
      findings: [{ ...OPEN_IMPORTANT, resolved: true, closedByApp: true, landedOpen: true }],
      fixed: new Set(),
    };

    const followed: StateRecord = { ...ROUND_1, followUpIssue: 31 };

    const run = await stepsRun(
      steps,
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: landed },
    );

    expect(run.reads).toBe(1);
    expect(run.writes).toEqual([
      { id: 7, body: stateBodyOf(followed, OPEN) },
      { id: 7, body: stateBodyOf(followed, landed) },
    ]);
    expect(run.writes[1]?.body).toContain("**Landed open by the Owner's Land approval.** Important");
    expect(run.decideAgain).toBe(false);
  });

  test("a round's record is written once, with the ledger of the rounds it counts and the threads the round resolved", async () => {
    const round2: StateRecord = { ...ROUND_1, reviewedPatch: "p2", reviewRounds: 2, importantByRound: [1, 0] };

    const steps: Step[] = [
      { kind: "resolve-threads", threads: ["T1"] },
      { kind: "to-draft" },
      { kind: "record", record: round2 },
      { kind: "review-check", check },
    ];

    const run = await stepsRun(
      steps,
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.writes).toEqual([{ id: 7, body: stateBodyOf(round2, CLOSED) }]);
    expect(run.writes[0]?.body).toContain("**Fixed, confirmed by round 2.** Important");
    expect(run.decideAgain).toBe(false);
  });

  test("a PR with no comment gets one from the first step that writes a record, and the steps after it edit that comment", async () => {
    const recorded: StateRecord = { ...ROUND_1, triage: { p1: ROUTED }, landOkPatch: "p1" };

    const run = await stepsRun(
      [
        { kind: "route", patch: "p1", patchDelta: false },
        { kind: "record", record: recorded },
      ],
      { read: { id: null, body: null, record: EMPTY_RECORD }, record: EMPTY_RECORD, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.writes.map((write) => write.id)).toEqual([null, 99]);
    expect(run.writes.at(-1)?.body).toBe(stateBodyOf(recorded, OPEN));
    expect(run.reads).toBe(0);
    expect(run.decideAgain).toBe(true);
  });

  test("the ledger is written before the steps when only what it shows changed; a step that stops the run writes nothing after it, and no decision follows", async () => {
    const routed: StateRecord = { ...ROUND_1, triage: { p1: ROUTED } };

    const run = await stepsRun(
      [
        { kind: "route", patch: "p1", patchDelta: false },
        { kind: "resolve-threads", threads: ["T1"] },
        { kind: "to-draft" },
        { kind: "auto-merge" },
      ],
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: CLOSED },
      { reread: OPEN, stopAt: "to-draft" },
    );

    expect(run.writes).toEqual([
      { id: 7, body: stateBodyOf(ROUND_1, CLOSED) },
      { id: 7, body: stateBodyOf(routed, CLOSED) },
    ]);
    expect(run.decideAgain).toBe(false);
  });

  test("nothing is written when the comment holds the record and the ledger already", async () => {
    const run = await stepsRun(
      [{ kind: "to-draft" }],
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.writes).toEqual([]);
  });

  test("a step that posts a review has the PR decided again, so the decision reads what it posted", async () => {
    const run = await stepsRun(
      [
        { kind: "post-review", result: read(), heldOpen: [] },
        { kind: "review-check", check },
      ],
      { read: { id: 7, body: stateBodyOf(ROUND_1, OPEN), record: ROUND_1 }, record: ROUND_1, inputs: OPEN },
      { reread: CLOSED },
    );

    expect(run.decideAgain).toBe(true);
  });
});
