#!/usr/bin/env bun

/**
 * The hook that gives each worktree its own dependencies, on SessionStart, SubagentStart and PostToolUse
 * after EnterWorktree: each of these hands the hook the cwd of a session or subagent that may have just
 * arrived in a new worktree. It runs `bun install --frozen-lockfile --ignore-scripts --backend=copyfile`
 * at the top of that checkout when it has a `bun.lock`, and only in a checkout of the project's own
 * repository. bun takes the packages from its shared cache and does nothing in about ten milliseconds when
 * all is in. Copied files, never hardlinks, so a write in one worktree's `node_modules` cannot reach the
 * main checkout's, from which the hooks load. No lifecycle script runs. A failed install exits 1, which
 * reports and blocks nothing.
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

if (import.meta.main) {
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
