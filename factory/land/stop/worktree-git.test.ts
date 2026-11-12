import { describe, expect, test } from "bun:test";

import { adminIdOf, pinnedGitEnvOf, worktreeRootOf } from "./worktree-git.ts";

const CHECKOUT = "/repo";

const ROOT = "/repo/.claude/worktrees/issue-7";

describe("worktreeRootOf", () => {
  test("the worktree is the directory Dispatch made under the main checkout's worktrees, whatever lies deeper", () => {
    expect(worktreeRootOf(CHECKOUT, ROOT)).toBe(ROOT);
    expect(worktreeRootOf(CHECKOUT, `${ROOT}/factory/land`)).toBe(ROOT);
  });

  test("a directory outside the worktrees is in none: the main checkout, its worktrees' own directory, another repository", () => {
    expect(worktreeRootOf(CHECKOUT, CHECKOUT)).toBeNull();
    expect(worktreeRootOf(CHECKOUT, "/repo/.claude/worktrees")).toBeNull();
    expect(worktreeRootOf(CHECKOUT, "/repo/.claude/worktrees/")).toBeNull();
    expect(worktreeRootOf(CHECKOUT, "/repo/factory")).toBeNull();
    expect(worktreeRootOf(CHECKOUT, "/other/.claude/worktrees/issue-7")).toBeNull();
    expect(worktreeRootOf(CHECKOUT, "/repo-two/.claude/worktrees/issue-7")).toBeNull();
  });

  test("a path that climbs out of the worktrees names none", () => {
    expect(worktreeRootOf(CHECKOUT, "/repo/.claude/worktrees/../../factory")).toBeNull();
    expect(worktreeRootOf(CHECKOUT, "/repo/.claude/worktrees/./x")).toBeNull();
  });
});

describe("adminIdOf", () => {
  const dirs = [
    { id: "issue-7", gitdir: `${ROOT}/.git\n` },
    { id: "issue-8", gitdir: "/repo/.claude/worktrees/issue-8/.git\n" },
    { id: "half-made", gitdir: null },
  ];

  test("the worktree's directory in the repository is the one whose gitdir file names it", () => {
    expect(adminIdOf(dirs, ROOT)).toBe("issue-7");
    expect(adminIdOf(dirs, "/repo/.claude/worktrees/issue-8")).toBe("issue-8");
  });

  test("none names it, or its own names another directory: the hook cannot tell it", () => {
    expect(adminIdOf(dirs, "/repo/.claude/worktrees/issue-9")).toBeNull();
    expect(adminIdOf([{ id: "issue-7", gitdir: "/repo/.git\n" }], ROOT)).toBeNull();
    expect(adminIdOf([{ id: "issue-7", gitdir: `${ROOT}/sub/.git\n` }], ROOT)).toBeNull();
    expect(adminIdOf([], ROOT)).toBeNull();
  });

  test("two that name it are a file the Worker wrote: the hook cannot tell it", () => {
    expect(adminIdOf([...dirs, { id: "forged", gitdir: `${ROOT}/.git` }], ROOT)).toBeNull();
  });
});

describe("pinnedGitEnvOf", () => {
  test("git is handed the worktree's directory in the repository, the repository itself for its config and hooks, and the work tree", () => {
    expect(pinnedGitEnvOf(CHECKOUT, "issue-7", ROOT)).toEqual({
      GIT_DIR: "/repo/.git/worktrees/issue-7",
      GIT_COMMON_DIR: "/repo/.git",
      GIT_WORK_TREE: ROOT,
    });
  });
});
