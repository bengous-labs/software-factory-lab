import { describe, expect, test } from "bun:test";

import { admit, afterAuthorToken, afterStopChecks, answerOf, armReason, closingLineOf, decide } from "./decide.ts";
import type { Snapshot } from "./decide.ts";

const HEAD = "a".repeat(40);

const SNAPSHOT: Snapshot = {
  forkFlag: false,
  forkMarker: false,
  stopHookActive: false,
  branch: "agent/clear-command",
  head: HEAD,
  treeClean: true,
  ahead: 2,
  pr: null,
  armed: false,
};

describe("admit", () => {
  test("a clean branch with commits dev lacks runs the Stop checks", () => {
    expect(admit(SNAPSHOT)).toEqual({ kind: "stop-checks" });
  });

  test("nothing is published from a fork, a detached HEAD, an ignored branch, a dirty tree, or no new commit", () => {
    const cases: Array<[Partial<Snapshot>, string]> = [
      [{ forkFlag: true }, "a fork the hook launched"],
      [{ forkMarker: true }, "a fork, resumed"],
      [{ branch: null }, "HEAD is detached"],
      [{ branch: "dev" }, "dev is never published"],
      [{ branch: "main" }, "main is never published"],
      [{ branch: "lab/q1-docs" }, "lab/q1-docs is never published"],
      [{ ahead: 0 }, "has no commit that dev lacks"],
      [{ treeClean: false }, "uncommitted changes"],
    ];

    for (const [fields, reason] of cases) {
      const admission = admit({ ...SNAPSHOT, ...fields });

      expect(admission.kind).toBe("none");
      expect(admission.kind === "none" && admission.reason).toContain(reason);
    }
  });

  test("a ready PR at this head asks for the PR watch once, then leaves the session alone", () => {
    const pr = { number: 7, draft: false, headSha: HEAD };

    expect(admit({ ...SNAPSHOT, pr })).toEqual({ kind: "arm", pr: 7 });
    expect(admit({ ...SNAPSHOT, pr, armed: true }).kind).toBe("none");
  });

  test("a draft PR, or a ready one behind this head, runs the Stop checks again", () => {
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: true, headSha: HEAD } })).toEqual({ kind: "stop-checks" });
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: false, headSha: "b".repeat(40) } })).toEqual({
      kind: "stop-checks",
    });
  });
});

describe("afterAuthorToken", () => {
  test("a token found goes on to the Stop checks", () => {
    expect(afterAuthorToken(true, "/h/author-token", false)).toBeNull();
    expect(afterAuthorToken(true, "/h/author-token", true)).toBeNull();
  });

  test("no token blocks once, naming its path, then lets the session end with nothing published", () => {
    expect(afterAuthorToken(false, "/h/author-token", false)).toEqual({
      kind: "block",
      reason:
        "The Stop hook found no Author token at /h/author-token, so nothing was published. The Owner provisions it (AGENTS.md, Identities). Stop, and ask no question.",
    });
    expect(afterAuthorToken(false, "/h/author-token", true)).toEqual({
      kind: "none",
      reason: "no Author token after a block: nothing is published",
    });
  });
});

describe("afterStopChecks", () => {
  test("green Stop checks ask the Done judge", () => {
    expect(afterStopChecks({ kind: "green" }, false)).toEqual({ kind: "ask-done-judge" });
  });

  test("red Stop checks block once with their report, then let the session end", () => {
    const red = { kind: "red", report: "1 fail" } as const;
    const first = afterStopChecks(red, false);

    expect(first.kind).toBe("block");
    expect(first.kind === "block" && first.reason).toContain("1 fail");
    expect(afterStopChecks(red, true).kind).toBe("none");
  });
});

describe("answerOf", () => {
  test("YES first is yes; NO, a hedge, an empty or a lower-case answer is no", () => {
    const cases: Array<[string, "yes" | "no"]> = [
      ["YES, the task is done and tested.", "yes"],
      ["  **YES** done", "yes"],
      ["NO: I asked the Owner which file to change.", "no"],
      ["I think YES", "no"],
      ["yes", "no"],
      ["", "no"],
      ["YESTERDAY", "no"],
    ];

    for (const [text, answer] of cases) {
      expect(answerOf(text)).toBe(answer);
    }
  });
});

describe("decide", () => {
  test("no from the Done judge changes nothing", () => {
    expect(decide(null, "no").kind).toBe("none");
  });

  test("yes opens the PR when there is none, pushes and readies a draft, pushes a ready one", () => {
    expect(decide(null, "yes")).toEqual({ kind: "open" });
    expect(decide({ number: 7, draft: true, headSha: HEAD }, "yes")).toEqual({ kind: "push", pr: 7, ready: true });
    expect(decide({ number: 7, draft: false, headSha: HEAD }, "yes")).toEqual({ kind: "push", pr: 7, ready: false });
  });
});

describe("armReason", () => {
  test("names the PR, the PR watch, thread and comment commands, and asks for no question", () => {
    const reason = armReason(
      12,
      "bun /r/scripts/land-loop/pr-watch.ts 12",
      "bun /r/scripts/land-loop/thread.ts",
      "bun /r/scripts/land-loop/comment.ts 12",
    );

    expect(reason).toContain("PR #12 is ready");
    expect(reason).toContain("    bun /r/scripts/land-loop/pr-watch.ts 12");
    expect(reason).toContain('`bun /r/scripts/land-loop/thread.ts <thread-id> "Fixed in <sha>: <what changed>"`');
    expect(reason).toContain('`bun /r/scripts/land-loop/thread.ts <thread-id> "<your reason>"`');
    expect(reason).toContain('`bun /r/scripts/land-loop/comment.ts 12 "<what you decided and why>"`');
    expect(reason).toContain("never with `gh pr comment`");
    expect(reason).toContain("Nit and Pre-existing findings never block");
    expect(reason).toContain("Never ask the Owner a question");
  });
});

describe("closingLineOf", () => {
  test("a branch <type>/<N>-<slug> closes issue N; any other branch closes nothing", () => {
    const cases: Array<[string, string | null]> = [
      ["fix/89-patch-delta-judge", "Closes #89"],
      ["feat/48-pr-body", "Closes #48"],
      ["cc/42-x", "Closes #42"],
      ["fix/89", null],
      ["Fix/42-x", null],
      ["wave2/42-x", null],
      ["chore/tidy-docs", null],
      ["worktree-abc", null],
      ["x/fix/42-y", null],
    ];

    for (const [branch, line] of cases) {
      expect(closingLineOf(branch, "Body.")).toBe(line);
    }
  });

  test("a body that closes the issue already gets no line, whatever the keyword and its case", () => {
    for (const keyword of ["close", "Closes", "closed", "FIX", "fixes", "fixed", "resolve", "Resolves", "resolved"]) {
      expect(closingLineOf("fix/89-x", `Why.\n\n${keyword} #89`)).toBeNull();
    }
  });

  test("a keyword for another issue, or no keyword before the number, still gets the line", () => {
    expect(closingLineOf("fix/89-x", "Closes #8")).toBe("Closes #89");
    expect(closingLineOf("fix/89-x", "Closes #890")).toBe("Closes #89");
    expect(closingLineOf("fix/89-x", "Closes #12, see #89")).toBe("Closes #89");
    expect(closingLineOf("fix/89-x", "encloses #89")).toBe("Closes #89");
    expect(closingLineOf("fix/89-x", "")).toBe("Closes #89");
  });
});
