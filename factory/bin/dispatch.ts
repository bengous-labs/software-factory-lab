#!/usr/bin/env bun

/**
 * Hands an issue to a Worker: makes it a clone of its own, outside the main checkout, on a new branch
 * from the Trunk, and launches it there as a background session. With `--api` the Worker is an API
 * Worker: a headless session in its clone, which bills the Owner's Console API key.
 *
 *   bun factory/bin/dispatch.ts <issue> [--model <model>] [--effort <level>] [--api]
 *
 * `<level>` is one of the effort levels `factory/lib/effort.ts` holds.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { dispatchArgsOf } from "../dispatch/dispatch-plan.ts";
import { dispatch } from "../dispatch/dispatcher.ts";
import type { DispatchPorts } from "../dispatch/dispatcher.ts";
import { leave, run, runIsolated } from "../lib/run.live.ts";

const args = dispatchArgsOf(process.argv.slice(2));

const commonDir = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
  cwd: import.meta.dir,
  stdout: "pipe",
  stderr: "inherit",
});

if (commonDir.exitCode !== 0) {
  throw new Error("git rev-parse --git-common-dir failed: dispatch runs from a checkout of the repository");
}

const ports: DispatchPorts = {
  run,
  launch: runIsolated,
  leave,
  readText: (path) => readFile(path, "utf8"),
  writeSecret: async (path, text) => {
    // A new file takes the mode, and the rename puts it in place whole: a session that reads the
    // settings meanwhile reads the old file or the new one.
    const fresh = `${path}.${process.pid}.new`;
    await writeFile(fresh, text, { mode: 0o600, flag: "wx" });
    await rename(fresh, path);
  },
  modeOf: async (path) => {
    try {
      return (await stat(path)).mode;
    } catch (error) {
      if (Error.isError(error) && "code" in error && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  },
  newSession: randomUUID,
  sleep: (ms) => Bun.sleep(ms),
};

const dispatched = await dispatch(ports, {
  ...args,
  checkout: dirname(commonDir.stdout.toString().trim()),
  env: process.env,
});

console.log(`issue:    #${dispatched.issue} ${dispatched.title}
clone:    ${dispatched.worktree}
branch:   ${dispatched.branch}
session:  ${dispatched.session}${dispatched.log === null ? "" : `\nlog:      ${dispatched.log}`}`);
