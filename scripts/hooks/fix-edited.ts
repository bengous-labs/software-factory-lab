#!/usr/bin/env bun

/**
 * The PostToolUse hook on Edit and Write. It applies the style config's autofixes, then `bun fmt`, to
 * the file the tool wrote, when that file is one `bun fmt --check .` reads: not ignored by git, and
 * matched by no `[fmt].ignorePatterns` of `bunfig.toml`. That keeps the vendored anti-slop copy,
 * `node_modules` and `.claude/worktrees` out. It prints nothing and exits 0: what a PostToolUse hook
 * prints goes into the agent's context.
 *
 * Reads the PostToolUse input on stdin.
 */

import { extname, isAbsolute, join, relative } from "node:path";

import { $ } from "bun";

const ROOT = join(import.meta.dir, "..", "..");

const LINTED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const FORMATTED = new Set([...LINTED, ".json", ".jsonc", ".md", ".yml", ".yaml", ".toml", ".css", ".html"]);

/** The `file_path` an Edit or Write tool call names, or null when its input has none. */
export function filePathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null || !("tool_input" in input)) {
    return null;
  }

  const toolInput = input.tool_input;

  if (typeof toolInput !== "object" || toolInput === null || !("file_path" in toolInput)) {
    return null;
  }

  return typeof toolInput.file_path === "string" ? toolInput.file_path : null;
}

/** The `[fmt].ignorePatterns` of a `bunfig.toml`. */
export function formatIgnorePatterns(bunfig: string): string[] {
  const parsed = Bun.TOML.parse(bunfig);
  const fmt = "fmt" in parsed ? parsed.fmt : undefined;

  if (typeof fmt !== "object" || fmt === null || !("ignorePatterns" in fmt) || !Array.isArray(fmt.ignorePatterns)) {
    return [];
  }

  return fmt.ignorePatterns.filter((pattern: unknown) => typeof pattern === "string");
}

/** `filePath` relative to `root`, when it lies under `root` with an extension bun fmt formats; else null. */
export function candidateOf(root: string, filePath: string, ignorePatterns: readonly string[]): string | null {
  const path = relative(root, filePath);

  if (path === "" || path.startsWith("..") || isAbsolute(path) || !FORMATTED.has(extname(path))) {
    return null;
  }

  return ignorePatterns.some((pattern) => new Bun.Glob(pattern).match(path)) ? null : path;
}

if (import.meta.main) {
  const filePath = filePathOf(JSON.parse(await Bun.stdin.text()));
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
