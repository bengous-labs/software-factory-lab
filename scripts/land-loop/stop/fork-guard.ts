#!/usr/bin/env bun

/**
 * The PreToolUse hook of each Stop hook fork: it allows a read of the Author's worktree, outside
 * `.git`, and one read-only git command per Bash call, and denies every other tool call.
 *
 * Reads the PreToolUse input on stdin; prints the decision on stdout and exits 0.
 */

import { realpathSync } from "node:fs";

import { Result, Schema } from "effect";

import { resolverOf } from "../lib/resolve.ts";
import type { ToolDecision } from "../ports/review.ts";
import { readGuardOf } from "../review/tool-guard.ts";
import type { GuardScope } from "../review/tool-guard.ts";

/** The PreToolUse input, as far as this hook reads it. */
const PreToolUseInput = Schema.Struct({
  tool_name: Schema.String,
  tool_input: Schema.JsonObject,
  cwd: Schema.String,
});

const decodeInput = Schema.decodeResult(Schema.fromJsonString(PreToolUseInput));

const UNREADABLE = "the hook input does not read";

/** The guard's scope over the worktree `cwd`, every link followed. */
export function scopeOf(cwd: string): GuardScope {
  const root = realpathSync(cwd);

  return { root, resolve: resolverOf(root) };
}

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

if (import.meta.main) {
  console.log(forkGuardAnswer(await Bun.stdin.text(), scopeOf));
}
