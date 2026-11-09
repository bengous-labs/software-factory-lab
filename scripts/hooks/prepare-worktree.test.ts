import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "../gates/fixture-env.ts";
import { stepsFor, toolCallOf } from "./prepare-worktree.ts";

const SCRIPT = join(import.meta.dir, "prepare-worktree.ts");

const READY = { lockfile: true, installed: true };

const BARE = { lockfile: true, installed: false };

describe("toolCallOf", () => {
  test("reads the tool, its isolation when it has one, and cwd", () => {
    expect(
      toolCallOf(JSON.stringify({ cwd: "/r", tool_name: "Agent", tool_input: { prompt: "p", isolation: "worktree" } })),
    ).toEqual({ cwd: "/r", tool_name: "Agent", tool_input: { isolation: "worktree" } });
    expect(toolCallOf(JSON.stringify({ cwd: "/r", tool_name: "Bash", tool_input: { command: "ls" } }))).toEqual({
      cwd: "/r",
      tool_name: "Bash",
      tool_input: {},
    });
  });

  test("refuses an input that is not a tool call's", () => {
    expect(() => toolCallOf("null")).toThrow("the PreToolUse input: Expected object");
    expect(() => toolCallOf(JSON.stringify({ tool_name: "Bash", tool_input: {} }))).toThrow(
      'Missing key\n  at ["cwd"]',
    );
  });
});

describe("stepsFor", () => {
  test("points origin/HEAD at the remote's default branch before a call that creates a worktree", () => {
    expect(stepsFor("EnterWorktree", undefined, READY)).toEqual({ syncOriginHead: true, install: false });
    expect(stepsFor("Agent", "worktree", READY)).toEqual({ syncOriginHead: true, install: false });
  });

  test("leaves origin/HEAD alone for a subagent in the session's checkout, or a remote one", () => {
    expect(stepsFor("Agent", undefined, READY).syncOriginHead).toBe(false);
    expect(stepsFor("Agent", "remote", READY).syncOriginHead).toBe(false);
  });

  test("installs before Bash, Edit or Write in a checkout with a lockfile and no node_modules", () => {
    for (const tool of ["Bash", "Edit", "Write"]) {
      expect(stepsFor(tool, undefined, BARE)).toEqual({ syncOriginHead: false, install: true });
    }
  });

  test("installs nothing where the dependencies are in, where there is no lockfile, or before another tool", () => {
    expect(stepsFor("Bash", undefined, READY).install).toBe(false);
    expect(stepsFor("Edit", undefined, { lockfile: false, installed: false }).install).toBe(false);
    expect(stepsFor("Read", undefined, BARE).install).toBe(false);
    expect(stepsFor("EnterWorktree", undefined, BARE).install).toBe(false);
  });
});

const runHook = (tool: string, cwd: string, toolInput: Record<string, string> = {}) =>
  $`bun ${SCRIPT} < ${Buffer.from(
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, cwd }),
  )}`
    .env(fixtureEnv(process.env))
    .nothrow()
    .quiet();

describe("the hook", () => {
  const env = fixtureEnv(process.env);
  let lab = "";
  let clone = "";

  beforeAll(async () => {
    lab = mkdtempSync(join(tmpdir(), "prepare-worktree-"));
    clone = join(lab, "clone");

    const seed = join(lab, "seed");

    const commit = (message: string) =>
      $`git -c user.name=t -c user.email=t@t.test commit -q --allow-empty -m ${message}`.cwd(seed).env(env).quiet();

    await $`git init -q --bare -b dev remote.git`.cwd(lab).env(env).quiet();
    await $`git clone -q remote.git seed`.cwd(lab).env(env).quiet();
    await commit("dev");
    await $`git push -q origin HEAD:dev HEAD:main`.cwd(seed).env(env).quiet();
    await $`git clone -q remote.git clone`.cwd(lab).env(env).quiet();
    await $`git remote set-head origin main`.cwd(clone).env(env).quiet();

    mkdirSync(join(clone, "dep"));
    writeFileSync(join(clone, "dep", "package.json"), '{ "name": "dep", "version": "1.0.0" }\n');
    writeFileSync(join(clone, "package.json"), '{ "name": "fixture", "dependencies": { "dep": "file:./dep" } }\n');
    await $`bun install`.cwd(clone).quiet();
    rmSync(join(clone, "node_modules"), { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(lab, { recursive: true, force: true });
  });

  test("before EnterWorktree, points a stale origin/HEAD at the remote's default branch, and prints nothing", async () => {
    const ran = await runHook("EnterWorktree", clone, { name: "w" });
    const head = await $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(clone).env(env).quiet();

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(head.stdout.toString().trim()).toBe("refs/remotes/origin/dev");
  });

  test("before a Write in a checkout with no node_modules, installs the dependencies from the lockfile", async () => {
    const ran = await runHook("Write", join(clone, "dep"), { file_path: join(clone, "a.ts") });

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(existsSync(join(clone, "node_modules", "dep", "package.json"))).toBe(true);
  });

  test("throws, naming the command, when a step fails", async () => {
    await $`git remote remove origin`.cwd(clone).env(env).quiet();

    const ran = await runHook("Agent", clone, { isolation: "worktree" });

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain("prepare-worktree: `git remote set-head origin --auto`");
  });
});
