#!/usr/bin/env bun

/**
 * Refuses a TypeScript file git tracks that the typecheck does not cover.
 *
 * `tsconfig.json`'s `**` skips dot directories, so a file under `.claude/` is left out unless `include`
 * names it. `tsgo --showConfig` prints the files `include` and `exclude` select from directory listings
 * alone; `--listFilesOnly` would load every source and type. Reads the `tsconfig.json` of the current
 * directory.
 */

import { join } from "node:path";

import { $ } from "bun";

/** What `tsconfig.json` leaves out on purpose; anything else tracked must be type-checked. */
const LEFT_OUT = /^scripts\/vendor\/anti-slop\//u;

const TSGO = join(import.meta.dir, "..", "..", "node_modules", ".bin", "tsgo");

/** The tracked paths that are none of the typechecked files, both relative to `root`. */
export function uncovered(root: string, tracked: readonly string[], typechecked: readonly string[]): string[] {
  const covered = new Set(typechecked.map((path) => join(root, path)));

  return tracked.filter((path) => !LEFT_OUT.test(path) && !covered.has(join(root, path)));
}

/** The `files` of `tsgo --showConfig`'s JSON. */
export function filesOf(shown: unknown): string[] {
  if (typeof shown !== "object" || shown === null || !("files" in shown) || !Array.isArray(shown.files)) {
    throw new Error("tsgo --showConfig printed no files list");
  }

  return shown.files.filter((file: unknown) => typeof file === "string");
}

if (import.meta.main) {
  const root = process.cwd();

  const tracked = (await $`git ls-files -z -- ${["*.ts", "*.tsx", "*.mts", "*.cts"]}`.text())
    .split("\0")
    .filter((path) => path !== "");

  const shown: unknown = await $`${TSGO} --showConfig`.json();
  const missing = uncovered(root, tracked, filesOf(shown));

  if (missing.length > 0) {
    console.error(`${missing.length} tracked TypeScript file(s) outside the typecheck:\n`);

    for (const path of missing) {
      console.error(`  ${path}`);
    }

    console.error("\nName their directory in tsconfig.json's `include`.");
    process.exit(1);
  }
}
