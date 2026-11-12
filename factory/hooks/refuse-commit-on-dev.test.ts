import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import { bashCallOf, partsOf } from "../lib/bash.ts";
import { cdTargetOf, commitDirOf, commitDirsOf, refusalFor } from "./refuse-commit-on-dev.ts";

const SCRIPT = join(import.meta.dir, "refuse-commit-on-dev.ts");

describe("bashCallOf", () => {
  test("reads tool_input.command and cwd, and an empty command when there is none", () => {
    expect(bashCallOf(JSON.stringify({ cwd: "/repo", tool_input: { command: "git status" } }))).toEqual({
      command: "git status",
      cwd: "/repo",
    });
    expect(bashCallOf(JSON.stringify({ cwd: "/repo", tool_input: {} }))).toEqual({ command: "", cwd: "/repo" });
  });

  test("refuses an input that is not a tool call's", () => {
    expect(() => bashCallOf("null")).toThrow("the PreToolUse input: Expected object");
    expect(() => bashCallOf(JSON.stringify({ tool_input: {} }))).toThrow('Missing key\n  at ["cwd"]');
  });
});

describe("partsOf", () => {
  test("cuts at operators, and keeps a quoted operator inside its word", () => {
    expect(partsOf('git add . && git commit -m "a; b" | cat\n(ls) || x & y;z')).toEqual([
      ["git", "add", "."],
      "&&",
      ["git", "commit", "-m", "a; b"],
      "|",
      ["cat"],
      ";",
      "(",
      ["ls"],
      ")",
      "||",
      ["x"],
      "&",
      ["y"],
      ";",
      ["z"],
    ]);
    expect(partsOf("git commit -m ''")).toEqual([["git", "commit", "-m", ""]]);
  });
});

describe("commitDirOf", () => {
  test("a git commit runs in cwd, or in the directory its -C options name", () => {
    expect(commitDirOf(["git", "commit", "-m", "x"], "/repo")).toBe("/repo");
    expect(commitDirOf(["git", "-C", "sub", "-C", "deeper", "commit"], "/repo")).toBe("/repo/sub/deeper");
    expect(commitDirOf(["git", "-C", "/other", "commit"], "/repo")).toBe("/other");
    expect(commitDirOf(["GIT_EDITOR=true", "git", "-c", "commit.gpgsign=false", "--no-pager", "commit"], "/r")).toBe(
      "/r",
    );
  });

  test("any other command is no commit", () => {
    expect(commitDirOf(["git", "status"], "/repo")).toBeNull();
    expect(commitDirOf(["git", "log", "commit"], "/repo")).toBeNull();
    expect(commitDirOf(["git", "-c", "commit"], "/repo")).toBeNull();
    expect(commitDirOf(["echo", "git", "commit"], "/repo")).toBeNull();
    expect(commitDirOf(["FOO=1"], "/repo")).toBeNull();
    expect(commitDirOf(["git"], "/repo")).toBeNull();
  });
});

const ENV = { REPO: "/w/repo", HOME: "/home/u" };

describe("commitDirsOf", () => {
  test("lists the directory of each commit in the command", () => {
    expect(commitDirsOf("git add . && git commit -m x; git -C ../b commit", "/w/a", ENV)).toEqual(["/w/a", "/w/b"]);
    expect(commitDirsOf('echo "git commit"', "/w/a", ENV)).toEqual([]);
  });

  test("follows a cd that && joins to the commit", () => {
    expect(commitDirsOf("cd ../b && git commit -m x", "/w/a", ENV)).toEqual(["/w/b"]);
    expect(commitDirsOf("cd /w/c && cd sub && git -C .. commit", "/w/a", ENV)).toEqual(["/w/c"]);
    expect(commitDirsOf("cd -P -- $REPO && git commit", "/w/a", ENV)).toEqual(["/w/repo"]);
  });

  test("keeps the directory a cd may have failed to leave, after ; or ||", () => {
    expect(commitDirsOf("cd /nonexistent; git commit", "/w/a", ENV)).toEqual(["/w/a", "/nonexistent"]);
    expect(commitDirsOf("cd ../b || git commit", "/w/a", ENV)).toEqual(["/w/a", "/w/b"]);
  });

  test("a cd inside a subshell, a pipeline or the background leaves the directory after it", () => {
    expect(commitDirsOf("(cd ../b && git commit); git commit", "/w/a", ENV)).toEqual(["/w/b", "/w/a"]);
    expect(commitDirsOf("cd ../b | true; git commit", "/w/a", ENV)).toEqual(["/w/a"]);
    expect(commitDirsOf("true | cd ../b; git commit", "/w/a", ENV)).toEqual(["/w/a"]);
    expect(commitDirsOf("cd ../b & git commit", "/w/a", ENV)).toEqual(["/w/a"]);
  });

  test("a cd to a target the hook cannot know leaves the directory as it was", () => {
    expect(commitDirsOf("cd - && git commit", "/w/a", ENV)).toEqual(["/w/a"]);
    expect(commitDirsOf("cd $UNSET && git commit", "/w/a", ENV)).toEqual(["/w/a"]);
  });
});

describe("cdTargetOf", () => {
  test("reads the target after the options, with ~ and $VAR expanded", () => {
    expect(cdTargetOf(["cd", "-L", "sub"], ENV)).toBe("sub");
    expect(cdTargetOf(["cd", "--", "-dir"], ENV)).toBe("-dir");
    expect(cdTargetOf(["cd", "${REPO}/x"], ENV)).toBe("/w/repo/x");
    expect(cdTargetOf(["cd", "~/repo"], ENV)).toBe(join(homedir(), "repo"));
    expect(cdTargetOf(["cd"], ENV)).toBe(homedir());
  });

  test("null for a target the hook cannot know, and for any other command", () => {
    for (const target of ["-", "$UNSET", "$(pwd)", "`pwd`", "~other", "$"]) {
      expect(cdTargetOf(["cd", target], ENV)).toBeNull();
    }

    expect(cdTargetOf(["git", "status"], ENV)).toBeNull();
  });
});

describe("refusalFor", () => {
  test("refuses dev only", () => {
    expect(refusalFor("dev")).toContain("git switch -c <branch>");
    expect(refusalFor("tooling/x")).toBeNull();
    expect(refusalFor("main")).toBeNull();
    expect(refusalFor(null)).toBeNull();
  });
});

const runHook = (command: string, cwd: string) =>
  $`bun ${SCRIPT} < ${Buffer.from(
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }),
  )}`
    .nothrow()
    .quiet();

describe("the hook", () => {
  let repo = "";

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "refuse-commit-on-dev-"));
    await $`git init -q -b dev`.cwd(repo).quiet();
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("denies a commit on dev", async () => {
    const ran = await runHook('git commit -m "work"', repo);

    expect(ran.exitCode).toBe(0);
    expect(JSON.parse(ran.stdout.toString())).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: refusalFor("dev"),
      },
    });
  });

  test("denies a commit that -C or cd sends to a checkout on dev", async () => {
    for (const command of [`git -C ${repo} commit -m work`, `cd ${repo} && git commit -m work`]) {
      const ran = await runHook(command, tmpdir());

      expect(JSON.parse(ran.stdout.toString())).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    }
  });

  test("allows a commit on a feature branch, and any other command on dev", async () => {
    expect((await runHook("git status", repo)).stdout.toString()).toBe("");

    await $`git switch -q -c tooling/feature`.cwd(repo).quiet();

    const ran = await runHook('git commit -m "work"', repo);

    expect(ran.exitCode).toBe(0);
    expect(ran.stdout.toString()).toBe("");
    expect(ran.stderr.toString()).toBe("");
  });

  test("allows a commit outside a repository, or in a directory that does not exist", async () => {
    for (const command of ["git commit -m work", `git -C ${join(repo, "missing")} commit -m work`]) {
      const ran = await runHook(command, tmpdir());

      expect(ran.exitCode).toBe(0);
      expect(ran.stdout.toString()).toBe("");
      expect(ran.stderr.toString()).toBe("");
    }
  });
});
