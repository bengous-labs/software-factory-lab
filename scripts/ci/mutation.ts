/**
 * Mutation testing on what a change alters in the modules `stryker.config.ts` lists, or in the test
 * files `TESTS` gives each: Stryker mutates each such module whole, in a pass of its own against those
 * test files alone. A survivor whose lines meet a changed line of the module fails. When one of its test
 * files changed, a second pass runs the module and its tests as they were at the base, and a mutant they
 * killed that survives now fails too: the tests were weakened. Each failure is named with its file,
 * line, mutator and replacement. A whole module, since Stryker keeps a mutant only when its whole node
 * lies inside a line range: a block or a condition that spans past a changed line would go untested.
 *
 *   bun scripts/ci/mutation.ts run             Stryker on each module the change reaches; a failure exits 1
 *   bun scripts/ci/mutation.ts github-output   `mutate=true` when the change reaches a listed module
 *
 * The change is the working tree against its merge-base with the base: `--base <ref>`, else on a pull
 * request's run the first parent of the merge commit it checks out, on a push the commit the push
 * moved the branch from (`PUSH_BEFORE`), else `origin/dev`. Stryker is imported only once the change
 * reaches a listed module, and nothing else outside `node:` and `bun` is imported, so CI installs the
 * dependencies only then.
 */

import { appendFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Stryker } from "@stryker-mutator/core";
import { $ } from "bun";

import config, { TESTS } from "../../stryker.config.ts";
import { fixtureEnv } from "../gates/fixture-env.ts";

export interface LineRange {
  readonly file: string;
  readonly start: number;
  readonly end: number;
}

/** A hunk of `git diff -U0`: `@@ -oldStart,oldCount +newStart,newCount @@` in `file`. */
export interface Hunk {
  readonly file: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface Change {
  readonly since: string;
  readonly hunks: readonly Hunk[];
  /** Each listed module or test the change moved, by its path now, to its path at `since`. */
  readonly renamedFrom: ReadonlyMap<string, string>;
}

type MutantResult = Awaited<ReturnType<Stryker["runMutationTest"]>>[number];

export type Mutant = Pick<MutantResult, "fileName" | "location" | "mutatorName" | "replacement" | "status">;

export type Env = Readonly<Partial<Record<string, string>>>;

const COMMANDS = ["run", "github-output"] as const;

type Command = (typeof COMMANDS)[number];

const UNDETECTED = new Set(["Survived", "NoCoverage"]);

const DETECTED = new Set(["Killed", "Timeout"]);

export const DEFAULT_BASE = "origin/dev";

/**
 * A pull request's run checks out the merge of its head into the base's tip, its first parent. The
 * event's `pull_request.base.sha` can be older, and would count the commits landed since as its own.
 */
const PULL_REQUEST_BASE = "HEAD^1";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Git on the repository at `cwd`, never on one an inherited `GIT_DIR` names. */
function git(cwd: string, args: readonly string[]) {
  return $`git ${args}`.cwd(cwd).env(fixtureEnv(process.env)).quiet().nothrow();
}

async function gitRead(cwd: string, args: readonly string[]): Promise<string> {
  const ran = await git(cwd, args);

  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${ran.exitCode}: ${ran.stderr.toString().trim()}`);
  }

  return ran.stdout.toString();
}

/**
 * The hunks of a `git diff -U0` whose new side is prefixed `b/`. A file's header runs from its
 * `diff --git` line to its first hunk: past it, `+++ b/…` is an added line. A deleted file's new
 * side is `/dev/null`: its hunks are dropped.
 */
export function hunksOf(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file: string | null = null;
  let inHeader = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
    }

    if (inHeader && line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
    }

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);

    if (header === null) {
      continue;
    }

    inHeader = false;

    if (file === null) {
      continue;
    }

    hunks.push({
      file,
      oldStart: Number(header[1]),
      oldCount: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newCount: header[4] === undefined ? 1 : Number(header[4]),
    });
  }

  return hunks;
}

/** The lines a hunk changes: those it adds or rewrites, or for a deletion the two around its cut. */
export function rangeOf(hunk: Hunk): LineRange {
  return hunk.newCount === 0
    ? { file: hunk.file, start: Math.max(hunk.newStart, 1), end: hunk.newStart + 1 }
    : { file: hunk.file, start: hunk.newStart, end: hunk.newStart + hunk.newCount - 1 };
}

export function changedRanges(diff: string): LineRange[] {
  return hunksOf(diff).map((hunk) => rangeOf(hunk));
}

/** Where a line the change left alone sat at the base; `null` for a line the change wrote. */
export function baseLineOf(line: number, hunks: readonly Hunk[]): number | null {
  let shift = 0;

  for (const hunk of hunks) {
    const lastNew = hunk.newStart + hunk.newCount - 1;

    if (hunk.newCount > 0 && line >= hunk.newStart && line <= lastNew) {
      return null;
    }

    if ((hunk.newCount > 0 ? lastNew : hunk.newStart) < line) {
      shift += hunk.newCount - hunk.oldCount;
    }
  }

  return line - shift;
}

export function rangeLabel(range: LineRange): string {
  return `${range.file}:${range.start}-${range.end}`;
}

/** Each listed module, with the test files a pass runs against it. */
export type Tests = Readonly<Record<string, readonly string[]>>;

/** The test files a pass runs against a listed module. */
export function testFilesOf(module: string, tests: Tests = TESTS): readonly string[] {
  const testFiles = tests[module];

  if (testFiles === undefined || testFiles.length === 0) {
    throw new Error(`${module}: no test file in stryker.config.ts's TESTS`);
  }

  return testFiles;
}

/** The listed modules the hunks reach, through their own lines or one of their test files, each once. */
export function modulesOf(hunks: readonly Hunk[], tests: Tests = TESTS): string[] {
  const reached = hunks.flatMap((hunk) =>
    Object.entries(tests).flatMap(([module, testFiles]) =>
      module === hunk.file || testFiles.includes(hunk.file) ? [module] : [],
    ),
  );

  return [...new Set(reached)];
}

function oneLine(code: string): string {
  return code.replaceAll(/\s+/gu, " ").trim();
}

/** One line per survivor: where it is, its mutator, and the code it replaced with what. */
export function describeSurvivor(file: string, source: string, mutant: Mutant): string {
  const { start, end } = mutant.location;
  const lines = source.split("\n");

  const original =
    start.line === end.line
      ? (lines[start.line - 1] ?? "").slice(start.column - 1, end.column - 1)
      : `${(lines[start.line - 1] ?? "").slice(start.column - 1)}…`;

  return `${file}:${start.line}:${start.column} ${mutant.status} ${mutant.mutatorName}: ${oneLine(original)} => ${oneLine(mutant.replacement)}`;
}

function meets(mutant: Mutant, ranges: readonly LineRange[]): boolean {
  const { start, end } = mutant.location;

  return ranges.some((range) => start.line <= range.end && end.line >= range.start);
}

/** A mutant's identity at the base: its mutator, its replacement, and where it sat there. */
function baseKeyOf(mutant: Mutant, hunks: readonly Hunk[]): string | null {
  const { start, end } = mutant.location;
  const startLine = baseLineOf(start.line, hunks);
  const endLine = baseLineOf(end.line, hunks);

  if (startLine === null || endLine === null) {
    return null;
  }

  return `${mutant.mutatorName}|${mutant.replacement}|${startLine}:${start.column}-${endLine}:${end.column}`;
}

export interface ModuleVerdict {
  readonly failures: readonly string[];
  readonly summary: string;
}

export interface ModulePasses {
  readonly module: string;
  /** The module's source at the head, where `head`'s locations point. */
  readonly source: string;
  readonly head: readonly Mutant[];
  /** The pass over the module and its tests at the base, run when the tests changed. */
  readonly base: readonly Mutant[] | null;
  /** The module's own hunks. */
  readonly hunks: readonly Hunk[];
}

/** The mutants no test detected, in source order. */
export function undetected(results: readonly Mutant[]): Mutant[] {
  return results
    .filter((result) => UNDETECTED.has(result.status))
    .toSorted(
      (a, b) =>
        a.fileName.localeCompare(b.fileName) ||
        a.location.start.line - b.location.start.line ||
        a.location.start.column - b.location.start.column,
    );
}

/**
 * One module's verdict: each undetected mutant on a changed line, then each one the base's tests
 * killed, matched by the line it sat on there; the summary counts the others apart.
 */
export function moduleVerdict(passes: ModulePasses): ModuleVerdict {
  const { module, source, head, base, hunks } = passes;
  const tested = head.filter((result) => result.status !== "Ignored");
  const missed = undetected(head);
  const ranges = hunks.map((hunk) => rangeOf(hunk));
  const onChanged = missed.filter((mutant) => meets(mutant, ranges));

  const killedAtBase = new Set(
    (base ?? []).filter((mutant) => DETECTED.has(mutant.status)).map((mutant) => baseKeyOf(mutant, [])),
  );

  const weakened = missed.filter((mutant) => !onChanged.includes(mutant) && killedAtBase.has(baseKeyOf(mutant, hunks)));
  const elsewhere = missed.length - onChanged.length - weakened.length;
  const weakenedClause = base === null ? "" : `, ${weakened.length} killed at the base and undetected now`;

  return {
    failures: [
      ...onChanged.map((mutant) => describeSurvivor(module, source, mutant)),
      ...weakened.map((mutant) => `${describeSurvivor(module, source, mutant)} (killed at the base)`),
    ],
    summary: `mutation: ${module}: ${tested.length} mutant(s) tested, ${onChanged.length} undetected on the changed lines${weakenedClause}, ${elsewhere} elsewhere, outside this change`,
  };
}

/** An event fact the workflow passes as an environment variable; an empty value is unset. */
function eventFact(env: Env, name: string): string {
  const value = env[name] ?? "";

  if (value === "") {
    throw new Error(`${name} is unset on a ${env["GITHUB_EVENT_NAME"] ?? "workflow"} run`);
  }

  return value;
}

/** The ref a change is measured from: see the header of this file. */
export function baseOf(explicit: string | undefined, env: Env): string {
  if (explicit !== undefined) {
    return explicit;
  }

  const eventName = env["GITHUB_EVENT_NAME"];

  if (eventName === "pull_request") {
    return PULL_REQUEST_BASE;
  }

  if (eventName === "push") {
    return eventFact(env, "PUSH_BEFORE");
  }

  return DEFAULT_BASE;
}

/** HEAD's merge-base with `ref`, the commit a change is measured from. */
async function mergeBaseWith(repoRoot: string, ref: string): Promise<string> {
  const found = await git(repoRoot, ["merge-base", "HEAD", ref]);
  const why = found.stderr.toString().trim();

  if (found.exitCode !== 0) {
    throw new Error(`no merge-base with ${ref}${why === "" ? "" : `: ${why}`}`);
  }

  return found.stdout.toString().trim();
}

/**
 * The `paths` the working tree holds as renames of a file at `sha`, each to its path there. Git
 * pairs a rename only when the diff reads both paths, so the whole tree is read.
 */
async function renamesSince(repoRoot: string, sha: string, paths: readonly string[]): Promise<Map<string, string>> {
  const status = await gitRead(repoRoot, ["diff", "--find-renames", "--diff-filter=R", "--name-status", "-z", sha]);
  const fields = status.split("\0");
  const renamedFrom = new Map<string, string>();

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const from = fields[index + 1] ?? "";
    const to = fields[index + 2] ?? "";

    if (paths.includes(to)) {
      renamedFrom.set(to, from);
    }
  }

  return renamedFrom;
}

/**
 * The hunks of the listed modules and their test files since the merge-base with the base. A file
 * moved since is diffed against its path there, so a move counts only the lines it changed.
 */
export async function changeSince(repoRoot: string, tests: Tests, base: string | undefined, env: Env): Promise<Change> {
  const since = await mergeBaseWith(repoRoot, baseOf(base, env));
  const paths = [...new Set(Object.entries(tests).flat(2))];
  const renamedFrom = await renamesSince(repoRoot, since, paths);

  const diff = await gitRead(repoRoot, [
    "diff",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    since,
    "--",
    ...paths,
    ...renamedFrom.values(),
  ]);

  return { since, hunks: hunksOf(diff), renamedFrom };
}

/** The tree at `sha`, written to a directory of its own, which the caller removes. */
export async function snapshotAt(repoRoot: string, sha: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mutation-base-"));
  await $`git archive --format=tar ${sha} | tar -x -C ${dir}`.cwd(repoRoot).env(fixtureEnv(process.env)).quiet();

  return dir;
}

/**
 * The seed `scripts/ci/fast-check-seed.ts` gives every property in a pass, the base's and the head's
 * alike: a mutant a random input killed at the base would otherwise read as weakened tests.
 */
export const FAST_CHECK_SEED = 20_261_106;

/** The `$GITHUB_OUTPUT` line that tells CI whether to install Stryker and run it. */
export function githubOutput(hunks: readonly Hunk[]): string {
  return `mutate=${hunks.length > 0}\n`;
}

/**
 * What a pass adds to `stryker.config.ts`: one module, whole, and its own tests alone. The command
 * runner reads only the exit code, so `--bail` stops at the first failing test: it kills the mutant.
 */
export function runOptions(module: string, tests: Tests = TESTS) {
  const testFiles = testFilesOf(module, tests).map((testFile) => `./${testFile}`);

  return {
    mutate: [module],
    commandRunner: { command: `FAST_CHECK_SEED=${FAST_CHECK_SEED} bun test --bail ${testFiles.join(" ")}` },
  };
}

export async function mutate(repoRoot: string, module: string, tests: Tests = TESTS): Promise<MutantResult[]> {
  const { Stryker: Runner } = await import("@stryker-mutator/core");
  // Stryker copies the working directory into its sandbox, and mutates the copy.
  process.chdir(repoRoot);

  return new Runner({ ...config, ...runOptions(module, tests) }).runMutationTest();
}

async function existsAt(repoRoot: string, sha: string, path: string): Promise<boolean> {
  return (await git(repoRoot, ["cat-file", "-e", `${sha}:${path}`])).exitCode === 0;
}

/** The pass over the module and its tests as they were at `sha`; `null` when it or one of them was missing. */
async function mutateAt(
  repoRoot: string,
  sha: string,
  module: string,
  testFiles: readonly string[],
): Promise<MutantResult[] | null> {
  const found = await Promise.all([module, ...testFiles].map((path) => existsAt(repoRoot, sha, path)));

  if (found.includes(false)) {
    return null;
  }

  const dir = await snapshotAt(repoRoot, sha);

  try {
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");

    return await mutate(dir, module, { [module]: testFiles });
  } finally {
    process.chdir(repoRoot);
    await rm(dir, { recursive: true, force: true });
  }
}

interface Args {
  readonly command: Command;
  readonly base: string | undefined;
}

export function parseArgs(args: readonly string[]): Args | null {
  const [given, flag, base, ...rest] = args;
  const command = COMMANDS.find((known) => known === given);

  if (command === undefined || rest.length > 0) {
    return null;
  }

  if (flag === undefined) {
    return { command, base: undefined };
  }

  return flag === "--base" && base !== undefined ? { command, base } : null;
}

/** What a module's verdict is drawn from: its source and hunks, and its passes, run in turn. */
export interface ModuleRun extends Omit<ModulePasses, "head" | "base"> {
  readonly head: () => Promise<readonly Mutant[]>;
  /** The pass at the base, `null` when the tests did not change; it answers `null` when it had nothing to run. */
  readonly base: (() => Promise<readonly Mutant[] | null>) | null;
}

/**
 * A module's verdict from its passes: the head's, then the base's. A head pass that throws throws; a base
 * pass that throws keeps the head's verdict and adds its own failure.
 */
export async function verdictOfPasses(run: ModuleRun): Promise<ModuleVerdict> {
  const { module, source, hunks } = run;
  const head = await run.head();
  let base: readonly Mutant[] | null;

  try {
    base = run.base === null ? null : await run.base();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);

    return withFailedBase(moduleVerdict({ module, source, head, base: null, hunks }), module, why);
  }

  return moduleVerdict({ module, source, head, base, hunks });
}

/** One module's passes, at the head and, when its tests changed, at the base, and its verdict. */
async function passesVerdict(change: Change, module: string): Promise<ModuleVerdict> {
  const testFiles = testFilesOf(module);

  const atBase = async (): Promise<MutantResult[] | null> => {
    const base = await mutateAt(
      REPO_ROOT,
      change.since,
      change.renamedFrom.get(module) ?? module,
      testFiles.map((testFile) => change.renamedFrom.get(testFile) ?? testFile),
    );

    if (base === null) {
      console.error(`mutation: ${module}: no base pass, it or its tests did not exist at ${change.since}`);
    }

    return base;
  };

  return verdictOfPasses({
    module,
    source: await Bun.file(join(REPO_ROOT, module)).text(),
    hunks: change.hunks.filter((hunk) => hunk.file === module),
    head: () => mutate(REPO_ROOT, module),
    base: change.hunks.some((hunk) => testFiles.includes(hunk.file)) ? atBase : null,
  });
}

/**
 * `verdict`, the head's, with the failure of a base pass that threw `why`: the head's failures stand, and
 * no mutant the base's tests killed was checked.
 */
export function withFailedBase(verdict: ModuleVerdict, module: string, why: string): ModuleVerdict {
  return {
    failures: [
      ...verdict.failures,
      `${module}: its base pass failed, so no mutant the base's tests killed was checked: ${oneLine(why)}`,
    ],
    summary: `${verdict.summary}; its base pass failed`,
  };
}

/**
 * The verdict of a module whose head pass threw `why`, as Stryker's dry run does on a module that cannot
 * load: one failure, naming it.
 */
export function failedPassVerdict(module: string, why: string): ModuleVerdict {
  return {
    failures: [`${module}: not mutated, its pass failed: ${oneLine(why)}`],
    summary: `mutation: ${module}: not mutated, its pass failed`,
  };
}

/**
 * Takes each module's verdict in turn and prints it as it comes; the number of failures. A module whose
 * pass throws fails alone: the modules after it still run.
 */
export async function runPasses(
  modules: readonly string[],
  verdictOf: (module: string) => Promise<ModuleVerdict>,
  print: (line: string) => void,
): Promise<number> {
  let failed = 0;

  for (const module of modules) {
    let verdict: ModuleVerdict;

    try {
      verdict = await verdictOf(module);
    } catch (error) {
      verdict = failedPassVerdict(module, error instanceof Error ? error.message : String(error));
    }

    for (const line of [...verdict.failures, verdict.summary]) {
      print(line);
    }

    failed += verdict.failures.length;
  }

  return failed;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));

  if (args === null) {
    console.error(`usage: bun scripts/ci/mutation.ts <${COMMANDS.join("|")}> [--base <ref>]`);
    process.exit(2);
  }

  const change = await changeSince(REPO_ROOT, TESTS, args.base, process.env);

  if (args.command === "github-output") {
    const outputPath = process.env["GITHUB_OUTPUT"];

    if (outputPath === undefined) {
      throw new Error("GITHUB_OUTPUT is unset");
    }

    await appendFile(outputPath, githubOutput(change.hunks));
    process.exit(0);
  }

  if (change.hunks.length === 0) {
    console.error(`mutation: no change in ${config.mutate.join(", ")} or their tests`);
    process.exit(0);
  }

  console.error(`mutation: changed ${change.hunks.map((hunk) => rangeLabel(rangeOf(hunk))).join(", ")}`);

  const failed = await runPasses(
    modulesOf(change.hunks),
    (module) => passesVerdict(change, module),
    (line) => {
      console.error(line);
    },
  );

  process.exit(failed === 0 ? 0 : 1);
}
