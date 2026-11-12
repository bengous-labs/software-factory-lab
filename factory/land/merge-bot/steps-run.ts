/**
 * How the steps of a decision run over the state comment: each step in order, the comment written when
 * what it shows changed, and whether to decide again.
 */

import type { LedgerFinding } from "../shared/finding.ts";
import { stateWriteOf } from "./ledger.ts";
import type { LedgerInputs, StateRead } from "./ledger.ts";
import type { StateRecord } from "./record.ts";
import type { Step } from "./steps.ts";

/** What the steps of a decision do beside the state comment, which `stepsDone` keeps. */
export interface StepsIo {
  /** Performs `step` on `record`; `write` writes a record the step changes. Null stops the run. */
  readonly perform: (
    step: Step,
    record: StateRecord,
    write: (next: StateRecord) => Promise<void>,
  ) => Promise<StateRecord | null>;
  /** The App's findings, read again. */
  readonly findings: () => Promise<readonly LedgerFinding[]>;
  /** Writes `body` over comment `id`, or as a new one when null; returns its id. */
  readonly write: (id: number | null, body: string) => Promise<number>;
}

/**
 * Performs the steps of a decision over the state comment `read`, which holds the record the decision
 * starts from, `record`, and the ledger from `inputs`; answers whether to decide again, never after a
 * step that stopped the run. The comment is written when what it shows changed, and the comment as last
 * written is kept, so no step reads it again. A step that resolves threads has the findings read again,
 * and the comment is written last with the final record: the ledger shows those threads closed even
 * when no decision follows, as when the Owner's Land approval closes the open Importants and the PR lands.
 */
export async function stepsDone(
  steps: readonly Step[],
  start: { readonly read: StateRead; readonly record: StateRecord; readonly inputs: LedgerInputs },
  io: StepsIo,
): Promise<boolean> {
  let { read, inputs } = start;

  const save = async (record: StateRecord): Promise<void> => {
    const body = stateWriteOf(read, record, inputs);

    if (body !== null) {
      read = { id: await io.write(read.id, body), body, record };
    }
  };

  let current: StateRecord | null = start.record;
  let decideAgain = false;

  await save(current);

  for (const step of steps) {
    current = await io.perform(step, current, save);

    if (current === null) {
      return false;
    }

    if (step.kind === "resolve-threads" || step.kind === "land-open") {
      inputs = { ...inputs, findings: await io.findings() };
    }

    decideAgain ||= step.kind === "route" || step.kind === "post-review";
  }

  await save(current);

  return decideAgain;
}
