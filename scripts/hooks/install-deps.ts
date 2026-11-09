#!/usr/bin/env bun

/**
 * The hook that gives each worktree its own dependencies, on SessionStart, SubagentStart and PostToolUse
 * after EnterWorktree: each of these hands the hook the cwd of a session or subagent that may have just
 * arrived in a new worktree. It runs `bun install --frozen-lockfile --ignore-scripts --backend=copyfile`
 * at the top of that checkout when it has a `bun.lock`, and only in a checkout of the project's own
 * repository. bun takes the packages from its shared cache and does nothing in about ten milliseconds when
 * all is in. The packages this hook places are copies, never hardlinks into bun's cache, so a write to one
 * of them cannot reach the main checkout's `node_modules`, from which the hooks load; an install the
 * session runs itself keeps bun's own default. No lifecycle script runs. It does nothing in a Stop hook
 * fork, which must stay read-only. A failed install exits 1, which reports and blocks nothing.
 *
 * Reads the hook input on stdin.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { checkoutFromRevParse, projectDirOf, trustedRoot } from "../lib/checkout.ts";
import type { Checkout } from "../lib/checkout.ts";
import { decodeJson } from "../lib/json.ts";

/** The variable the Stop hook sets on the read-only forks it launches. */
const STOP_FORK_FLAG = "LAB_STOP_FORK";

/** The hook input, as far as this hook reads it. */
const HookInput = Schema.Struct({ cwd: Schema.String });

/** The cwd the hook input on `stdin` names. */
export function cwdOf(stdin: string): string {
  return decodeJson(HookInput, "the hook input", stdin).cwd;
}

/** The checkout `dir` lies in, or null outside any repository or for a missing `dir`. */
async function checkoutOf(dir: string): Promise<Checkout | null> {
  const ran = await $`git -C ${dir} rev-parse --path-format=absolute --show-toplevel --git-common-dir`
    .nothrow()
    .quiet();

  return checkoutFromRevParse(ran.stdout.toString(), ran.exitCode);
}

if (import.meta.main && process.env[STOP_FORK_FLAG] !== "1") {
  const cwd = cwdOf(await Bun.stdin.text());
  const root = trustedRoot(await checkoutOf(cwd), await checkoutOf(projectDirOf(process.env)));

  if (root !== null && existsSync(join(root, "bun.lock"))) {
    const ran = await $`${process.execPath} install --frozen-lockfile --ignore-scripts --backend=copyfile`
      .cwd(root)
      .nothrow()
      .quiet();

    if (ran.exitCode !== 0) {
      console.error(`install-deps: bun install failed in ${root}: ${ran.stderr.toString().trim()}`);
      process.exitCode = 1;
    }
  }
}
