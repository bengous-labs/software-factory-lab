#!/usr/bin/env bun

/**
 * The PostToolUse hook on Edit and Write. It applies the style config's autofixes, then `bun fmt`, to
 * the file the tool wrote, when that file is one `bun fmt --check .` reads in its own checkout: not
 * ignored by git, and matched by no `[fmt].ignorePatterns` of that checkout's `bunfig.toml`. That keeps
 * the vendored anti-slop copy and `node_modules` out. The checkout is the file's own, the main one or a
 * worktree, and the hook acts only on a checkout of the project's own repository: it runs that
 * checkout's oxlint and configs, and never another repository's. A path through a symbolic link is read
 * as its real path, the one git names the checkout by. In an Author's session, and in one that works in a
 * clone, it does nothing: a Worker formats its own files, in its sandbox. It prints nothing and exits 0, since what a
 * PostToolUse hook prints goes into the agent's context, unless its input or `bunfig.toml` does not read,
 * or `CLAUDE_PROJECT_DIR` is unset: it then throws, naming which.
 *
 * Reads the PostToolUse input on stdin.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { $ } from "bun";

import { isSandboxedWorker } from "../../factory/lib/author-session.ts";
import { checkoutFromRevParse, projectDirOf, trustedRoot } from "../../factory/lib/checkout.ts";
import type { Checkout } from "../../factory/lib/checkout.ts";
import type { Json } from "../../factory/lib/plain-json.ts";
import {
  objectAt,
  optionalObjectAt,
  optionalStringAt,
  optionalStringsAt,
  parseJson,
} from "../../factory/lib/plain-json.ts";

const LINTED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const FORMATTED = new Set([...LINTED, ".json", ".jsonc", ".md", ".yml", ".yaml", ".toml", ".css", ".html"]);

/** The `file_path` the Edit or Write tool call on `stdin` names, or null when its input has none. */
export function filePathOf(stdin: string): string | null {
  const source = "the PostToolUse input";
  const input = objectAt(source, parseJson(source, stdin));
  const toolInput = objectAt(source, input["tool_input"], ["tool_input"]);

  return optionalStringAt(source, toolInput, "file_path", ["tool_input"]) ?? null;
}

/** The `[fmt].ignorePatterns` of a `bunfig.toml`. */
export function formatIgnorePatterns(bunfig: string): readonly string[] {
  const source = "bunfig.toml";
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: a parsed TOML document holds only tables, arrays, strings, numbers, booleans and dates, which the checks below read as JSON values.
  const document = Bun.TOML.parse(bunfig) as Json;
  const fmt = optionalObjectAt(source, objectAt(source, document), "fmt");

  return (fmt && optionalStringsAt(source, fmt, "ignorePatterns", ["fmt"])) ?? [];
}

/** `filePath` relative to `root`, when it lies under `root` with an extension bun fmt formats; else null. */
export function candidateOf(root: string, filePath: string, ignorePatterns: readonly string[]): string | null {
  const path = relative(root, filePath);

  if (path === "" || path.split(sep)[0] === ".." || isAbsolute(path) || !FORMATTED.has(extname(path))) {
    return null;
  }

  return ignorePatterns.some((pattern) => new Bun.Glob(pattern).match(path)) ? null : path;
}

/** The checkout `dir` lies in, or null outside any repository or for a missing `dir`. */
async function checkoutOf(dir: string): Promise<Checkout | null> {
  const ran = await $`git -C ${dir} rev-parse --path-format=absolute --show-toplevel --git-common-dir`
    .nothrow()
    .quiet();

  return checkoutFromRevParse(ran.stdout.toString(), ran.exitCode);
}

/** Applies the autofixes and `bun fmt` to `filePath` in the checkout at `root`, when that checkout formats it. */
async function fixIn(root: string, filePath: string): Promise<void> {
  const ignorePatterns = formatIgnorePatterns(await Bun.file(join(root, "bunfig.toml")).text());
  const path = candidateOf(root, filePath, ignorePatterns);

  // git check-ignore exits 0 for an ignored path, 1 for one that is not.
  if (path === null || (await $`git check-ignore -q -- ${path}`.cwd(root).nothrow().quiet()).exitCode !== 1) {
    return;
  }

  if (LINTED.has(extname(path))) {
    const oxlint = join(root, "node_modules", ".bin", "oxlint");

    // A second pass applies the fixes that wait on another rule's fix, such as the blank line after a
    // brace curly adds. An error both passes leave is the Stop checks' to report, not this hook's.
    const fix = () => $`${oxlint} -c oxlint.style.config.ts --fix --quiet ${path}`.cwd(root).nothrow().quiet();

    await fix();
    await fix();
  }

  await $`${process.execPath} fmt ${path}`.cwd(root).nothrow().quiet();
}

// A Worker's code runs in its sandbox alone, and a hook's command is outside it: the fix would run git
// and the lint config of the tree the Worker edits. The Worker formats its files itself, and CI's
// check catches what it left.
if (import.meta.main && !isSandboxedWorker(process.env)) {
  const filePath = filePathOf(await Bun.stdin.text());

  if (filePath !== null) {
    const root = trustedRoot(await checkoutOf(dirname(filePath)), await checkoutOf(projectDirOf(process.env)));

    // git names the checkout by its real path, so a path through a symbolic link would read as outside it.
    if (root !== null) {
      await fixIn(root, join(realpathSync(dirname(filePath)), basename(filePath)));
    }
  }
}
