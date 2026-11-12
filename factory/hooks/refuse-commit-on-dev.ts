#!/usr/bin/env bun

/**
 * The PreToolUse hook on Bash. It denies a `git commit` that would run while the checked-out branch is
 * the Trunk: GitHub refuses a direct push to it, so such a commit is never published. It leaves every
 * other command alone, and a commit on any other branch or on a detached HEAD. It throws when its input
 * does not read.
 *
 * It reads the branch from the files of the checkout and runs no git: the hook is outside the sandbox of
 * an API Worker, whose commands write the directories a command names, and git would act on what it
 * finds there.
 *
 * Reads the PreToolUse input on stdin; prints the deny decision on stdout.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { TRUNK } from "../install/host.ts";
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

const HEAD_OF_BRANCH = "ref: refs/heads/";

/** The branch `head` names, the text of a `HEAD` file; null on a detached HEAD. */
export function branchOfHead(head: string): string | null {
  const line = head.trim();

  return line.startsWith(HEAD_OF_BRANCH) ? line.slice(HEAD_OF_BRANCH.length) : null;
}

/** The git directory a `.git` file's `text` names, for the checkout `root`; null when it names none. */
export function gitDirOfFile(text: string, root: string): string | null {
  const named = /^gitdir: (?<path>.+)$/mu.exec(text)?.groups?.["path"];

  return named === undefined ? null : resolve(root, named);
}

/** The text of `path` when it is a regular file, which a read cannot hang on as it would on a pipe; else null. */
function textOf(path: string): string | null {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true ? readFileSync(path, "utf8") : null;
}

/** The git directory of the checkout `dir` lies in: its nearest `.git`, a directory or a file that names one. */
function gitDirOf(dir: string): string | null {
  const dotGit = join(dir, ".git");

  if (statSync(dotGit, { throwIfNoEntry: false })?.isDirectory() === true) {
    return dotGit;
  }

  const named = gitDirOfFile(textOf(dotGit) ?? "", dir);
  const parent = dirname(dir);

  return named !== null || parent === dir ? named : gitDirOf(parent);
}

/** The branch checked out in `dir`, or null on a detached HEAD, outside a repository, or for a missing `dir`. */
function branchIn(dir: string): string | null {
  const gitDir = statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true ? gitDirOf(dir) : null;

  return gitDir === null ? null : branchOfHead(textOf(join(gitDir, "HEAD")) ?? "");
}

if (import.meta.main) {
  const { command, cwd } = bashCallOf(await Bun.stdin.text());

  for (const dir of commitDirsOf(command, cwd, process.env)) {
    const reason = refusalFor(branchIn(dir));

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
