#!/usr/bin/env bun

/**
 * Refuses a source file git tracks that an ignore rule covers. oxlint skips such a file, tracked or not,
 * so `local/layers` never reads it, while the typecheck and the tests still run it. Reads the repository
 * of the current directory, with git's standard ignore rules (the `.gitignore` files, `.git/info/exclude`
 * and the user's global excludes file), the `.eslintignore` oxlint reads by default, and the
 * `ignorePatterns` of the main lint config but for the patterns `LEFT_OUT` names. The layers config, which
 * lints the mods, takes no `ignorePatterns`: oxlint resolves them from `scripts/lint/`, where git's
 * `--exclude` cannot follow them.
 */

import { existsSync } from "node:fs";

import { $ } from "bun";
import type { OxlintConfig } from "oxlint";

import main from "../../oxlint.config.ts";
import layers from "../lint/layers.oxlint.config.ts";

/** The files oxlint lints, which Bun runs: TypeScript and JavaScript. */
const SOURCES = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];

const ESLINT_IGNORE = ".eslintignore";

const mainConfig: OxlintConfig = main;

const layersConfig: OxlintConfig = layers;

/**
 * The patterns of the main config that leave files out on purpose: the vendored rules, pinned by their
 * checksum, and the mods, which `bun run lint` lints with the layers config alone.
 */
const LEFT_OUT = new Set(["scripts/vendor/anti-slop/**", ".claude/plugins/**"]);

/** The tracked sources the ignore rules `excludes` names cover. */
async function ignoredBy(excludes: readonly string[]): Promise<string[]> {
  return (await $`git ls-files -z --cached --ignored ${excludes} -- ${SOURCES}`.text())
    .split("\0")
    .filter((path) => path !== "");
}

if (import.meta.main) {
  // oxlint reads its ignorePatterns as .gitignore lines, and so does git's --exclude.
  const configured = (mainConfig.ignorePatterns ?? [])
    .filter((pattern) => !LEFT_OUT.has(pattern))
    .map((pattern) => `--exclude=${pattern}`);

  // Each source on its own: git ranks a command-line exclude file over `.gitignore`, so one `!` line of
  // `.eslintignore` would hide a `.gitignore` rule that oxlint still applies.
  const sources = [
    ["--exclude-standard"],
    ...(existsSync(ESLINT_IGNORE) ? [[`--exclude-from=${ESLINT_IGNORE}`]] : []),
    ...(configured.length > 0 ? [configured] : []),
  ];

  const ignored = [...new Set((await Promise.all(sources.map((excludes) => ignoredBy(excludes)))).flat())].toSorted();

  const layersPatterns = layersConfig.ignorePatterns ?? [];

  if (layersPatterns.length > 0) {
    console.error(`scripts/lint/layers.oxlint.config.ts ignores ${layersPatterns.join(", ")}: it lints every mod.`);
    process.exit(1);
  }

  if (ignored.length > 0) {
    console.error(`${ignored.length} tracked source file(s) an ignore rule hides from the lint:\n`);

    for (const path of ignored) {
      console.error(`  ${path}`);
    }

    console.error("\nNarrow the ignore rule that covers each, or stop tracking the file.");
    process.exit(1);
  }
}
