/**
 * The answer of the PreToolUse hook of each Stop hook fork (`bin/fork-guard.ts`): it allows a read of the
 * Author's worktree, outside `.git`, and one read-only git command per Bash call, and denies every other
 * tool call.
 */

import { Result, Schema } from "effect";

import type { ToolDecision } from "../shared/review.port.ts";
import { readGuardOf } from "../shared/tool-guard.ts";
import type { GuardScope } from "../shared/tool-guard.ts";

/** The PreToolUse input, as far as this hook reads it. */
const PreToolUseInput = Schema.Struct({
  tool_name: Schema.String,
  tool_input: Schema.JsonObject,
  cwd: Schema.String,
});

const decodeInput = Schema.decodeResult(Schema.fromJsonString(PreToolUseInput));

const UNREADABLE = "the hook input does not read";

function outputOf(decision: ToolDecision): string {
  const reason = decision.kind === "deny" ? { permissionDecisionReason: decision.reason } : {};

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.kind, ...reason },
  });
}

/** The hook's answer to the PreToolUse input `stdin`; an input that does not read, or a guard that throws, is denied. */
export function forkGuardAnswer(stdin: string, scope: (cwd: string) => GuardScope): string {
  const input = decodeInput(stdin);

  if (Result.isFailure(input)) {
    return outputOf({ kind: "deny", reason: UNREADABLE });
  }

  const { tool_name: toolName, tool_input: toolInput, cwd } = input.success;

  // A hook that exits with an error lets the call through to the permission rules: the guard fails closed here.
  try {
    return outputOf(readGuardOf(scope(cwd))(toolName, toolInput));
  } catch (error) {
    return outputOf({
      kind: "deny",
      reason: `the fork guard failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
