#!/usr/bin/env bun

/**
 * The PostToolUse hook on Edit and Write. It applies the style config's autofixes, then `bun fmt`, to
 * the file the tool wrote, when that file is one `bun fmt --check .` reads in its own checkout: not
 * ignored by git, and matched by no `[fmt].ignorePatterns` of that checkout's `bunfig.toml`. That keeps
 * the vendored anti-slop copy and `node_modules` out. The checkout is the file's own, the main one or a
 * worktree, and the hook acts only when it belongs to the repository of the session's `cwd`. It prints
 * nothing and exits 0, since what a PostToolUse hook prints goes into the agent's context, unless its
 * input or `bunfig.toml` does not read: it then throws, naming which.
 *
 * Reads the PostToolUse input on stdin.
 */

import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { $ } from "bun";
import { Result, Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

const LINTED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const FORMATTED = new Set([...LINTED, ".json", ".jsonc", ".md", ".yml", ".yaml", ".toml", ".css", ".html"]);

/** The PostToolUse input, as far as this hook reads it. */
const PostToolUseInput = Schema.Struct({
  cwd: Schema.String,
  tool_input: Schema.Struct({ file_path: Schema.optionalKey(Schema.String) }),
});

const Bunfig = Schema.Struct({
  fmt: Schema.optionalKey(Schema.Struct({ ignorePatterns: Schema.optionalKey(Schema.Array(Schema.String)) })),
});

/** What the hook reads of an Edit or Write call: the file it names, null when none, and the session's cwd. */
export interface EditCall {
  readonly filePath: string | null;
  readonly cwd: string;
}

/** The Edit or Write tool call on `stdin`. */
export function editOf(stdin: string): EditCall {
  const input = decodeJson(PostToolUseInput, "the PostToolUse input", stdin);

  return { filePath: input.tool_input.file_path ?? null, cwd: input.cwd };
}

/** A checkout: its top-level directory, and the git directory it shares with every worktree of its repository. */
export interface Checkout {
  readonly root: string;
  readonly commonDir: string;
}

/** The root of the file's checkout, when it belongs to the same repository as the session's; else null. */
export function rootFor(file: Checkout | null, session: Checkout | null): string | null {
  return file !== null && session !== null && file.commonDir === session.commonDir ? file.root : null;
}

/** The checkout `dir` lies in, or null outside any repository or for a missing `dir`. */
async function checkoutOf(dir: string): Promise<Checkout | null> {
  const ran = await $`git -C ${dir} rev-parse --path-format=absolute --show-toplevel --git-common-dir`
    .nothrow()
    .quiet();

  const [root, commonDir] = ran.stdout.toString().trim().split("\n");

  return ran.exitCode === 0 && root !== undefined && commonDir !== undefined ? { root, commonDir } : null;
}

/** The `[fmt].ignorePatterns` of a `bunfig.toml`. */
export function formatIgnorePatterns(bunfig: string): readonly string[] {
  const decoded = Schema.decodeUnknownResult(Bunfig)(Bun.TOML.parse(bunfig));

  if (Result.isFailure(decoded)) {
    throw new Error(`bunfig.toml: ${decoded.failure.message}`, { cause: decoded.failure });
  }

  return decoded.success.fmt?.ignorePatterns ?? [];
}

/** `filePath` relative to `root`, when it lies under `root` with an extension bun fmt formats; else null. */
export function candidateOf(root: string, filePath: string, ignorePatterns: readonly string[]): string | null {
  const path = relative(root, filePath);

  if (path === "" || path.split(sep)[0] === ".." || isAbsolute(path) || !FORMATTED.has(extname(path))) {
    return null;
  }

  return ignorePatterns.some((pattern) => new Bun.Glob(pattern).match(path)) ? null : path;
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

if (import.meta.main) {
  const { filePath, cwd } = editOf(await Bun.stdin.text());

  if (filePath !== null) {
    const root = rootFor(await checkoutOf(dirname(filePath)), await checkoutOf(cwd));

    if (root !== null) {
      await fixIn(root, filePath);
    }
  }
}
