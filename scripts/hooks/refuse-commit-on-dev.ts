#!/usr/bin/env bun

/**
 * The PreToolUse hook on Bash. It denies a `git commit` that would run while the checked-out branch is
 * `dev`: GitHub refuses a direct push to `dev`, so such a commit is never published. It leaves every
 * other command alone, and a commit on any other branch or on a detached HEAD. It throws when its input
 * does not read.
 *
 * Reads the PreToolUse input on stdin; prints the deny decision on stdout.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

const PROTECTED_BRANCH = "dev";

/** The PreToolUse input, as far as this hook reads it. */
const PreToolUseInput = Schema.Struct({
  cwd: Schema.String,
  tool_input: Schema.Struct({ command: Schema.optionalKey(Schema.String) }),
});

/** The git global options that take their value as the next word. */
const VALUED_OPTIONS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** The Bash command the tool call on `stdin` runs, and the directory it runs in. */
export function bashCallOf(stdin: string) {
  const input = decodeJson(PreToolUseInput, "the PreToolUse input", stdin);

  return { command: input.tool_input.command ?? "", cwd: input.cwd };
}

/** `command` cut into simple commands, each a list of words, with quotes removed and separators dropped. */
export function simpleCommandsOf(command: string): ReadonlyArray<readonly string[]> {
  const commands: string[][] = [[]];
  let word: string | null = null;
  let quote: string | null = null;

  const endWord = () => {
    if (word !== null) {
      commands.at(-1)?.push(word);
      word = null;
    }
  };

  for (const char of command) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word = (word ?? "") + char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (SEPARATORS.has(char)) {
      endWord();
      commands.push([]);
    } else if (/\s/u.test(char)) {
      endWord();
    } else {
      word = (word ?? "") + char;
    }
  }

  endWord();

  return commands.filter((words) => words.length > 0);
}

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

/** The directory a `cd` in `words` moves to from `dir`, or `dir` when `words` is no `cd`. */
export function cdTargetOf(words: readonly string[], dir: string): string {
  if (words[0] !== "cd") {
    return dir;
  }

  const target = words[1] ?? "~";

  return resolve(dir, target === "~" || target.startsWith("~/") ? homedir() + target.slice(1) : target);
}

/** The directories each `git commit` in the Bash `command` runs in, starting from `cwd` and following each `cd`. */
export function commitDirsOf(command: string, cwd: string): readonly string[] {
  const dirs: string[] = [];
  let dir = cwd;

  for (const words of simpleCommandsOf(command)) {
    dir = cdTargetOf(words, dir);

    const commitDir = commitDirOf(words, dir);

    if (commitDir !== null) {
      dirs.push(commitDir);
    }
  }

  return dirs;
}

/** Why a commit on `branch` is refused, or null when it may go ahead; `branch` is null on a detached HEAD. */
export function refusalFor(branch: string | null): string | null {
  return branch === PROTECTED_BRANCH
    ? `Refused: the checked-out branch is \`${PROTECTED_BRANCH}\`. GitHub accepts \`${PROTECTED_BRANCH}\` only through a pull request, so this commit would never be published. Create a branch first with \`git switch -c <branch>\`, then commit there.`
    : null;
}

/** The branch checked out in `dir`, or null on a detached HEAD, outside a repository, or for a missing `dir`. */
async function branchIn(dir: string): Promise<string | null> {
  const ran = await $`git -C ${dir} symbolic-ref --short -q HEAD`.nothrow().quiet();

  return ran.exitCode === 0 ? ran.stdout.toString().trim() : null;
}

if (import.meta.main) {
  const { command, cwd } = bashCallOf(await Bun.stdin.text());

  for (const dir of commitDirsOf(command, cwd)) {
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
