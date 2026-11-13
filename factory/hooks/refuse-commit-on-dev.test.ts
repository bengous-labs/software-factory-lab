import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

import {
  branchOfHead,
  cdTargetOf,
  commitDirOf,
  commitDirsOf,
  gitDirOfFile,
  refusalFor,
  unreadableRefusalOf,
} from "./refuse-commit-on-dev.ts";

const SCRIPT = join(import.meta.dir, "refuse-commit-on-dev.ts");

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

describe("branchOfHead", () => {
  test("the branch a HEAD file names, with its slashes; null on a detached HEAD or any other ref", () => {
    expect(branchOfHead("ref: refs/heads/dev\n")).toBe("dev");
    expect(branchOfHead("ref: refs/heads/issue/7-fix\n")).toBe("issue/7-fix");
    expect(branchOfHead("8f6e788a1c063565239fcf1b141ae70eb2342da1\n")).toBeNull();
    expect(branchOfHead("ref: refs/tags/dev\n")).toBeNull();
    expect(branchOfHead("")).toBeNull();
  });
});

describe("gitDirOfFile", () => {
  test("the directory a .git file names, a relative one from the checkout; null when it names none", () => {
    expect(gitDirOfFile("gitdir: /repo/.git/worktrees/x\n", "/repo/wt")).toBe("/repo/.git/worktrees/x");
    expect(gitDirOfFile("gitdir: ../.git/worktrees/x\n", "/repo/wt")).toBe("/repo/.git/worktrees/x");
    expect(gitDirOfFile("gitdir: ../.git/worktrees/x\r\n", "/repo/wt")).toBe("/repo/.git/worktrees/x");
    expect(gitDirOfFile("", "/repo/wt")).toBeNull();
    expect(gitDirOfFile("gitdir:  \n", "/repo/wt")).toBeNull();
  });
});

const runHook = (command: string, cwd: string, session: Readonly<Record<string, string>> = {}) =>
  $`bun ${SCRIPT} < ${Buffer.from(
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }),
  )}`
    .env({ ...process.env, ...session })
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

  test("denies it in an API Worker's session too, with no git to run: it reads the branch from the checkout's files", async () => {
    const bin = join(repo, "bin");

    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));

    const ran = await runHook('git commit -m "work"', repo, { LAB_API_WORKER: "1", PATH: bin });

    expect(ran.stderr.toString()).toBe("");
    expect(ran.stdout.toString()).toContain('"permissionDecision":"deny"');
  });

  test("in a linked worktree it reads the worktree's own branch, through the directory its .git file names", async () => {
    const worktree = join(repo, "wt");
    const admin = join(repo, ".git", "worktrees", "wt");

    mkdirSync(worktree);
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: ../.git/worktrees/wt\n");
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/tooling/wt\n");

    expect((await runHook("git commit -m work", join(worktree))).stdout.toString()).toBe("");
    expect((await runHook(`git -C ${repo} commit -m work`, worktree)).stdout.toString()).toContain(
      '"permissionDecision":"deny"',
    );

    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/dev\n");

    expect((await runHook("git commit -m work", worktree)).stdout.toString()).toContain('"permissionDecision":"deny"');
  });

  test("refuses a commit where it cannot read the branch: a HEAD that is a link or too large, a .git that is a link, a pipe or names nothing", async () => {
    const made = (name: string): string => {
      const dir = join(repo, name);

      mkdirSync(join(dir, ".git"), { recursive: true });

      return dir;
    };

    const linked = made("head-linked");
    writeFileSync(join(linked, ".git", "ref"), "ref: refs/heads/feature\n");
    symlinkSync("ref", join(linked, ".git", "HEAD"));

    const large = made("head-large");
    writeFileSync(join(large, ".git", "HEAD"), `ref: refs/heads/feature\n${"#".repeat(5000)}`);

    const gitLinked = join(repo, "git-linked");
    mkdirSync(gitLinked);
    symlinkSync(join(linked, ".git"), join(gitLinked, ".git"));

    const piped = join(repo, "git-piped");
    mkdirSync(piped);
    expect(Bun.spawnSync(["mkfifo", join(piped, ".git")]).exitCode).toBe(0);

    const empty = join(repo, "git-empty");
    mkdirSync(empty);
    writeFileSync(join(empty, ".git"), "not a git file\n");

    for (const dir of [linked, large, gitLinked, piped, empty]) {
      const ran = await runHook("git commit -m work", dir);

      expect(JSON.parse(ran.stdout.toString())).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: unreadableRefusalOf(dir),
        },
      });
    }

    expect((await runHook("git status", piped)).stdout.toString()).toBe("");
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
