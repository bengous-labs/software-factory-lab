#!/usr/bin/env bun

/**
 * Refuses a source file git tracks that an ignore rule covers. oxlint skips such a file, tracked or not,
 * so `local/layers` never reads it, while the typecheck and the tests still run it. Reads the repository
 * of the current directory, with git's standard ignore rules (the `.gitignore` files, `.git/info/exclude`
 * and the user's global excludes file), the `.eslintignore` oxlint reads by default, and the
 * `IGNORE_PATTERNS` of the lint config but for what `LEFT_OUT` names.
 */

import { existsSync } from "node:fs";

import { $ } from "bun";

import { IGNORE_PATTERNS } from "../../oxlint.style.config.ts";

/** The files oxlint lints, which Bun runs: TypeScript and JavaScript. */
const SOURCES = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

const ESLINT_IGNORE = ".eslintignore";

/**
 * What the lint config's patterns leave out on purpose: the vendored rules, pinned by their checksum, and
 * the mods, which `bun run lint` lints with `local/layers` alone.
 */
const LEFT_OUT = /^(?:scripts\/vendor\/anti-slop|\.claude\/plugins)\//u;

/** The tracked sources the ignore rules `excludes` names cover. */
async function ignoredBy(excludes: readonly string[]): Promise<string[]> {
  return (await $`git ls-files -z --cached --ignored ${excludes} -- ${SOURCES}`.text())
    .split("\0")
    .filter((path) => path !== "");
}

if (import.meta.main) {
  // Each source on its own: git ranks a command-line exclude file over `.gitignore`, so one `!` line of
  // `.eslintignore` would hide a `.gitignore` rule that oxlint still applies.
  const sources = [["--exclude-standard"], ...(existsSync(ESLINT_IGNORE) ? [[`--exclude-from=${ESLINT_IGNORE}`]] : [])];
  // oxlint reads its ignorePatterns as .gitignore lines, and so does git's --exclude.
  const configured = IGNORE_PATTERNS.map((pattern) => `--exclude=${pattern}`);

  const [hiddenByConfig, ...hiddenByFiles] = await Promise.all([
    configured.length > 0 ? ignoredBy(configured) : [],
    ...sources.map((excludes) => ignoredBy(excludes)),
  ]);

  const ignored = [
    ...new Set([...hiddenByConfig.filter((path) => !LEFT_OUT.test(path)), ...hiddenByFiles.flat()]),
  ].toSorted();

  if (ignored.length > 0) {
    console.error(`${ignored.length} tracked source file(s) an ignore rule hides from the lint:\n`);

    for (const path of ignored) {
      console.error(`  ${path}`);
    }

    console.error("\nNarrow the ignore rule that covers each, or stop tracking the file.");
    process.exit(1);
  }
}
