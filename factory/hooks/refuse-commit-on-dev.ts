#!/usr/bin/env bun

/**
 * The PreToolUse hook on Bash. It denies a `git commit` that would run while the checked-out branch is
 * the Trunk: GitHub refuses a direct push to it, so such a commit is never published. It leaves every
 * other command alone, and a commit on any other branch or on a detached HEAD. It throws when its input
 * does not read.
 *
 * Reads the PreToolUse input on stdin; prints the deny decision on stdout.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

import { $ } from "bun";

import { TRUNK } from "../install/host.ts";
import { isApiWorker } from "../lib/author-session.ts";
import { bashCallOf, partsOf } from "../lib/bash.ts";
import type { Part } from "../lib/bash.ts";
import type { Env } from "../lib/env.ts";

/** The git global options that take their value as the next word. */
const VALUED_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/** The options of `cd`, none of which takes a value. */
const CD_OPTION = /^-[LPe@]+$/u;

const VARIABLE = /\$(?:\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?<bare>[A-Za-z_][A-Za-z0-9_]*))/gu;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** The directory a `git commit` in `words` runs in, starting from `cwd`; null when `words` is no commit. */
export function commitDirOf(words: readonly string[], cwd: string): string | null {
  let index = words.findIndex((word) => !ASSIGNMENT.test(word));

  if (index === -1 || words[index] !== "git") {
    return null;
  }

  let dir = cwd;

  for (index += 1; index < words.length; index += 1) {
    const word = words[index] ?? "";

    if (word === "-C") {
      index += 1;
      dir = resolve(dir, words[index] ?? "");
    } else if (VALUED_OPTIONS.has(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      return word === "commit" ? dir : null;
    }
  }

  return null;
}

/** `word` with its `~` and `$VAR` expanded from `env`, or null when it holds what the hook cannot expand. */
function expandedOf(word: string, env: Env): string | null {
  if (word.includes("`") || word.includes("$(") || /^~[^/]/u.test(word)) {
    return null;
  }

  const names = [...word.matchAll(VARIABLE)].map((match) => match.groups?.["braced"] ?? match.groups?.["bare"] ?? "");

  if (names.some((name) => env[name] === undefined)) {
    return null;
  }

  const expanded = word.replaceAll(
    VARIABLE,
    (_match, braced?: string, bare?: string) => env[braced ?? bare ?? ""] ?? "",
  );

  if (expanded.includes("$")) {
    return null;
  }

  return expanded.startsWith("~") ? homedir() + expanded.slice(1) : expanded;
}

/**
 * The directory a `cd` in `words` moves to, as the shell reads it: absolute, or relative to the directory it
 * runs in. Null when `words` is no `cd`, or for a target the hook cannot know, such as `cd -`.
 */
export function cdTargetOf(words: readonly string[], env: Env): string | null {
  if (words[0] !== "cd") {
    return null;
  }

  let index = 1;

  while (CD_OPTION.test(words[index] ?? "")) {
    index += 1;
  }

  if (words[index] === "--") {
    index += 1;
  }

  const target = words[index] ?? "~";

  return target === "-" ? null : expandedOf(target, env);
}

/** The directories the commands after a `cd` may run in, given the operator that follows it. */
function afterCd(next: Part | undefined, before: readonly string[], moved: readonly string[]): readonly string[] {
  if (next === "&&") {
    return moved;
  }

  // A cd in a pipeline or in the background runs in a subshell; after `;` or `||` it may have failed.
  return next === "|" || next === "&" ? before : [...new Set([...before, ...moved])];
}

/**
 * The directories each `git commit` in the Bash `command` may run in, starting from `cwd`. It follows each
 * `cd` the hook can read, restores the directory a `( … )` subshell started in, and keeps the directory a
 * `cd` may have failed to leave, so a commit is checked in every directory it may run in.
 */
export function commitDirsOf(command: string, cwd: string, env: Env): readonly string[] {
  const parts = partsOf(command);
  const dirs = new Set<string>();
  const saved: Array<readonly string[]> = [];
  let possible: readonly string[] = [cwd];

  for (const [index, part] of parts.entries()) {
    if (part === "(") {
      saved.push(possible);
    } else if (part === ")") {
      possible = saved.pop() ?? possible;
    } else if (Array.isArray(part)) {
      for (const dir of possible) {
        const commitDir = commitDirOf(part, dir);

        if (commitDir !== null) {
          dirs.add(commitDir);
        }
      }

      const target = cdTargetOf(part, env);

      if (target !== null && parts[index - 1] !== "|") {
        possible = afterCd(
          parts[index + 1],
          possible,
          possible.map((dir) => resolve(dir, target)),
        );
      }
    }
  }

  return [...dirs];
}

/** Why a commit on `branch` is refused, or null when it may go ahead; `branch` is null on a detached HEAD. */
export function refusalFor(branch: string | null): string | null {
  return branch === TRUNK
    ? `Refused: the checked-out branch is \`${TRUNK}\`. GitHub accepts \`${TRUNK}\` only through a pull request, so this commit would never be published. Create a branch first with \`git switch -c <branch>\`, then commit there.`
    : null;
}

/** The branch checked out in `dir`, or null on a detached HEAD, outside a repository, or for a missing `dir`. */
async function branchIn(dir: string): Promise<string | null> {
  const ran = await $`git -C ${dir} symbolic-ref --short -q HEAD`.nothrow().quiet();

  return ran.exitCode === 0 ? ran.stdout.toString().trim() : null;
}

// Not for an API Worker: the hook is outside its sandbox, and the directories of the command are the
// Worker's, where git would read the config the Worker wrote.
if (import.meta.main && !isApiWorker(process.env)) {
  const { command, cwd } = bashCallOf(await Bun.stdin.text());

  for (const dir of commitDirsOf(command, cwd, process.env)) {
    const reason = refusalFor(await branchIn(dir));

    if (reason !== null) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
      break;
    }
  }
}
