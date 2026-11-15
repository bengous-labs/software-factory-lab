import { describe, expect, test } from "bun:test";

import { cloneRootOf, pinnedGitEnvOf } from "./clone-git.ts";

const CLONES = "/home/me/clones";

const ROOT = "/home/me/clones/issue-7";

describe("cloneRootOf", () => {
  test("the clone is the directory Dispatch made under the clones' own, whatever lies deeper", () => {
    expect(cloneRootOf(CLONES, ROOT)).toBe(ROOT);
    expect(cloneRootOf(CLONES, `${ROOT}/factory/land`)).toBe(ROOT);
  });

  test("a directory outside the clones is in none: their own directory, the home, one whose name starts the same", () => {
    expect(cloneRootOf(CLONES, CLONES)).toBeNull();
    expect(cloneRootOf(CLONES, `${CLONES}/`)).toBeNull();
    expect(cloneRootOf(CLONES, "/home/me")).toBeNull();
    expect(cloneRootOf(CLONES, "/home/me/clones-two/issue-7")).toBeNull();
    expect(cloneRootOf(CLONES, "/repo/.claude/worktrees/issue-7")).toBeNull();
  });

  test("a path that climbs out of the clones names none", () => {
    expect(cloneRootOf(CLONES, `${CLONES}/../.ssh`)).toBeNull();
    expect(cloneRootOf(CLONES, `${CLONES}/./x`)).toBeNull();
  });
});

describe("pinnedGitEnvOf", () => {
  test("git is handed the clone's own git directory, for its config and its hooks too, and the clone as its work tree", () => {
    expect(pinnedGitEnvOf(ROOT)).toEqual({
      GIT_DIR: "/home/me/clones/issue-7/.git",
      GIT_COMMON_DIR: "/home/me/clones/issue-7/.git",
      GIT_WORK_TREE: ROOT,
    });
  });
});
