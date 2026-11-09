#!/usr/bin/env bun

/**
 * The hook that keeps a worktree as ready as the main checkout, on SessionStart and PreToolUse.
 *
 * At SessionStart, and before Claude creates a worktree (EnterWorktree, or an Agent call with
 * `isolation: worktree`), it points `origin/HEAD` at the remote's default branch: Claude Code branches a
 * `fresh` worktree from it, and its own fetch never moves it. Before a creation, a failure refuses the
 * call with exit 2, so no worktree starts from a stale base.
 *
 * Before a Bash, Edit or Write call, it runs `bun install --frozen-lockfile --ignore-scripts` in the
 * checkout the call works in, the edited file's or the cwd's, when that checkout has a `bun.lock`: bun
 * installs what is missing, a cut-off install included, and does nothing in about ten milliseconds when
 * all is in. It runs no lifecycle script.
 *
 * It acts only on a checkout of the project's own repository, and does nothing in a Stop hook fork. It
 * prints nothing; a step that fails writes why on stderr.
 *
 * Reads the hook input on stdin.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { checkoutFromRevParse, projectDirOf, trustedRoot } from "../lib/checkout.ts";
import type { Checkout } from "../lib/checkout.ts";
import { decodeJson } from "../lib/json.ts";

/** The variable the Stop hook sets on the forks it launches, whose guard forbids any write. */
export const STOP_FORK_FLAG = "LAB_STOP_FORK";

/** The two inputs this hook reads. */
const HookInput = Schema.Union([
  Schema.Struct({ hook_event_name: Schema.Literal("SessionStart"), cwd: Schema.String }),
  Schema.Struct({
    hook_event_name: Schema.Literal("PreToolUse"),
    cwd: Schema.String,
    tool_name: Schema.String,
    tool_input: Schema.Struct({
      isolation: Schema.optionalKey(Schema.String),
      file_path: Schema.optionalKey(Schema.String),
    }),
  }),
]);

type HookInput = typeof HookInput.Type;

/** The hook input on `stdin`. */
export function hookInputOf(stdin: string): HookInput {
  return decodeJson(HookInput, "the hook input", stdin);
}

/** What the hook does: point origin/HEAD at the remote's default branch, refusing the call when that fails; install from a directory. */
export interface Plan {
  readonly syncOriginHead: "none" | "advise" | "require";
  readonly installFrom: string | null;
}

/** The plan for `input`. */
export function planFor(input: HookInput): Plan {
  if (input.hook_event_name === "SessionStart") {
    return { syncOriginHead: "advise", installFrom: null };
  }

  const { tool_name: tool, tool_input: toolInput, cwd } = input;

  if (tool === "EnterWorktree" || (tool === "Agent" && toolInput.isolation === "worktree")) {
    return { syncOriginHead: "require", installFrom: null };
  }

  if (tool === "Edit" || tool === "Write") {
    return {
      syncOriginHead: "none",
      installFrom: toolInput.file_path === undefined ? cwd : dirname(toolInput.file_path),
    };
  }

  return { syncOriginHead: "none", installFrom: tool === "Bash" ? cwd : null };
}

/** The `refs/remotes/origin/<branch>` the remote's HEAD names in `git ls-remote --symref origin HEAD`, or null. */
export function originHeadTarget(lsRemote: string): string | null {
  const branch = /^ref: refs\/heads\/(?<branch>\S+)\tHEAD$/mu.exec(lsRemote)?.groups?.["branch"];

  return branch === undefined ? null : `refs/remotes/origin/${branch}`;
}

/** What the hook prints on stderr, and the code it exits with: 2 refuses a PreToolUse call, 1 only reports. */
interface HookRun {
  readonly code: 0 | 1 | 2;
  readonly stderr: string;
}

const DONE: HookRun = { code: 0, stderr: "" };

/** The checkout `dir` lies in, or null outside any repository or for a missing `dir`. */
async function checkoutOf(dir: string): Promise<Checkout | null> {
  const ran = await $`git -C ${dir} rev-parse --path-format=absolute --show-toplevel --git-common-dir`
    .nothrow()
    .quiet();

  return checkoutFromRevParse(ran.stdout.toString(), ran.exitCode);
}

/** The target of `refs/remotes/origin/HEAD` in `root`, or null when it has none. */
async function originHeadIn(root: string): Promise<string | null> {
  const ran = await $`git symbolic-ref -q refs/remotes/origin/HEAD`.cwd(root).nothrow().quiet();

  return ran.exitCode === 0 ? ran.stdout.toString().trim() : null;
}

/** Points `origin/HEAD` in `root` at the remote's default branch; returns why it could not, or null. */
async function syncOriginHead(root: string): Promise<string | null> {
  const remote = await $`git ls-remote --symref origin HEAD`.cwd(root).nothrow().quiet();
  const target = originHeadTarget(remote.stdout.toString());

  if (remote.exitCode !== 0 || target === null) {
    return `\`git ls-remote --symref origin HEAD\` named no default branch: ${remote.stderr.toString().trim()}`;
  }

  if ((await originHeadIn(root)) === target) {
    return null;
  }

  const set = await $`git symbolic-ref refs/remotes/origin/HEAD ${target}`.cwd(root).nothrow().quiet();

  // Two worktree creations at once may race on the ref's lock: the loser finds the winner's same target.
  return set.exitCode === 0 || (await originHeadIn(root)) === target
    ? null
    : `\`git symbolic-ref refs/remotes/origin/HEAD ${target}\` failed: ${set.stderr.toString().trim()}`;
}

/** Runs the hook on `input` in the environment `env`. */
async function prepare(input: HookInput, env: Readonly<Partial<Record<string, string>>>): Promise<HookRun> {
  const plan = planFor(input);

  if (env[STOP_FORK_FLAG] === "1" || (plan.syncOriginHead === "none" && plan.installFrom === null)) {
    return DONE;
  }

  const project = await checkoutOf(projectDirOf(env));

  if (project === null) {
    return DONE;
  }

  if (plan.syncOriginHead !== "none") {
    const failure = await syncOriginHead(project.root);

    if (failure !== null) {
      return {
        code: plan.syncOriginHead === "require" ? 2 : 1,
        stderr: `prepare-worktree: origin/HEAD may be stale, so a new worktree could branch from the wrong base. ${failure}`,
      };
    }
  }

  const root = plan.installFrom === null ? null : trustedRoot(await checkoutOf(plan.installFrom), project);

  if (root !== null && existsSync(join(root, "bun.lock"))) {
    const ran = await $`${process.execPath} install --frozen-lockfile --ignore-scripts`.cwd(root).nothrow().quiet();

    if (ran.exitCode !== 0) {
      return {
        code: 1,
        stderr: `prepare-worktree: \`bun install --frozen-lockfile --ignore-scripts\` failed in ${root}: ${ran.stderr.toString().trim()}`,
      };
    }
  }

  return DONE;
}

if (import.meta.main) {
  const run = await prepare(hookInputOf(await Bun.stdin.text()), process.env);

  if (run.stderr !== "") {
    console.error(run.stderr);
  }

  process.exitCode = run.code;
}
