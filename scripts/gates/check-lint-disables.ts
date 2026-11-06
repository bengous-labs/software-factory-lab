#!/usr/bin/env bun

/**
 * Refuses a lint suppression that does not say why on the same line, in oxlint's own form: the rule
 * list, then ` -- `, then the reason.
 *
 *   // oxlint-disable-next-line some-rule -- the reason this one is unavoidable
 *
 * A suppression of a rule in `UNSUPPRESSIBLE`, or of every rule, is refused whatever its reason.
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

// The layer map belongs to the Owner: a layer violation is fixed in the import, never silenced.
const UNSUPPRESSIBLE = ["local/layers"];

// A directive that names no rule suppresses every rule, the unsuppressible ones included.
const EVERY_RULE = /\b(?:ox|es)lint-disable(?:-next-line|-line)?\s*(?:--|\*\/|$)/u;

export interface Offence {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function offencesWhere(path: string, contents: string, refused: (text: string) => boolean): Offence[] {
  return contents
    .split("\n")
    .flatMap((text, index) =>
      DIRECTIVE.test(text) && refused(text) ? [{ path, line: index + 1, text: text.trim() }] : [],
    );
}

export function findOffences(path: string, contents: string): Offence[] {
  return offencesWhere(path, contents, (text) => !JUSTIFIED.test(text));
}

export function findUnsuppressible(path: string, contents: string): Offence[] {
  return offencesWhere(
    path,
    contents,
    (text) => EVERY_RULE.test(text) || UNSUPPRESSIBLE.some((rule) => text.includes(rule)),
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

  const contents = (
    await Promise.all(
      candidates.map(async (path) => {
        const file = Bun.file(path);

        // A file deleted from the working tree but not from the index is still listed.
        return (await file.exists()) ? [{ path, text: await file.text() }] : [];
      }),
    )
  ).flat();

  const offences = contents.flatMap(({ path, text }) => findOffences(path, text));
  const unsuppressible = contents.flatMap(({ path, text }) => findUnsuppressible(path, text));

  if (offences.length > 0) {
    console.error(`${offences.length} lint suppression(s) without a reason:\n`);

    for (const offence of offences) {
      console.error(`  ${offence.path}:${offence.line}: ${offence.text}`);
    }

    console.error("\nAdd ` -- <why this one is unavoidable>` on the same line.");
  }

  if (unsuppressible.length > 0) {
    console.error(
      `${unsuppressible.length} suppression(s) of ${UNSUPPRESSIBLE.join(", ")} or of every rule, which no reason allows:\n`,
    );

    for (const offence of unsuppressible) {
      console.error(`  ${offence.path}:${offence.line}: ${offence.text}`);
    }

    console.error("\nRemove the suppression and fix the code.");
  }

  if (offences.length > 0 || unsuppressible.length > 0) {
    process.exit(1);
  }
}
