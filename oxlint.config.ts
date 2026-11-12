import { defineConfig } from "oxlint";

import styleConfig, { IGNORE_PATTERNS } from "./oxlint.style.config.ts";
import { BUDGETS, EXCEPTIONS, FILE_BUDGETS } from "./scripts/lint/exceptions.ts";

export default defineConfig({
  extends: [styleConfig],
  categories: { correctness: "error", suspicious: "error", pedantic: "error" },
  plugins: ["typescript", "unicorn", "oxc", "import"],
  options: { typeAware: true },
  jsPlugins: ["oxlint-plugin-complexity", { name: "local", specifier: `${import.meta.dirname}/scripts/lint/index.ts` }],
  rules: {
    "local/layers": "error",
    "local/judges": "error",

    ...BUDGETS,
    ...FILE_BUDGETS,
    // A file's length and a function's complexity are limited; these other sizes are not.
    "eslint/max-lines-per-function": "off",
    "eslint/max-depth": "off",
    "eslint/max-nested-callbacks": "off",
    "eslint/max-classes-per-file": "off",
    "import/max-dependencies": "off",
    "import/no-cycle": "error",

    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-type-assertion": "error",
    "typescript/strict-boolean-expressions": "error",
    "typescript/switch-exhaustiveness-check": "error",
    "typescript/no-unnecessary-condition": "error",
    "typescript/prefer-nullish-coalescing": "error",
    "typescript/only-throw-error": "error",
    "typescript/return-await": "error",
    "typescript/consistent-type-imports": "error",
    // It also flags parameters typed by libraries (AbortController, the Agent SDK's Options, ReadonlySet),
    // which no annotation here can make readonly.
    "typescript/prefer-readonly-parameter-types": "off",

    // A schema and the type it decodes share one name, which this rule reads as a redeclaration; the
    // typecheck already refuses a real one.
    "eslint/no-redeclare": "off",
    // eslint/require-await stays on: this one also flags an async generator that only yields, which a test
    // stream needs to be an AsyncIterable.
    "typescript/require-await": "off",
    // A duplicate of eslint/no-negated-condition, on in the style config.
    "unicorn/no-negated-condition": "off",
    // The awaits in loops here are sequential on purpose: polling, one decision after another, steps that
    // must run in order, and one PR at a time so two runs never write the same state record.
    "eslint/no-await-in-loop": "off",

    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-unknown-returns": "error",
  },
  // check-exception-ratchet.ts holds each of these files to the functions listed.
  overrides: EXCEPTIONS.map((exception) => ({ files: [exception.file], rules: { [exception.rule]: "off" } })),
  // extends does not carry ignorePatterns.
  ignorePatterns: IGNORE_PATTERNS,
});
