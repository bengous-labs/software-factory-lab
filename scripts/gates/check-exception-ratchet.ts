#!/usr/bin/env bun

/**
 * Holds the budget exceptions of `scripts/lint/exceptions.ts` to what breaks the budgets: lints each
 * listed file with the budget rules alone, and fails when a listed function no longer breaks its rule,
 * when its measure moved off the one recorded, or when a function the list does not name breaks a rule
 * its file is excepted from.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../../factory/lib/json.ts";
import { EXCEPTIONS } from "../lint/exceptions.ts";
import type { BudgetRule, Exception } from "../lint/exceptions.ts";

const ROOT = join(import.meta.dir, "..", "..");

export const OXLINT = join(ROOT, "node_modules", ".bin", "oxlint");

const RATCHET_CONFIG = join(ROOT, "scripts", "lint", "exception-ratchet.oxlint.config.ts");

/** One function over a budget. `name` is null when the rule's message names no function. */
export interface Breach {
  readonly file: string;
  readonly line: number;
  readonly rule: BudgetRule;
  readonly name: string | null;
  readonly value: number;
}

const OxlintReport = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      code: Schema.optionalKey(Schema.String),
      message: Schema.String,
      filename: Schema.String,
      labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Number }) })),
    }),
  ),
});

/**
 * Every message each rule prints. `max-params` names a function declaration or a named function
 * expression, and says only `Function` or `Arrow function` for any other; the complexity plugin always
 * names one, in angle brackets when it has no name.
 */
const MESSAGES = new Map<string, readonly [BudgetRule, RegExp]>([
  [
    "eslint(max-params)",
    [
      "eslint/max-params",
      /^(?:Function '(?<name>[^']+)'|Function|Arrow function) has too many parameters \((?<value>\d+)\)/u,
    ],
  ],
  [
    "complexity(complexity)",
    ["complexity/complexity", /^Function '(?<name>[^']+)' has Cognitive Complexity of (?<value>\d+)\./u],
  ],
]);

/** The breaches of an oxlint JSON report; a diagnostic of another rule, or in a shape no rule prints, throws. */
export function breachesOf(report: string): Breach[] {
  return decodeJson(OxlintReport, "the oxlint report", report).diagnostics.map((diagnostic) => {
    const where = `${diagnostic.filename}:${diagnostic.labels[0]?.span.line ?? 0}`;
    const known = MESSAGES.get(diagnostic.code ?? "");
    const read = known?.[1].exec(diagnostic.message)?.groups;

    if (known === undefined || read?.value === undefined) {
      throw new Error(`${where}: oxlint reported what the ratchet cannot read: ${diagnostic.message}`);
    }

    return {
      file: diagnostic.filename,
      line: diagnostic.labels[0]?.span.line ?? 0,
      rule: known[0],
      name: read.name === undefined || read.name.startsWith("<") ? null : read.name,
      value: Number(read.value),
    };
  });
}

const keyOf = (file: string, rule: BudgetRule, name: string): string => `${file}\0${rule}\0${name}`;

function exceptionErrors(exception: Exception, found: readonly Breach[]): string[] {
  const { file, rule, name, measured } = exception;
  const [breach] = found;

  if (breach === undefined) {
    return [`${file}: \`${name}\` no longer breaks ${rule}; remove its entry from scripts/lint/exceptions.ts.`];
  }

  if (breach.value > measured) {
    return [
      `${file}:${breach.line}: \`${name}\` measures ${breach.value} on ${rule}, over the ${measured} its exception records. Bring it back to ${measured} or below; the exception never grows.`,
    ];
  }

  if (breach.value < measured) {
    return [
      `${file}:${breach.line}: \`${name}\` measures ${breach.value} on ${rule}, under the ${measured} its exception records; lower \`measured\` to ${breach.value} in scripts/lint/exceptions.ts.`,
    ];
  }

  return [];
}

function hiddenError(breach: Breach): string {
  const what = breach.name === null ? "a function the rule cannot name" : `\`${breach.name}\``;

  return `${breach.file}:${breach.line}: ${what} breaks ${breach.rule}, which the file's exception hides from the lint. Fix the function; the list of exceptions only shrinks.`;
}

/**
 * What breaks the ratchet: a listed function that no longer breaks its rule or whose measure moved, and
 * a breach the list hides. A function the rule cannot name never matches an entry, and two functions of
 * one name in one file match none.
 */
export function ratchetErrors(exceptions: readonly Exception[], breaches: readonly Breach[]): string[] {
  const named = Map.groupBy(
    breaches.flatMap((breach) => (breach.name === null ? [] : [breach])),
    (breach) => keyOf(breach.file, breach.rule, breach.name ?? ""),
  );

  const listed = new Set(exceptions.map((exception) => keyOf(exception.file, exception.rule, exception.name)));
  const excepted = new Set(exceptions.map((exception) => `${exception.file}\0${exception.rule}`));

  const unique = (breach: Breach): boolean =>
    breach.name !== null &&
    listed.has(keyOf(breach.file, breach.rule, breach.name)) &&
    named.get(keyOf(breach.file, breach.rule, breach.name))?.length === 1;

  return [
    ...exceptions.flatMap((exception) =>
      exceptionErrors(exception, named.get(keyOf(exception.file, exception.rule, exception.name)) ?? []),
    ),
    ...breaches.flatMap((breach) =>
      excepted.has(`${breach.file}\0${breach.rule}`) && !unique(breach) ? [hiddenError(breach)] : [],
    ),
  ];
}

/** The budget breaches of `files`, relative to `root`; a file that does not exist throws. */
export async function lintBudgets(root: string, files: readonly string[]): Promise<Breach[]> {
  if (files.length === 0) {
    return [];
  }

  const missing = files.filter((file) => !existsSync(join(root, file)));

  if (missing.length > 0) {
    throw new Error(`scripts/lint/exceptions.ts lists files that do not exist: ${missing.join(", ")}`);
  }

  const ran = await $`${OXLINT} -c ${RATCHET_CONFIG} --format=json ${[...files]}`.cwd(root).nothrow().quiet();

  // oxlint exits 1 when it reports; any other failure prints no report to read.
  if (ran.exitCode > 1) {
    throw new Error(`oxlint exited ${ran.exitCode}: ${ran.stderr.toString().trim()}`);
  }

  return breachesOf(ran.stdout.toString());
}

if (import.meta.main) {
  const files = [...new Set(EXCEPTIONS.map((exception) => exception.file))];
  const errors = ratchetErrors(EXCEPTIONS, await lintBudgets(ROOT, files));

  if (errors.length > 0) {
    console.error(`${errors.length} budget exception(s) out of step with the code:\n`);

    for (const error of errors) {
      console.error(`  ${error}`);
    }

    process.exit(1);
  }
}
