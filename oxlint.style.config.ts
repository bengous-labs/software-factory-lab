import { defineConfig } from "oxlint";

// The mods take their types from Claude Code: `bun run lint` lints them with `local/layers` alone.
export const IGNORE_PATTERNS = ["scripts/vendor/anti-slop/**", ".claude/plugins/**"];

export default defineConfig({
  // The edit hook runs this config alone with --fix: only the rules below may rewrite code.
  categories: {
    correctness: "off",
    suspicious: "off",
    pedantic: "off",
    perf: "off",
    style: "off",
    restriction: "off",
    nursery: "off",
  },
  plugins: ["typescript", "unicorn", "import"],
  // oxlint refuses a relative jsPlugins specifier in a config reached through extends.
  jsPlugins: [{ name: "anti-slop", specifier: `${import.meta.dirname}/scripts/vendor/anti-slop/index.ts` }],
  // No sort-imports or import/no-duplicates: bun fmt's sortImports rewrites both.
  rules: {
    "eslint/curly": "error",
    "eslint/object-shorthand": "error",
    "eslint/prefer-template": "error",
    "eslint/no-else-return": "error",
    "import/consistent-type-specifier-style": "error",
    "typescript/consistent-indexed-object-style": "error",
    "anti-slop/require-readable-spacing": "error",
    "typescript/array-type": ["error", { default: "array-simple" }],
    "unicorn/switch-case-braces": "error",
    "unicorn/prefer-string-raw": "error",
    "eslint/one-var": ["error", "never"],
    "eslint/no-negated-condition": "error",
    "eslint/arrow-body-style": "error",
    "unicorn/numeric-separators-style": "error",
    "unicorn/text-encoding-identifier-case": "error",
    "eslint/no-plusplus": "error",
    "typescript/no-inferrable-types": "error",
    "eslint/yoda": "error",
    "eslint/prefer-arrow-callback": "error",
    "eslint/no-useless-computed-key": "error",
    "eslint/prefer-exponentiation-operator": "error",
    "eslint/prefer-numeric-literals": "error",
    "import/newline-after-import": "error",
    "typescript/consistent-type-assertions": "error",
    "typescript/consistent-generic-constructors": "error",
    "typescript/prefer-function-type": "error",
    "typescript/ban-tslint-comment": "error",
    "unicorn/no-zero-fractions": "error",
    "unicorn/prefer-optional-catch-binding": "error",
    "unicorn/throw-new-error": "error",
    "unicorn/prefer-negative-index": "error",
    "unicorn/empty-brace-spaces": "error",
    "unicorn/no-console-spaces": "error",
    "unicorn/prefer-string-trim-start-end": "error",
    "unicorn/consistent-template-literal-escape": "error",
  },
  ignorePatterns: IGNORE_PATTERNS,
});
