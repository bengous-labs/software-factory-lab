#!/usr/bin/env bun

/**
 * The PreToolUse hook on Skill and the UserPromptExpansion hook. It refuses `github-flow:dispatch` and
 * `github-flow:shift`, whether Claude calls the skill or the user types its command: they run each Worker
 * as a subagent in a worktree, and a subagent never fires the Stop hook that publishes a Worker's pull
 * request. It leaves every other skill and command alone, and throws when its input does not read.
 *
 * Reads the hook input on stdin; prints the refusal on stdout.
 */

import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

const REFUSED = new Set(["github-flow:dispatch", "github-flow:shift"]);

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

/** Why the skill or command `name` is refused, or null when it may run. */
export function refusalFor(name: string): string | null {
  return REFUSED.has(name)
    ? `Refused: \`${name}\` runs each Worker as a subagent, and in this repository a Worker is its own Claude Code session. A subagent never fires the Stop hook, so its pull request would get no Stop checks, no Done judge and no PR watch to answer its review. Start one session per issue instead: it enters a worktree with EnterWorktree, and its Stop hook publishes the pull request when it stops.`
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

if (import.meta.main) {
  const answer = answerOf(hookInputOf(await Bun.stdin.text()));

  if (answer !== null) {
    console.log(answer);
  }
}
