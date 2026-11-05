import { describe, expect, test } from "bun:test";

import { admit, afterGates, answerOf, armReason, decide, type Snapshot } from "./decide.ts";

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
  test("a clean branch with commits dev lacks runs the gates", () => {
    expect(admit(SNAPSHOT)).toEqual({ kind: "gates" });
  });

  test("nothing is published from a fork, a detached HEAD, an ignored branch, a dirty tree, or no new commit", () => {
    const cases: [Partial<Snapshot>, string][] = [
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

  test("a draft PR, or a ready one behind this head, runs the gates again", () => {
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: true, headSha: HEAD } })).toEqual({ kind: "gates" });
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: false, headSha: "b".repeat(40) } })).toEqual({
      kind: "gates",
    });
  });
});

describe("afterGates", () => {
  test("green gates ask the Done judge", () => {
    expect(afterGates({ kind: "green" }, false)).toEqual({ kind: "ask-done-judge" });
  });

  test("red gates block once with their report, then let the session end", () => {
    const red = { kind: "red", report: "1 fail" } as const;
    const first = afterGates(red, false);

    expect(first.kind).toBe("block");
    expect(first.kind === "block" && first.reason).toContain("1 fail");
    expect(afterGates(red, true).kind).toBe("none");
  });
});

describe("answerOf", () => {
  test("YES first is yes; NO, a hedge, an empty or a lower-case answer is no", () => {
    const cases: [string, "yes" | "no"][] = [
      ["YES, the task is done and tested.", "yes"],
      ["  **YES** done", "yes"],
      ["NO: I asked the user which file to change.", "no"],
      ["I think YES", "no"],
      ["yes", "no"],
      ["", "no"],
      ["YESTERDAY", "no"],
    ];

    for (const [text, answer] of cases) expect(answerOf(text)).toBe(answer);
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
  test("names the PR, the PR watch command and the thread command, and asks for no question", () => {
    const reason = armReason(12, "bun /r/scripts/land-loop/pr-watch.ts 12", "bun /r/scripts/land-loop/thread.ts");

    expect(reason).toContain("PR #12 is ready");
    expect(reason).toContain("    bun /r/scripts/land-loop/pr-watch.ts 12");
    expect(reason).toContain('`bun /r/scripts/land-loop/thread.ts <thread-id> "Fixed in <sha>: <what changed>"`');
    expect(reason).toContain('`bun /r/scripts/land-loop/thread.ts <thread-id> "<your reason>"`');
    expect(reason).toContain("Nit and Pre-existing findings never block");
    expect(reason).toContain("Never ask the user a question");
  });
});
