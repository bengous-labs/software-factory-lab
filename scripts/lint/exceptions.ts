/**
 * The budget rules, and the functions that break them. `oxlint.config.ts` turns a rule off in each
 * listed file; `scripts/gates/check-exception-ratchet.ts` fails when a listed function no longer breaks
 * its rule, when its measure differs from `measured`, and when a function of a listed file that is not
 * listed breaks it. `name` is the name the rule's message gives the function, so only a function the
 * message names can be listed. An entry leaves the list when its function is fixed; none is added.
 */

import type { DummyRuleMap } from "oxlint";

export const BUDGETS = {
  "complexity/complexity": ["error", { cognitive: 25, cyclomatic: 999 }],
  "eslint/max-params": ["error", { max: 4 }],
} satisfies DummyRuleMap;

export type BudgetRule = keyof typeof BUDGETS;

/**
 * The budget of a file: an agent reads a file whole, so a file that grows past it is cut where its rules
 * part. No exception lists a file: every line counts, comments and blank lines included.
 */
export const FILE_BUDGETS = {
  "eslint/max-lines": ["error", { max: 800 }],
} satisfies DummyRuleMap;

export interface Exception {
  readonly file: string;
  readonly rule: BudgetRule;
  readonly name: string;
  /** The parameter count or the cognitive complexity the rule reports for the function. */
  readonly measured: number;
}

const MERGE_BOT_MAIN = "factory/land/merge-bot/main.live.ts";

export const EXCEPTIONS: readonly Exception[] = [
  { file: "factory/land/routing/routing-judge.ts", rule: "eslint/max-params", name: "routingJudge", measured: 5 },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "snapshotOf", measured: 5 },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "perform", measured: 7 },
];
