#!/usr/bin/env bun

/**
 * Refuses a path the repository names that names no file, where nothing else fails on it. A rule under
 * `.claude/rules/` whose `paths` glob matches no file loads for no one. A module or a test file
 * `stryker.config.ts` lists that does not exist leaves the mutation job nothing to run, and it passes. A
 * script a hook of `.claude/settings.json`, a workflow or a skill names fails only once that hook or
 * workflow runs, from another checkout or after the landing. An `ownerPaths` or `deepReviewPaths` glob of
 * the factory config that matches no file sends nothing to the Owner or to a deep review.
 *
 * Reads the working tree under the current directory: the tracked files, and the untracked ones no
 * ignore rule covers.
 */

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../../factory/lib/json.ts";
import { TESTS } from "../../stryker.config.ts";

const RULES = ".claude/rules/";

const FACTORY_CONFIG = ".github/software-factory.json";

/** The files whose text names scripts by path: a hook, a workflow or a skill runs each of them. */
const NAMING = [".claude/settings.json", ".github/workflows/*.yml", ".claude/skills/**/SKILL.md"];

const FRONT_MATTER = /^---\n(?<yaml>[\s\S]*?)\n---(?:\n|$)/u;

const RuleHeader = Schema.Struct({ paths: Schema.optionalKey(Schema.Array(Schema.String)) });

/** The `paths` globs of a rule file's header; a rule with no header, or no `paths`, loads everywhere and has none. */
export function ruleGlobsOf(rule: string): readonly string[] {
  const yaml = FRONT_MATTER.exec(rule)?.groups?.["yaml"];

  return yaml === undefined ? [] : (Schema.decodeUnknownSync(RuleHeader)(Bun.YAML.parse(yaml)).paths ?? []);
}

/** How a hook's command names the checkout its script lives in, its quotes escaped as a JSON file writes them. */
const PROJECT_DIR = /\\?"?\$\{?CLAUDE_PROJECT_DIR\}?\\?"?\//gu;

/** A path from the repository root to a TypeScript file: at least one directory, and no path character before it. */
const SCRIPT_PATH = /(?<![\w@./-])(?:\.\/)?(?<path>(?:[\w@.-]+\/)+[\w@.-]+\.tsx?)(?![\w-])/gu;

/** The TypeScript files `text` names by their path from the repository root, each once. */
export function scriptsNamedIn(text: string): readonly string[] {
  const paths = [...text.replaceAll(PROJECT_DIR, "").matchAll(SCRIPT_PATH)].map(
    (match) => match.groups?.["path"] ?? "",
  );

  return [...new Set(paths)];
}

const FactoryConfig = Schema.Struct({
  land: Schema.Struct({
    routing: Schema.Struct({ ownerPaths: Schema.Array(Schema.String), deepReviewPaths: Schema.Array(Schema.String) }),
  }),
});

/** The globs of the factory config that guard a landing: each must still name a file. */
export function guardGlobsOf(config: string): readonly string[] {
  const { ownerPaths, deepReviewPaths } = decodeJson(FactoryConfig, FACTORY_CONFIG, config).land.routing;

  return [...ownerPaths, ...deepReviewPaths];
}

/** What the gate reads of the working tree. */
export interface Tree {
  /** Every file of the working tree, by its path from the root. */
  readonly files: readonly string[];
  /** The rule files, by path, with their text. */
  readonly rules: Readonly<Record<string, string>>;
  /** The files that name scripts, by path, with their text. */
  readonly naming: Readonly<Record<string, string>>;
  /** The modules the mutation job mutates, each with its test file. */
  readonly mutated: Readonly<Record<string, string>>;
  /** The factory config's text. */
  readonly config: string;
}

/** One line per name that names no file of `tree`, with the file that holds it. */
export function silentBreaks(tree: Tree): string[] {
  const files = new Set(tree.files);
  const matchesNone = (glob: string): boolean => !tree.files.some((file) => new Bun.Glob(glob).match(file));

  const rules = Object.entries(tree.rules).flatMap(([path, text]) =>
    ruleGlobsOf(text).flatMap((glob) =>
      matchesNone(glob) ? [`${path}: the \`paths\` glob \`${glob}\` matches no file, so the rule loads for none.`] : [],
    ),
  );

  const mutated = [...new Set(Object.entries(tree.mutated).flat())].flatMap((path) =>
    files.has(path) ? [] : [`stryker.config.ts: \`${path}\` does not exist, so its mutation pass would run nothing.`],
  );

  const scripts = Object.entries(tree.naming).flatMap(([path, text]) =>
    scriptsNamedIn(text).flatMap((script) =>
      files.has(script) ? [] : [`${path}: names \`${script}\`, which does not exist.`],
    ),
  );

  const guards = guardGlobsOf(tree.config).flatMap((glob) =>
    matchesNone(glob) ? [`${FACTORY_CONFIG}: the glob \`${glob}\` matches no file, so it guards nothing.`] : [],
  );

  return [...rules, ...mutated, ...scripts, ...guards];
}

async function workingTreeFiles(): Promise<string[]> {
  const listed = await $`git ls-files -z --cached --others --exclude-standard`.text();
  const paths = listed.split("\0").filter((path) => path !== "");
  // A file deleted from the working tree but not from the index is still listed.
  const present = await Promise.all(paths.map(async (path) => ((await Bun.file(path).exists()) ? [path] : [])));

  return present.flat();
}

async function textsOf(paths: readonly string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await Bun.file(path).text()] as const)));
}

if (import.meta.main) {
  const files = await workingTreeFiles();

  const errors = silentBreaks({
    files,
    rules: await textsOf(files.filter((file) => file.startsWith(RULES) && file.endsWith(".md"))),
    naming: await textsOf(files.filter((file) => NAMING.some((glob) => new Bun.Glob(glob).match(file)))),
    mutated: TESTS,
    config: await Bun.file(FACTORY_CONFIG).text(),
  });

  if (errors.length > 0) {
    console.error(`${errors.length} name(s) that name no file:\n`);

    for (const error of errors) {
      console.error(`  ${error}`);
    }

    console.error("\nPoint each at the file it means, or remove it.");
    process.exit(1);
  }
}
