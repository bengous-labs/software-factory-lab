import { describe, expect, test } from "bun:test";

import { endReasonOf, removableCloneOf } from "./clone.ts";

const CLONES = "/home/me/clones";

const CLONE = "/home/me/clones/issue-7";

describe("removableCloneOf", () => {
  test("a clone directly under the clones' directory is removed", () => {
    expect(removableCloneOf(CLONES, CLONE)).toBe(CLONE);
  });

  test("a path deeper in a clone, the clones' directory itself, or one outside it is never removed", () => {
    expect(removableCloneOf(CLONES, `${CLONE}/factory`)).toBeNull();
    expect(removableCloneOf(CLONES, CLONES)).toBeNull();
    expect(removableCloneOf(CLONES, "/home/me")).toBeNull();
    expect(removableCloneOf(CLONES, "/home/me/clones-two/issue-7")).toBeNull();
    expect(removableCloneOf(CLONES, `${CLONES}/..`)).toBeNull();
    expect(removableCloneOf(CLONES, "/repo/.claude/worktrees/issue-7")).toBeNull();
  });
});

describe("endReasonOf", () => {
  test("a PR closed without landing says so, and names no clone", () => {
    expect(endReasonOf(false, null)).toBe("the PR closed without landing");
  });

  test("a landed PR says whether its clone is removed", () => {
    expect(endReasonOf(true, null)).toBe("the PR landed");
    expect(endReasonOf(true, { removed: true, clone: CLONE })).toBe(`the PR landed: its clone ${CLONE} is removed`);
    expect(endReasonOf(true, { removed: false, why: `its clone ${CLONE} stays, as its removal failed: EACCES` })).toBe(
      `the PR landed: its clone ${CLONE} stays, as its removal failed: EACCES`,
    );
  });
});
