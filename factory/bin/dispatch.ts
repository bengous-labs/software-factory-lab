#!/usr/bin/env bun

/**
 * Hands an issue to a Worker: creates its worktree under `.claude/worktrees/` on a new branch from
 * the Trunk, and launches it as a background session in the main checkout.
 *
 *   bun factory/bin/dispatch.ts <issue> [--model <model>] [--effort <level>]
 *
 * `<level>` is one of the effort levels `factory/lib/effort.ts` holds.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { dispatchArgsOf } from "../dispatch/dispatch-plan.ts";
import { dispatch } from "../dispatch/dispatcher.ts";
import { run, runIsolated } from "../lib/run.live.ts";

const args = dispatchArgsOf(process.argv.slice(2));

const commonDir = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: import.meta.dir,
  stdout: "pipe",
  stderr: "inherit",
});

if (commonDir.exitCode !== 0) {
  throw new Error("git rev-parse --git-common-dir failed: dispatch runs from a checkout of the repository");
}

const ports = { run, launch: runIsolated, readText: (path: string) => readFile(path, "utf8") };

const dispatched = await dispatch(ports, {
  ...args,
  checkout: dirname(commonDir.stdout.toString().trim()),
  env: process.env,
});

console.log(`issue:    #${dispatched.issue} ${dispatched.title}
worktree: ${dispatched.worktree}
branch:   ${dispatched.branch}
session:  ${dispatched.session}`);
