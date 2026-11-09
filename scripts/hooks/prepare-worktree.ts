#!/usr/bin/env bun

/**
 * The PreToolUse hook that keeps a worktree as ready as the main checkout. Before Claude creates a
 * worktree, with EnterWorktree or an Agent call with `isolation: worktree`, it points `origin/HEAD` at
 * the remote's default branch: Claude Code branches a `fresh` worktree from it, and its own fetch never
 * moves it. Before a Bash, Edit or Write call in a checkout with a `bun.lock` and no `node_modules`, it
 * installs the dependencies there, so the checks, oxlint and the format hook run as in the main checkout.
 * It prints nothing; a step that fails throws, naming the command and its output.
 *
 * Reads the PreToolUse input on stdin.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

const WORKING_TOOLS = new Set(["Bash", "Edit", "Write"]);

/** The PreToolUse input, as far as this hook reads it. */
const PreToolUseInput = Schema.Struct({
  cwd: Schema.String,
  tool_name: Schema.String,
  tool_input: Schema.Struct({ isolation: Schema.optionalKey(Schema.String) }),
});

/** The tool call on `stdin`. */
export function toolCallOf(stdin: string): typeof PreToolUseInput.Type {
  return decodeJson(PreToolUseInput, "the PreToolUse input", stdin);
}

/** Whether the checkout holds a lockfile and installed dependencies. */
export interface Dependencies {
  readonly lockfile: boolean;
  readonly installed: boolean;
}

/** What the hook does before a call: point `origin/HEAD` at the remote's default branch, install the dependencies. */
export interface Steps {
  readonly syncOriginHead: boolean;
  readonly install: boolean;
}

/** The steps before the call of `tool` with `isolation`, in a checkout whose dependencies are `dependencies`. */
export function stepsFor(tool: string, isolation: string | undefined, dependencies: Dependencies): Steps {
  return {
    syncOriginHead: tool === "EnterWorktree" || (tool === "Agent" && isolation === "worktree"),
    install: WORKING_TOOLS.has(tool) && dependencies.lockfile && !dependencies.installed,
  };
}

/** Runs `command` in `cwd`, and throws with its output when it fails. */
async function run(command: readonly string[], cwd: string): Promise<void> {
  const ran = await $`${command}`.cwd(cwd).nothrow().quiet();

  if (ran.exitCode !== 0) {
    throw new Error(
      `prepare-worktree: \`${command.join(" ")}\` in ${cwd} exited ${ran.exitCode}: ${ran.stderr.toString()}`,
    );
  }
}

if (import.meta.main) {
  const call = toolCallOf(await Bun.stdin.text());
  const toplevel = await $`git -C ${call.cwd} rev-parse --show-toplevel`.nothrow().quiet();

  if (toplevel.exitCode === 0) {
    const root = toplevel.stdout.toString().trim();

    const steps = stepsFor(call.tool_name, call.tool_input.isolation, {
      lockfile: existsSync(join(root, "bun.lock")),
      installed: existsSync(join(root, "node_modules")),
    });

    if (steps.syncOriginHead) {
      await run(["git", "remote", "set-head", "origin", "--auto"], root);
    }

    if (steps.install) {
      await run([process.execPath, "install", "--frozen-lockfile"], root);
    }
  }
}
