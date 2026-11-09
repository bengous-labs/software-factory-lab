#!/usr/bin/env bun

/**
 * The hook that keeps a worktree as ready as the main checkout, on SessionStart and PreToolUse.
 *
 * It points `origin/HEAD` at the remote's default branch, from which Claude Code branches a `fresh`
 * worktree and which its own fetch never moves: at SessionStart, where a failure only reports, and before
 * a call that creates a worktree, EnterWorktree with no `path` or an Agent call with `isolation: worktree`,
 * where any failure refuses the call with exit 2: a remote silent past twenty seconds, whose whole process
 * group is then killed, an unreadable input, or no checkout at `$CLAUDE_PROJECT_DIR`. An Agent call whose
 * definition sets the isolation names none, so its worktree relies on the SessionStart sync; a
 * `claude --worktree` session creates its worktree before any hook runs. An unreadable input for any other
 * tool only reports, with exit 1, so the session keeps the commands that would fix the hook.
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
      path: Schema.optionalKey(Schema.String),
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

  // EnterWorktree with a `path` switches into an existing worktree: it creates none and branches from no base.
  if (
    (tool === "EnterWorktree" && toolInput.path === undefined) ||
    (tool === "Agent" && toolInput.isolation === "worktree")
  ) {
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

/** The tool name of an input, read alone, so a call whose input the full decode refuses still has a name. */
const NamedTool = Schema.Struct({ tool_name: Schema.String });

/** The tools whose call may create a worktree. */
const CREATING_TOOLS = new Set(["EnterWorktree", "Agent"]);

/**
 * The exit code for an input the hook cannot read: 2 when it names a tool that may create a worktree, so
 * that call is refused; else 1, which lets a Bash, Edit or Write call run, so a changed input never locks
 * the session out of the commands that would fix the hook.
 */
export function unreadableCode(stdin: string): 1 | 2 {
  try {
    return CREATING_TOOLS.has(decodeJson(NamedTool, "the hook input", stdin).tool_name) ? 2 : 1;
  } catch {
    // An input that names no tool cannot be told to be a worktree creation.
    return 1;
  }
}

/** Whether `origin/HEAD` ends at `target` after a write that exited `writeExit` and a re-read that found `reread`. */
export function syncedAfterWrite(writeExit: number, reread: string | null, target: string): boolean {
  // Two worktree creations at once may race on the ref's lock: the loser finds the winner's same target.
  return writeExit === 0 || reread === target;
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

/** How long the hook waits on the remote, well below the hook's own timeout, past which Claude Code runs the call. */
const LS_REMOTE_TIMEOUT_MS = 20_000;

/** What `git ls-remote --symref origin HEAD` printed, or why it printed nothing usable. */
export interface RemoteHead {
  readonly stdout: string;
  readonly failure: string | null;
}

/**
 * Runs `git ls-remote --symref origin HEAD` in `root`, never waiting on a prompt. Past `timeoutMs` it kills
 * git's whole process group: git runs in its own session, so its transport (ssh, an ext:: command) dies
 * with it, and no terminal is left to prompt on.
 */
export async function lsRemoteHead(root: string, timeoutMs: number): Promise<RemoteHead> {
  const proc = Bun.spawn(["git", "ls-remote", "--symref", "origin", "HEAD"], {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (error) {
      // ESRCH: the group ended between the timer firing and the kill.
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
  }, timeoutMs);

  const code = await proc.exited;

  clearTimeout(timer);

  // Only the timer kills git; its pipes stay unread, since a transport it spawned may still hold them.
  if (proc.signalCode !== null) {
    return { stdout: "", failure: `\`git ls-remote --symref origin HEAD\` timed out after ${timeoutMs} ms` };
  }

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

  return { stdout, failure: code === 0 ? null : `\`git ls-remote --symref origin HEAD\` failed: ${stderr.trim()}` };
}

/** Points `origin/HEAD` in `root` at the remote's default branch; returns why it could not, or null. */
async function syncOriginHead(root: string): Promise<string | null> {
  const remote = await lsRemoteHead(root, LS_REMOTE_TIMEOUT_MS);
  const target = originHeadTarget(remote.stdout);

  if (remote.failure !== null || target === null) {
    return remote.failure ?? "`git ls-remote --symref origin HEAD` named no default branch";
  }

  if ((await originHeadIn(root)) === target) {
    return null;
  }

  const set = await $`git symbolic-ref refs/remotes/origin/HEAD ${target}`.cwd(root).nothrow().quiet();

  return syncedAfterWrite(set.exitCode, set.exitCode === 0 ? target : await originHeadIn(root), target)
    ? null
    : `\`git symbolic-ref refs/remotes/origin/HEAD ${target}\` failed: ${set.stderr.toString().trim()}`;
}

/** Runs the hook on `input` in the environment `env`. */
async function prepare(input: HookInput, env: Readonly<Partial<Record<string, string>>>): Promise<HookRun> {
  const plan = planFor(input);

  if (env[STOP_FORK_FLAG] === "1" || (plan.syncOriginHead === "none" && plan.installFrom === null)) {
    return DONE;
  }

  const projectDir = projectDirOf(env);
  const project = await checkoutOf(projectDir);

  if (project === null) {
    return plan.syncOriginHead === "require"
      ? {
          code: 2,
          stderr: `prepare-worktree: git reads no checkout at ${projectDir}, so origin/HEAD cannot be checked.`,
        }
      : DONE;
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

/**
 * The hook's outcome on `stdin`. Claude Code runs the call when a hook throws, so a failure before a
 * worktree creation exits 2, an input it cannot read included; any other failure only reports.
 */
async function outcomeOf(stdin: string, env: Readonly<Partial<Record<string, string>>>): Promise<HookRun> {
  let input: HookInput;

  try {
    input = hookInputOf(stdin);
  } catch (error) {
    return { code: unreadableCode(stdin), stderr: `prepare-worktree could not read its input. ${String(error)}` };
  }

  try {
    return await prepare(input, env);
  } catch (error) {
    return { code: planFor(input).syncOriginHead === "require" ? 2 : 1, stderr: `prepare-worktree: ${String(error)}` };
  }
}

if (import.meta.main) {
  const run = await outcomeOf(await Bun.stdin.text(), process.env);

  if (run.stderr !== "") {
    console.error(run.stderr);
  }

  process.exitCode = run.code;
}
