#!/usr/bin/env bun

/**
 * The PreToolUse hook on Bash that keeps an Author from publishing by hand. In a Worker's session, an Author's or
 * a bench session's (`isWorker`), it denies a command that runs `git push`, `gh pr create` or
 * `gh pr ready`: the Stop hook alone pushes, opens and readies an Author's PR. In any other session it
 * reads nothing and allows everything. In a Worker's session, an input it cannot read is denied. A
 * guard that cannot start, or times out, blocks the call: its entry in `.claude/settings.json` sets
 * `"onFailure": "block"` (`factory/hooks/AGENTS.md`).
 *
 * It reads the command as words, and refuses the three commands as an Author writes them. It holds an
 * Author to its role; it is no wall around the Author's token. What the shell builds at run time passes:
 * a variable, a git or gh alias, a quoting trick (`git pu\sh`), a command line inside one word
 * (`env -S 'git push'`), an interpreter that runs git itself. So does the API's own way to open or
 * ready a pull request, `gh api`.
 *
 * Reads the PreToolUse input on stdin; prints the deny decision on stdout.
 */

import { basename } from "node:path";

import { isWorker } from "../lib/author-session.ts";
import { bashCallOf, partsOf } from "../lib/bash.ts";

/** The git global options that take their value as the next word. */
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/** The gh options that take their value as the next word and may come before the subcommand's words. */
const GH_VALUED = new Set(["-R", "--repo"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** The subcommands of `gh pr` that open a pull request or ready one; `new` is gh's alias of `create`. */
const GH_PR_PUBLISHING = new Set(["create", "new", "ready"]);

/** The words of `words` that are no option, nor the value of one of `valued`. */
function positionalOf(words: readonly string[], valued: ReadonlySet<string>): readonly string[] {
  const positional: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";

    if (valued.has(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      positional.push(word);
    }
  }

  return positional;
}

/** The command a word names: its last path segment. */
const nameOf = (word: string): string => basename(word);

/** What the command starting at `words[0]` publishes, or null: `git … push`, or `gh pr create`, `new` or `ready`. */
function publishedBy(words: readonly string[]): string | null {
  const name = nameOf(words[0] ?? "");
  const rest = words.slice(1);

  if (name === "git") {
    return positionalOf(rest, GIT_VALUED)[0] === "push" ? "git push" : null;
  }

  if (name !== "gh") {
    return null;
  }

  const [group, action = ""] = positionalOf(rest, GH_VALUED);

  return group === "pr" && GH_PR_PUBLISHING.has(action) ? `gh pr ${action}` : null;
}

/** The command lines a simple command hands to a shell: the word after a shell's `-c`, and the words of `eval`. */
function nestedOf(words: readonly string[]): readonly string[] {
  return words.flatMap((word, index) => {
    const name = nameOf(word);

    if (name === "eval") {
      return [words.slice(index + 1).join(" ")];
    }

    const flag = SHELLS.has(name) ? words.findIndex((later, at) => at > index && /^-[a-z]*c$/u.test(later)) : -1;

    return flag === -1 ? [] : [words[flag + 1] ?? ""];
  });
}

/**
 * What the Bash `command` publishes, or null when it publishes nothing. Every word of every simple
 * command is read as a command's start, so one a wrapper runs (`env`, `command`, `xargs`, `timeout`) is
 * found too, and so is one a shell or `eval` is handed as a string.
 */
export function publishingOf(command: string): string | null {
  for (const part of partsOf(command)) {
    if (Array.isArray(part)) {
      // A backtick opens or closes a command substitution: the words around it are a command's.
      const words: readonly string[] = part.map((word: string) => word.replaceAll("`", ""));

      const candidates = [
        ...words.map((_, index) => publishedBy(words.slice(index))),
        ...nestedOf(words).map((nested) => publishingOf(nested)),
      ];

      const [found] = candidates.flatMap((published) => (published === null ? [] : [published]));

      if (found !== undefined) {
        return found;
      }
    }
  }

  return null;
}

/** Why an Author's command is refused. */
export function refusalFor(published: string): string {
  return `Refused: an Author does not run \`${published}\`. The Stop hook pushes your branch and opens or readies its pull request when you stop: commit, then stop.`;
}

/** The hook's answer to the PreToolUse input `stdin` in a Worker's session: the refusal's reason, or null to allow. */
export function answerOf(stdin: string): string | null {
  let command: string;

  try {
    ({ command } = bashCallOf(stdin));
  } catch (error) {
    return `Refused: the hook that keeps an Author from publishing could not read this call (${error instanceof Error ? error.message : String(error)}).`;
  }

  const published = publishingOf(command);

  return published === null ? null : refusalFor(published);
}

if (import.meta.main && isWorker(process.env)) {
  const reason = answerOf(await Bun.stdin.text());

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
  }
}
