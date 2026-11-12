import type { Stryker } from "@stryker-mutator/core";

type StrykerOptions = ConstructorParameters<typeof Stryker>[0];

/**
 * The modules `scripts/ci/mutation.ts` mutates, each with the one test file a pass runs against it.
 * A module joins once a run of it kills by assertion alone: a test that times out under Stryker's
 * parallel runs kills a mutant without checking anything.
 */
export const TESTS = {
  "factory/land/merge-bot/decide.ts": "factory/land/merge-bot/decide.test.ts",
  "factory/land/stop/decide.ts": "factory/land/stop/decide.test.ts",
  "factory/land/routing/routing-rules.ts": "factory/land/routing/routing-rules.test.ts",
  "factory/land/shared/tool-guard.ts": "factory/land/shared/tool-guard.test.ts",
  "factory/land/review/post-plan.ts": "factory/land/review/post-plan.test.ts",
  "app/src/commands/add.ts": "app/test/commands.test.ts",
  "app/src/commands/clear.ts": "app/test/store.test.ts",
  "app/src/commands/count.ts": "app/test/commands.test.ts",
  "app/src/commands/done.ts": "app/test/commands.test.ts",
  "app/src/commands/list.ts": "app/test/commands.test.ts",
  "app/src/commands/remove.ts": "app/test/commands.test.ts",
  "app/src/commands/rename.ts": "app/test/rename.test.ts",
  "app/src/commands/search.ts": "app/test/search.test.ts",
} satisfies Readonly<Record<string, string>>;

/**
 * Read by `scripts/ci/mutation.ts`, which mutates each `mutate` module a change reaches, through its
 * lines or its tests, whole and against those tests alone, and fails on a survivor on a changed line
 * or one the base's tests killed.
 */
export default {
  mutate: Object.keys(TESTS),
  testRunner: "command",
  coverageAnalysis: "off",
  mutator: { excludedMutations: ["StringLiteral"] },
  reporters: ["clear-text"],
  clearTextReporter: { reportMutants: false, reportTests: false },
  // A missing file skips Stryker's tsconfig rewrite, the only code of Stryker that loads the
  // `typescript` package, which this repository does not install.
  tsconfigFile: "stryker-skips-the-tsconfig-rewrite.json",
  // The other checkouts of this repository live there; Stryker's sandbox copy needs none of them.
  ignorePatterns: ["/.claude/worktrees"],
} satisfies StrykerOptions;
