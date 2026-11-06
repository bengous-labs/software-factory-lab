#!/usr/bin/env bun

/**
 * Holds the budget exceptions of `scripts/lint/exceptions.ts` to what breaks the budgets: lints each
 * listed file with the budget rules alone, and fails when a listed function no longer breaks its rule,
 * or when a function the list does not name breaks a rule its file is excepted from.
 */

import { join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";
import { EXCEPTIONS } from "../lint/exceptions.ts";
import type { Exception } from "../lint/exceptions.ts";

const OXLINT = join(import.meta.dir, "..", "..", "node_modules", ".bin", "oxlint");

const RATCHET_CONFIG = join(import.meta.dir, "..", "lint", "exception-ratchet.oxlint.config.ts");

/** One budget a function breaks; `rule` in the config's spelling, `plugin/rule`. */
export interface Breach {
  readonly file: string;
  readonly rule: string;
  readonly name: string;
}

const OxlintReport = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String, filename: Schema.String })),
});

const CODE = /^([\w-]+)\(([\w-]+)\)$/u;

/** Both budget rules start their message with the function's name. */
const FUNCTION_NAME = /^Function '([^']+)'/u;

/** The breaches of an oxlint JSON report; a diagnostic that names no function is a breach of `<unknown>`. */
export function breachesOf(report: string): Breach[] {
  return decodeJson(OxlintReport, "the oxlint report", report).diagnostics.map((diagnostic) => {
    const code = CODE.exec(diagnostic.code);

    return {
      file: diagnostic.filename,
      rule: code === null ? diagnostic.code : `${code[1] ?? ""}/${code[2] ?? ""}`,
      name: FUNCTION_NAME.exec(diagnostic.message)?.[1] ?? "<unknown>",
    };
  });
}

const keyOf = (entry: Breach | Exception): string => `${entry.file}\0${entry.rule}\0${entry.name}`;

/** What breaks the ratchet: a listed function that no longer breaks its rule, and a breach the list hides. */
export function ratchetErrors(exceptions: readonly Exception[], breaches: readonly Breach[]): string[] {
  const breached = new Set(breaches.map((breach) => keyOf(breach)));
  const listed = new Set(exceptions.map((exception) => keyOf(exception)));
  const excepted = new Set(exceptions.map((exception) => `${exception.file}\0${exception.rule}`));

  const fixed = exceptions.flatMap((exception) =>
    breached.has(keyOf(exception))
      ? []
      : [
          `${exception.file}: \`${exception.name}\` no longer breaks ${exception.rule}; remove its entry from scripts/lint/exceptions.ts.`,
        ],
  );

  const hidden = breaches.flatMap((breach) =>
    excepted.has(`${breach.file}\0${breach.rule}`) && !listed.has(keyOf(breach))
      ? [
          `${breach.file}: \`${breach.name}\` breaks ${breach.rule}, which the file's exception hides from the lint. Fix the function; the list of exceptions only shrinks.`,
        ]
      : [],
  );

  return [...fixed, ...hidden];
}

/** The budget breaches of `files`, relative to `root`. */
export async function lintBudgets(root: string, files: readonly string[]): Promise<Breach[]> {
  const ran = await $`${OXLINT} -c ${RATCHET_CONFIG} --format=json ${[...files]}`.cwd(root).nothrow().quiet();

  // oxlint exits 1 when it reports; any other failure prints no report to read.
  if (ran.exitCode > 1) {
    throw new Error(`oxlint exited ${ran.exitCode}: ${ran.stderr.toString().trim()}`);
  }

  return breachesOf(ran.stdout.toString());
}

if (import.meta.main) {
  const files = [...new Set(EXCEPTIONS.map((exception) => exception.file))];
  const errors = ratchetErrors(EXCEPTIONS, await lintBudgets(process.cwd(), files));

  if (errors.length > 0) {
    console.error(`${errors.length} budget exception(s) out of step with the code:\n`);

    for (const error of errors) {
      console.error(`  ${error}`);
    }

    process.exit(1);
  }
}
