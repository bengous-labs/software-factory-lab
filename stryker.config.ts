import { dirname } from "node:path";

import type { Stryker } from "@stryker-mutator/core";

type StrykerOptions = ConstructorParameters<typeof Stryker>[0];

/** A pure module of the factory: no test, no test fixture, nothing that calls outside (`x.live.ts`), no port, no door of a process. */
const NOT_MUTATED = /\.(?:test|fixtures|live|port)\.ts$|^factory\/(?:bin|hooks)\//u;

/** Whether `file` is a logic file of the factory: one the mutation job must reach. */
export const isFactoryLogic = (file: string): boolean =>
  file.startsWith("factory/") && file.endsWith(".ts") && !NOT_MUTATED.test(file);

/** A test of pure logic: one that runs no process and reads no file takes no time under Stryker's parallel runs. */
const PURE_TEST = /(?<!\.live)\.test\.ts$/u;

/**
 * The pure modules of the factory, each with the pure tests of its directory: no list to keep, a module
 * joins when a test sits beside it. A directory's modules share its tests, since a rule is tested through
 * the decision that calls it. Sorted, so the passes run in one order on every machine.
 */
function factoryModules(): Record<string, readonly string[]> {
  const files = [...new Bun.Glob("factory/**/*.ts").scanSync({ cwd: import.meta.dirname })].toSorted();

  return Object.fromEntries(
    files.flatMap((module) => {
      const tests = files.filter((file) => dirname(file) === dirname(module) && PURE_TEST.test(file));

      return isFactoryLogic(module) && tests.length > 0 ? [[module, tests] as const] : [];
    }),
  );
}

/**
 * The modules `scripts/ci/mutation.ts` mutates, each with the test files a pass runs against it: every
 * pure module of the factory whose directory holds a pure test, and the app's commands. A test that times
 * out under Stryker's parallel runs kills a mutant without checking anything: a module's tests kill by
 * assertion alone.
 */
export const TESTS = {
  ...factoryModules(),
  "app/src/commands/add.ts": ["app/test/commands.test.ts"],
  "app/src/commands/clear.ts": ["app/test/store.test.ts"],
  "app/src/commands/count.ts": ["app/test/commands.test.ts"],
  "app/src/commands/done.ts": ["app/test/commands.test.ts"],
  "app/src/commands/list.ts": ["app/test/commands.test.ts"],
  "app/src/commands/remove.ts": ["app/test/commands.test.ts"],
  "app/src/commands/rename.ts": ["app/test/rename.test.ts"],
  "app/src/commands/search.ts": ["app/test/search.test.ts"],
} satisfies Readonly<Record<string, readonly string[]>>;

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
