import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { fixtureEnv } from "../gates/fixture-env.ts";
import { cwdOf } from "./install-deps.ts";

const SCRIPT = join(import.meta.dir, "install-deps.ts");

describe("cwdOf", () => {
  test("reads the cwd of any of the three events", () => {
    for (const event of ["SessionStart", "SubagentStart", "PostToolUse"]) {
      expect(cwdOf(JSON.stringify({ hook_event_name: event, cwd: "/repo/.claude/worktrees/w" }))).toBe(
        "/repo/.claude/worktrees/w",
      );
    }
  });

  test("refuses an input with no cwd", () => {
    expect(() => cwdOf(JSON.stringify({ hook_event_name: "SessionStart" }))).toThrow('Missing key\n  at ["cwd"]');
  });
});

describe("the hook", () => {
  const env = fixtureEnv(process.env);
  let lab = "";
  let main = "";
  let worktree = "";

  /** Runs the hook for a session or subagent whose cwd is `cwd`, in the project at `main`. */
  const runHook = (cwd: string) =>
    $`bun ${SCRIPT} < ${Buffer.from(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "EnterWorktree", cwd }))}`
      .env({ ...env, CLAUDE_PROJECT_DIR: main })
      .nothrow()
      .quiet();

  beforeAll(async () => {
    lab = mkdtempSync(join(tmpdir(), "install-deps-"));
    main = join(lab, "main");
    worktree = join(main, ".claude", "worktrees", "w");

    mkdirSync(join(main, "dep"), { recursive: true });
    writeFileSync(join(main, "dep", "package.json"), '{ "name": "dep", "version": "1.0.0" }\n');
    writeFileSync(join(main, "package.json"), '{ "name": "fixture", "dependencies": { "dep": "file:./dep" } }\n');
    writeFileSync(join(main, ".gitignore"), "node_modules\n.claude/worktrees/\n");
    await $`bun install`.cwd(main).quiet();
    await $`git init -q -b dev`.cwd(main).env(env).quiet();
    await $`git add -A`.cwd(main).env(env).quiet();
    await $`git -c user.name=t -c user.email=t@t.test commit -q -m base`.cwd(main).env(env).quiet();
    await $`git worktree add -q -b w ${worktree}`.cwd(main).env(env).quiet();
  });

  afterAll(() => {
    rmSync(lab, { recursive: true, force: true });
  });

  test("installs a new worktree's own node_modules, copied rather than hardlinked, and prints nothing", async () => {
    const ran = await runHook(worktree);
    const installed = join(worktree, "node_modules", "dep", "package.json");

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(existsSync(installed)).toBe(true);
    expect(statSync(installed).nlink).toBe(1);
  });

  test("repairs a cut-off install", async () => {
    rmSync(join(worktree, "node_modules", "dep"), { recursive: true, force: true });

    expect((await runHook(worktree)).exitCode).toBe(0);
    expect(existsSync(join(worktree, "node_modules", "dep", "package.json"))).toBe(true);
  });

  test("does nothing outside a repository, or in a checkout of another repository", async () => {
    const other = join(lab, "other");

    await $`git init -q ${other}`.env(env).quiet();
    writeFileSync(join(other, "package.json"), '{ "name": "other" }\n');
    writeFileSync(join(other, "bun.lock"), "");

    for (const cwd of [lab, other]) {
      expect((await runHook(cwd)).exitCode).toBe(0);
      expect(existsSync(join(cwd, "node_modules"))).toBe(false);
    }
  });

  test("reports a failed install with exit 1, which blocks nothing", async () => {
    writeFileSync(
      join(worktree, "package.json"),
      '{ "name": "fixture", "dependencies": { "dep": "file:./dep", "absent": "file:./absent" } }\n',
    );

    const ran = await runHook(worktree);

    expect(ran.exitCode).toBe(1);
    expect(ran.stderr.toString()).toContain("install-deps: bun install failed in");
  });
});
