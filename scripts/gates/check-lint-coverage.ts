#!/usr/bin/env bun

/**
 * Refuses a source file git tracks that an ignore rule covers. oxlint skips such a file, tracked or not,
 * so `local/layers` never reads it, while the typecheck and the tests still run it. Reads the repository
 * of the current directory, with git's standard ignore rules (the `.gitignore` files, `.git/info/exclude`
 * and the user's global excludes file) and the `.eslintignore` oxlint reads by default. The
 * `ignorePatterns` of the lint config are no hidden rule: each is a line of that config.
 */

import { existsSync } from "node:fs";

import { $ } from "bun";

/** The files oxlint lints, which Bun runs: TypeScript and JavaScript. */
const SOURCES = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

const ESLINT_IGNORE = ".eslintignore";

if (import.meta.main) {
  const eslintIgnore = existsSync(ESLINT_IGNORE) ? [`--exclude-from=${ESLINT_IGNORE}`] : [];

  const ignored = (await $`git ls-files -z --cached --ignored --exclude-standard ${eslintIgnore} -- ${SOURCES}`.text())
    .split("\0")
    .filter((path) => path !== "");

  if (ignored.length > 0) {
    console.error(`${ignored.length} tracked source file(s) an ignore rule hides from the lint:\n`);

    for (const path of ignored) {
      console.error(`  ${path}`);
    }

    console.error("\nNarrow the ignore rule that covers each, or stop tracking the file.");
    process.exit(1);
  }
}
