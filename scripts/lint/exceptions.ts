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

export interface Exception {
  readonly file: string;
  readonly rule: BudgetRule;
  readonly name: string;
  /** The parameter count or the cognitive complexity the rule reports for the function. */
  readonly measured: number;
}

const MERGE_BOT_MAIN = "scripts/land-loop/merge-bot/main.ts";

export const EXCEPTIONS: readonly Exception[] = [
  { file: "scripts/land-loop/merge-bot/decide.ts", rule: "complexity/complexity", name: "decide", measured: 34 },
  { file: "scripts/land-loop/routing/routing-judge.ts", rule: "eslint/max-params", name: "routingJudge", measured: 5 },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "snapshotOf", measured: 5 },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "perform", measured: 7 },
];
