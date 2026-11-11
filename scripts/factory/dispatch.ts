#!/usr/bin/env bun

/**
 * Hands an issue to a Worker: creates its worktree under `.claude/worktrees/` on a new branch from
 * `origin/dev`, and launches it as a background session in the main checkout.
 *
 *   bun scripts/factory/dispatch.ts <issue> [--model <model>]
 */

import { dirname } from "node:path";

import { run } from "../land-loop/lib/run.ts";
import { dispatchArgsOf } from "./dispatch-plan.ts";
import { dispatch } from "./dispatcher.ts";

const { issue, model } = dispatchArgsOf(process.argv.slice(2));

const commonDir = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: import.meta.dir,
  stdout: "pipe",
  stderr: "inherit",
});

if (commonDir.exitCode !== 0) {
  throw new Error("git rev-parse --git-common-dir failed: dispatch runs from a checkout of the repository");
}

const dispatched = await dispatch(run, {
  issue,
  model,
  checkout: dirname(commonDir.stdout.toString().trim()),
  env: process.env,
});

console.log(`issue:    #${dispatched.issue} ${dispatched.title}
worktree: ${dispatched.worktree}
branch:   ${dispatched.branch}
session:  ${dispatched.session}`);
