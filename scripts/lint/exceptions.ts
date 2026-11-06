/**
 * The budget rules, and the functions that break them today. `oxlint.config.ts` turns a rule off in
 * each listed file; `scripts/gates/check-exception-ratchet.ts` fails when a listed function no longer
 * breaks its rule, and when a function of a listed file that is not listed breaks it. An entry leaves
 * the list when its function is fixed; none is added.
 */

import type { DummyRuleMap } from "oxlint";

export const BUDGETS = {
  "complexity/complexity": ["error", { cognitive: 25, cyclomatic: 999 }],
  "eslint/max-params": ["error", { max: 4 }],
} satisfies DummyRuleMap;

type BudgetRule = keyof typeof BUDGETS;

export interface Exception {
  readonly file: string;
  readonly rule: BudgetRule;
  readonly name: string;
}

const MERGE_BOT_MAIN = "scripts/land-loop/merge-bot/main.ts";

export const EXCEPTIONS: readonly Exception[] = [
  { file: "scripts/land-loop/merge-bot/decide.ts", rule: "complexity/complexity", name: "decide" },
  { file: "scripts/land-loop/routing/routing-judge.ts", rule: "eslint/max-params", name: "routingJudge" },
  { file: "scripts/land-loop/review/code-review.ts", rule: "eslint/max-params", name: "codeReview" },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "snapshotOf" },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "postFindings" },
  { file: MERGE_BOT_MAIN, rule: "eslint/max-params", name: "perform" },
];
