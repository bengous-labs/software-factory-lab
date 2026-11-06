#!/usr/bin/env bun

/**
 * Refuses a lint suppression that does not say why on the same line, in oxlint's own form: the rule
 * list, then ` -- `, then the reason.
 *
 *   // oxlint-disable-next-line some-rule -- the reason this one is unavoidable
 *
 * Reads every file of the working tree under the current directory: the tracked ones, and the
 * untracked ones no ignore rule covers.
 */

import { $ } from "bun";

const EXCLUDED_PREFIXES = ["node_modules/", "scripts/vendor/anti-slop/"];

const CHECKED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

// oxlint honours the eslint- spelling too, so both are gated.
const DIRECTIVE = /\b(?:ox|es)lint-disable(?:-next-line|-line)?\b/u;

// The reason counts only after the directive: a ` -- ` before it is code, such as a decrement.
const JUSTIFIED = /\b(?:ox|es)lint-disable(?:-next-line|-line)?\b.*\s--\s+\S/u;

export interface Offence {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export function findOffences(path: string, contents: string): Offence[] {
  return contents
    .split("\n")
    .flatMap((text, index) =>
      DIRECTIVE.test(text) && !JUSTIFIED.test(text) ? [{ path, line: index + 1, text: text.trim() }] : [],
    );
}

export function isCandidate(path: string): boolean {
  return (
    !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    CHECKED_EXTENSIONS.some((extension) => path.endsWith(extension))
  );
}

async function workingTreeFiles(): Promise<string[]> {
  const listed = await $`git ls-files -z --cached --others --exclude-standard`.text();

  return listed.split("\0").filter((path) => path !== "");
}

if (import.meta.main) {
  const candidates = (await workingTreeFiles()).filter((path) => isCandidate(path));

  const offences = (
    await Promise.all(
      candidates.map(async (path) => {
        const file = Bun.file(path);

        // A file deleted from the working tree but not from the index is still listed.
        return (await file.exists()) ? findOffences(path, await file.text()) : [];
      }),
    )
  ).flat();

  if (offences.length > 0) {
    console.error(`${offences.length} lint suppression(s) without a reason:\n`);

    for (const offence of offences) {
      console.error(`  ${offence.path}:${offence.line}: ${offence.text}`);
    }

    console.error("\nAdd ` -- <why this one is unavoidable>` on the same line.");
    process.exit(1);
  }
}
