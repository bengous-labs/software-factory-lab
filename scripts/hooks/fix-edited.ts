#!/usr/bin/env bun

/**
 * The PostToolUse hook on Edit and Write. It applies the style config's autofixes, then `bun fmt`, to
 * the file the tool wrote, when that file is one `bun fmt --check .` reads: not ignored by git, and
 * matched by no `[fmt].ignorePatterns` of `bunfig.toml`. That keeps the vendored anti-slop copy,
 * `node_modules` and `.claude/worktrees` out. It prints nothing and exits 0, since what a PostToolUse
 * hook prints goes into the agent's context, unless its input or `bunfig.toml` does not read: it then
 * throws, naming which.
 *
 * Reads the PostToolUse input on stdin.
 */

import { extname, isAbsolute, join, relative, sep } from "node:path";

import { $ } from "bun";
import { Result, Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

const ROOT = join(import.meta.dir, "..", "..");

const LINTED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const FORMATTED = new Set([...LINTED, ".json", ".jsonc", ".md", ".yml", ".yaml", ".toml", ".css", ".html"]);

/** The PostToolUse input, as far as this hook reads it. */
const PostToolUseInput = Schema.Struct({ tool_input: Schema.Struct({ file_path: Schema.optionalKey(Schema.String) }) });

const Bunfig = Schema.Struct({
  fmt: Schema.optionalKey(Schema.Struct({ ignorePatterns: Schema.optionalKey(Schema.Array(Schema.String)) })),
});

/** The `file_path` the Edit or Write tool call on `stdin` names, or null when its input has none. */
export function filePathOf(stdin: string): string | null {
  return decodeJson(PostToolUseInput, "the PostToolUse input", stdin).tool_input.file_path ?? null;
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

if (import.meta.main) {
  const filePath = filePathOf(await Bun.stdin.text());
  const ignorePatterns = formatIgnorePatterns(await Bun.file(join(ROOT, "bunfig.toml")).text());
  const path = filePath === null ? null : candidateOf(ROOT, filePath, ignorePatterns);

  // git check-ignore exits 0 for an ignored path, 1 for one that is not.
  if (path !== null && (await $`git check-ignore -q -- ${path}`.cwd(ROOT).nothrow().quiet()).exitCode === 1) {
    if (LINTED.has(extname(path))) {
      const oxlint = join(ROOT, "node_modules", ".bin", "oxlint");

      // A second pass applies the fixes that wait on another rule's fix, such as the blank line after a
      // brace curly adds. An error both passes leave is the Stop checks' to report, not this hook's.
      const fix = () => $`${oxlint} -c oxlint.style.config.ts --fix --quiet ${path}`.cwd(ROOT).nothrow().quiet();

      await fix();
      await fix();
    }

    await $`${process.execPath} fmt ${path}`.cwd(ROOT).nothrow().quiet();
  }
}
