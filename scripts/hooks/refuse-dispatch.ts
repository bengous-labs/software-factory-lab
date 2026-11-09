#!/usr/bin/env bun

/**
 * The PreToolUse hook on Skill and the UserPromptExpansion hook. It refuses `github-flow:dispatch` and
 * `github-flow:shift`, whether Claude calls the skill or the user types its command: they run each Worker
 * as a subagent in a worktree, and a subagent never fires the Stop hook that publishes a Worker's pull
 * request. It leaves every other skill and command alone, and refuses with exit 2 when its input does not
 * read.
 *
 * Reads the hook input on stdin; prints the refusal on stdout, or on stderr for an input it cannot read.
 */

import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

/** The refused skills, each by its full name and by the bare name the Skill tool also launches. */
const REFUSED = new Set(["github-flow:dispatch", "github-flow:shift", "dispatch", "shift"]);

/** The two inputs this hook reads: Claude's Skill call, and the user's typed command. */
const HookInput = Schema.Union([
  Schema.Struct({
    hook_event_name: Schema.Literal("PreToolUse"),
    tool_input: Schema.Struct({ skill: Schema.String }),
  }),
  Schema.Struct({ hook_event_name: Schema.Literal("UserPromptExpansion"), command_name: Schema.String }),
]);

type HookInput = typeof HookInput.Type;

/** The hook input on `stdin`. */
export function hookInputOf(stdin: string): HookInput {
  return decodeJson(HookInput, "the hook input", stdin);
}

/**
 * Why the skill or command `name` is refused, or null when it may run. The Skill tool launches a skill named
 * with surrounding spaces, a leading `/` or no plugin prefix, so the name is read without the first two and
 * matched bare too. It refuses another case itself, so the case is kept.
 */
export function refusalFor(name: string): string | null {
  const skill = name.trim().replace(/^\//u, "");

  return REFUSED.has(skill)
    ? `Refused: \`${skill}\` runs each Worker as a subagent, and in this repository a Worker is its own Claude Code session. A subagent never fires the Stop hook, so its pull request would get no Stop checks, no Done judge and no PR watch to answer its review. Start one session per issue instead: it enters a worktree with EnterWorktree, and its Stop hook publishes the pull request when it stops.`
    : null;
}

/** The hook output that refuses `input`, or null when it may go ahead. */
export function answerOf(input: HookInput): string | null {
  if (input.hook_event_name === "PreToolUse") {
    const reason = refusalFor(input.tool_input.skill);

    return reason === null
      ? null
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        });
  }

  const reason = refusalFor(input.command_name);

  return reason === null ? null : JSON.stringify({ decision: "block", reason });
}

/** What the hook prints on each stream, and the code it exits with. */
export interface HookRun {
  readonly code: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

/** What the hook does with `stdin`: print `stdout` and exit 0, or refuse with `stderr` and exit 2. */
export function runOf(stdin: string): HookRun {
  let input: HookInput;

  try {
    input = hookInputOf(stdin);
  } catch (error) {
    // Claude Code runs the call when a hook exits 1, so an input this guard cannot read refuses it instead.
    return { code: 2, stdout: "", stderr: `Refused: refuse-dispatch could not read its input. ${String(error)}` };
  }

  return { code: 0, stdout: answerOf(input) ?? "", stderr: "" };
}

if (import.meta.main) {
  const run = runOf(await Bun.stdin.text());

  if (run.stdout !== "") {
    console.log(run.stdout);
  }

  if (run.stderr !== "") {
    console.error(run.stderr);
  }

  process.exitCode = run.code;
}
