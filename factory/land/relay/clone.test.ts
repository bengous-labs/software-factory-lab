import { describe, expect, test } from "bun:test";

import { endReasonOf, keptWhyOf, removableCloneOf, uncommittedOf } from "./clone.ts";

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

describe("keptWhyOf", () => {
  const unused = { running: false, relays: [], unpushed: 0, uncommitted: 0 };

  test("a clone nothing uses goes", () => {
    expect(keptWhyOf(CLONE, unused)).toBeNull();
  });

  test("a turn still running there, another relay's session, or a commit never pushed keeps it, and says which", () => {
    expect(keptWhyOf(CLONE, { ...unused, running: true })).toBe(
      `its clone ${CLONE} stays, as a turn of its session still runs there`,
    );
    expect(keptWhyOf(CLONE, { ...unused, relays: [8, 9] })).toBe(
      `its clone ${CLONE} stays, as the relay of #8, #9 resumes a session there`,
    );
    expect(keptWhyOf(CLONE, { ...unused, unpushed: 2 })).toBe(
      `its clone ${CLONE} stays, as it holds 2 commit(s) no remote branch holds`,
    );
    expect(keptWhyOf(CLONE, { ...unused, uncommitted: 4 })).toBe(
      `its clone ${CLONE} stays, as it holds 4 uncommitted file(s) or stash(es)`,
    );
  });
});

describe("uncommittedOf", () => {
  test("a clean tree with no stash holds nothing uncommitted", () => {
    expect(uncommittedOf("")).toBe(0);
    expect(uncommittedOf("# branch.oid abc\n# branch.head x\n")).toBe(0);
  });

  test("each changed or new file counts one, and the stash header its stashes", () => {
    expect(uncommittedOf("# stash 2\n1 .M N... 100644 100644 100644 a b app/a.ts\n? c.ts\n")).toBe(4);
    expect(uncommittedOf("? c.ts\n")).toBe(1);
    expect(uncommittedOf("# stash 1\n")).toBe(1);
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
