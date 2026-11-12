#!/usr/bin/env bun

/**
 * Refuses a TypeScript file git tracks that an ignore rule covers. oxlint skips such a file, tracked or
 * not, so `local/layers` never reads it, while the typecheck and the tests still run it. Reads the
 * repository of the current directory, with git's standard ignore rules: the `.gitignore` files,
 * `.git/info/exclude` and the user's global excludes file.
 */

import { $ } from "bun";

if (import.meta.main) {
  const ignored = (
    await $`git ls-files -z --cached --ignored --exclude-standard -- ${["*.ts", "*.tsx", "*.mts", "*.cts"]}`.text()
  )
    .split("\0")
    .filter((path) => path !== "");

  if (ignored.length > 0) {
    console.error(`${ignored.length} tracked TypeScript file(s) an ignore rule hides from the lint:\n`);

    for (const path of ignored) {
      console.error(`  ${path}`);
    }

    console.error("\nNarrow the ignore rule that covers each, or stop tracking the file.");
    process.exit(1);
  }
}
