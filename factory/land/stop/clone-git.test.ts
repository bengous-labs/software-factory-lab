import { describe, expect, test } from "bun:test";

import { pinnedGitEnvOf } from "./clone-git.ts";

const ROOT = "/home/me/clones/issue-7";

describe("pinnedGitEnvOf", () => {
  test("git is handed the clone's own git directory, for its config and its hooks too, and the clone as its work tree", () => {
    expect(pinnedGitEnvOf(ROOT)).toEqual({
      GIT_DIR: "/home/me/clones/issue-7/.git",
      GIT_COMMON_DIR: "/home/me/clones/issue-7/.git",
      GIT_WORK_TREE: ROOT,
    });
  });
});
