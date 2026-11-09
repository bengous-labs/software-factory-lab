import { describe, expect, test } from "bun:test";

import { checkoutFromRevParse, projectDirOf, trustedRoot } from "./checkout.ts";

describe("checkoutFromRevParse", () => {
  test("reads the top-level directory, then the common git directory", () => {
    expect(checkoutFromRevParse("/repo/.claude/worktrees/w\n/repo/.git\n", 0)).toEqual({
      root: "/repo/.claude/worktrees/w",
      commonDir: "/repo/.git",
    });
  });

  test("none when git failed or printed less than both", () => {
    expect(checkoutFromRevParse("", 128)).toBeNull();
    expect(checkoutFromRevParse("/repo\n/repo/.git\n", 1)).toBeNull();
    expect(checkoutFromRevParse("/repo\n", 0)).toBeNull();
  });
});

describe("trustedRoot", () => {
  const main = { root: "/repo", commonDir: "/repo/.git" };
  const worktree = { root: "/repo/.claude/worktrees/w", commonDir: "/repo/.git" };
  const other = { root: "/other", commonDir: "/other/.git" };

  test("the checkout's own root, when it is a checkout of the project's repository: a worktree's, not the main one's", () => {
    expect(trustedRoot(worktree, main)).toBe("/repo/.claude/worktrees/w");
    expect(trustedRoot(main, worktree)).toBe("/repo");
    expect(trustedRoot(worktree, worktree)).toBe("/repo/.claude/worktrees/w");
  });

  test("none for a checkout of another repository, or outside any", () => {
    expect(trustedRoot(other, main)).toBeNull();
    expect(trustedRoot(null, main)).toBeNull();
    expect(trustedRoot(main, null)).toBeNull();
  });
});

describe("projectDirOf", () => {
  test("reads CLAUDE_PROJECT_DIR, and throws without it", () => {
    expect(projectDirOf({ CLAUDE_PROJECT_DIR: "/repo" })).toBe("/repo");
    expect(() => projectDirOf({})).toThrow("CLAUDE_PROJECT_DIR is not set");
  });
});
