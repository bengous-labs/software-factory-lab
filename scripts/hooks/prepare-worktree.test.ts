import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "../gates/fixture-env.ts";
import { hookInputOf, lsRemoteHead, originHeadTarget, planFor, STOP_FORK_FLAG } from "./prepare-worktree.ts";

const SCRIPT = join(import.meta.dir, "prepare-worktree.ts");

/** The JSON Claude Code writes on a hook's stdin, as these tests build it. */
interface HookPayload {
  readonly hook_event_name: string;
  readonly cwd: string;
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, string>>;
  readonly source?: string;
}

/** Runs the hook on `input` with no CLAUDE_PROJECT_DIR, which Claude Code never leaves unset. */
const runWithoutProjectDir = (input: HookPayload) =>
  $`bun ${SCRIPT} < ${Buffer.from(JSON.stringify(input))}`
    .env(fixtureEnv({ ...process.env, CLAUDE_PROJECT_DIR: undefined }))
    .nothrow()
    .quiet();

const preToolUse = (tool: string, toolInput: Record<string, string> = {}, cwd = "/repo") =>
  hookInputOf(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, cwd }));

describe("hookInputOf", () => {
  test("reads a PreToolUse call's tool, isolation and file, and a SessionStart's cwd", () => {
    expect(preToolUse("Agent", { prompt: "p", isolation: "worktree" })).toEqual({
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "Agent",
      tool_input: { isolation: "worktree" },
    });
    expect(hookInputOf(JSON.stringify({ hook_event_name: "SessionStart", cwd: "/repo", source: "startup" }))).toEqual({
      hook_event_name: "SessionStart",
      cwd: "/repo",
    });
  });

  test("refuses an input of another event, or one that does not read", () => {
    expect(() => hookInputOf("null")).toThrow("the hook input");
    expect(() => hookInputOf(JSON.stringify({ hook_event_name: "Stop", cwd: "/repo" }))).toThrow("the hook input");
  });
});

describe("planFor", () => {
  test("requires origin/HEAD in sync before a call that creates a worktree, and advises it at SessionStart", () => {
    expect(planFor(preToolUse("EnterWorktree", { name: "w" }))).toEqual({
      syncOriginHead: "require",
      installFrom: null,
    });
    expect(planFor(preToolUse("Agent", { isolation: "worktree" }))).toEqual({
      syncOriginHead: "require",
      installFrom: null,
    });
    expect(planFor(hookInputOf(JSON.stringify({ hook_event_name: "SessionStart", cwd: "/repo" })))).toEqual({
      syncOriginHead: "advise",
      installFrom: null,
    });
  });

  test("installs where the call works: Bash in its cwd, Edit and Write in the file's directory", () => {
    expect(planFor(preToolUse("Bash", { command: "ls" }))).toEqual({ syncOriginHead: "none", installFrom: "/repo" });
    expect(planFor(preToolUse("Write", { file_path: "/repo/.claude/worktrees/w/a.ts" }))).toEqual({
      syncOriginHead: "none",
      installFrom: "/repo/.claude/worktrees/w",
    });
    expect(planFor(preToolUse("Edit", {}))).toEqual({ syncOriginHead: "none", installFrom: "/repo" });
  });

  test("does nothing for a subagent in the session's checkout, a remote one, or another tool", () => {
    const nothing = { syncOriginHead: "none", installFrom: null } as const;

    expect(planFor(preToolUse("Agent", {}))).toEqual(nothing);
    expect(planFor(preToolUse("Agent", { isolation: "remote" }))).toEqual(nothing);
    expect(planFor(preToolUse("Read", { file_path: "/repo/a.ts" }))).toEqual(nothing);
  });
});

describe("originHeadTarget", () => {
  test("names the remote-tracking ref of the branch the remote's HEAD points at", () => {
    expect(originHeadTarget("ref: refs/heads/dev\tHEAD\nabc123\tHEAD\n")).toBe("refs/remotes/origin/dev");
  });

  test("none when the output names no branch", () => {
    expect(originHeadTarget("")).toBeNull();
    expect(originHeadTarget("abc123\tHEAD\n")).toBeNull();
  });
});

describe("the hook", () => {
  const env = fixtureEnv(process.env);
  let lab = "";
  let clone = "";

  /** Runs the hook on `input`, as Claude Code does for the project at `clone`. */
  const runHook = (input: HookPayload, extra: Record<string, string> = {}) =>
    $`bun ${SCRIPT} < ${Buffer.from(JSON.stringify(input))}`
      .env({ ...env, CLAUDE_PROJECT_DIR: clone, ...extra })
      .nothrow()
      .quiet();

  const originHead = async () =>
    (await $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(clone).env(env).quiet()).stdout.toString().trim();

  const staleOriginHead = () => $`git remote set-head origin main`.cwd(clone).env(env).quiet();

  beforeAll(async () => {
    lab = mkdtempSync(join(tmpdir(), "prepare-worktree-"));
    clone = join(lab, "clone");

    const seed = join(lab, "seed");

    await $`git init -q --bare -b dev remote.git`.cwd(lab).env(env).quiet();
    await $`git clone -q remote.git seed`.cwd(lab).env(env).quiet();
    await $`git -c user.name=t -c user.email=t@t.test commit -q --allow-empty -m dev`.cwd(seed).env(env).quiet();
    await $`git push -q origin HEAD:dev HEAD:main`.cwd(seed).env(env).quiet();
    await $`git clone -q remote.git clone`.cwd(lab).env(env).quiet();

    mkdirSync(join(clone, "dep"));
    writeFileSync(join(clone, "dep", "package.json"), '{ "name": "dep", "version": "1.0.0" }\n');
    writeFileSync(join(clone, "package.json"), '{ "name": "fixture", "dependencies": { "dep": "file:./dep" } }\n');
    await $`bun install`.cwd(clone).quiet();
    rmSync(join(clone, "node_modules"), { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(lab, { recursive: true, force: true });
  });

  test("before EnterWorktree and at SessionStart, points a stale origin/HEAD at the remote's default branch", async () => {
    for (const input of [
      { hook_event_name: "PreToolUse", tool_name: "EnterWorktree", tool_input: { name: "w" }, cwd: clone },
      { hook_event_name: "SessionStart", cwd: clone, source: "startup" },
    ]) {
      await staleOriginHead();

      const ran = await runHook(input);

      expect(ran.exitCode).toBe(0);
      expect(ran.stderr.toString()).toBe("");
      expect(await originHead()).toBe("refs/remotes/origin/dev");
    }
  });

  test("before an Edit, installs the dependencies in the edited file's checkout, and repairs a cut-off install", async () => {
    const edit = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(clone, "a.ts") } };

    expect((await runHook({ ...edit, cwd: lab })).exitCode).toBe(0);
    expect(existsSync(join(clone, "node_modules", "dep", "package.json"))).toBe(true);

    rmSync(join(clone, "node_modules", "dep"), { recursive: true, force: true });

    expect((await runHook({ ...edit, cwd: lab })).exitCode).toBe(0);
    expect(existsSync(join(clone, "node_modules", "dep", "package.json"))).toBe(true);
  });

  test("does nothing in a checkout of another repository, outside any, or in a Stop hook fork", async () => {
    const other = join(lab, "other");

    await $`git init -q ${other}`.env(env).quiet();
    writeFileSync(join(other, "package.json"), '{ "name": "other" }\n');
    writeFileSync(join(other, "bun.lock"), "");

    for (const cwd of [other, lab]) {
      const ran = await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd });

      expect(ran.exitCode).toBe(0);
      expect(existsSync(join(cwd, "node_modules"))).toBe(false);
    }

    await staleOriginHead();

    const fork = await runHook(
      { hook_event_name: "PreToolUse", tool_name: "EnterWorktree", tool_input: {}, cwd: clone },
      { [STOP_FORK_FLAG]: "1" },
    );

    expect(fork.exitCode).toBe(0);
    expect(await originHead()).toBe("refs/remotes/origin/main");
  });

  test("reports a failed install with exit 1, which does not refuse the call", async () => {
    writeFileSync(
      join(clone, "package.json"),
      '{ "name": "fixture", "dependencies": { "dep": "file:./dep", "absent": "file:./absent" } }\n',
    );

    const ran = await runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: clone });

    expect(ran.exitCode).toBe(1);
    expect(ran.stderr.toString()).toContain(
      "prepare-worktree: `bun install --frozen-lockfile --ignore-scripts` failed",
    );
  });

  test("refuses a worktree creation with exit 2 when origin/HEAD cannot be synced, and only reports it at SessionStart", async () => {
    await $`git remote set-url origin ${join(lab, "gone.git")}`.cwd(clone).env(env).quiet();

    const create = await runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { isolation: "worktree" },
      cwd: clone,
    });

    const start = await runHook({ hook_event_name: "SessionStart", cwd: clone });

    expect(create.exitCode).toBe(2);
    expect(create.stderr.toString()).toContain("prepare-worktree: origin/HEAD may be stale");
    expect(start.exitCode).toBe(1);
  });

  test("refuses with exit 2 an input it cannot read, since exit 1 would let the call run", async () => {
    const ran = await $`bun ${SCRIPT} < ${Buffer.from("not json")}`
      .env({ ...env, CLAUDE_PROJECT_DIR: clone })
      .nothrow()
      .quiet();

    expect(ran.exitCode).toBe(2);
    expect(ran.stderr.toString()).toContain("prepare-worktree could not read its input, so it refuses the call");
  });

  test("without CLAUDE_PROJECT_DIR, refuses a worktree creation with exit 2 and only reports before Bash", async () => {
    const create = await runWithoutProjectDir({
      hook_event_name: "PreToolUse",
      tool_name: "EnterWorktree",
      tool_input: {},
      cwd: clone,
    });

    const bash = await runWithoutProjectDir({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {},
      cwd: clone,
    });

    expect(create.exitCode).toBe(2);
    expect(create.stderr.toString()).toContain("CLAUDE_PROJECT_DIR is not set");
    expect(bash.exitCode).toBe(1);
  });
});

describe("lsRemoteHead", () => {
  const env = fixtureEnv(process.env);
  let lab = "";

  beforeAll(async () => {
    lab = mkdtempSync(join(tmpdir(), "ls-remote-head-"));
    await $`git init -q --bare -b dev remote.git`.cwd(lab).env(env).quiet();
    await $`git init -q answering`.cwd(lab).env(env).quiet();
    await $`git remote add origin ${join(lab, "remote.git")}`.cwd(join(lab, "answering")).env(env).quiet();
    await $`git init -q silent`.cwd(lab).env(env).quiet();
    await $`git remote add origin ${"ext::sleep 5"}`.cwd(join(lab, "silent")).env(env).quiet();
    await $`git config protocol.ext.allow always`.cwd(join(lab, "silent")).env(env).quiet();
  });

  afterAll(() => {
    rmSync(lab, { recursive: true, force: true });
  });

  test("prints the remote's HEAD for a remote that answers", async () => {
    const seed = join(lab, "seed");

    await $`git clone -q ${join(lab, "remote.git")} ${seed}`.env(env).quiet();
    await $`git -c user.name=t -c user.email=t@t.test commit -q --allow-empty -m dev`.cwd(seed).env(env).quiet();
    await $`git push -q origin HEAD:dev`.cwd(seed).env(env).quiet();

    const head = await lsRemoteHead(join(lab, "answering"), 5000);

    expect(head.failure).toBeNull();
    expect(originHeadTarget(head.stdout)).toBe("refs/remotes/origin/dev");
  });

  test("gives up on a silent remote past its timeout, without waiting for it", async () => {
    const started = performance.now();
    const head = await lsRemoteHead(join(lab, "silent"), 300);

    expect(head.failure).toBe("`git ls-remote --symref origin HEAD` timed out after 300 ms");
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
