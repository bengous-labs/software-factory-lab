import { describe, expect, test } from "bun:test";

import { AUTHOR_MARK } from "../author-mark.ts";
import {
  admit,
  afterAuthorToken,
  afterStopChecks,
  answerOf,
  armReason,
  closingLineOf,
  decide,
  holdStepsOf,
} from "./decide.ts";
import type { Answer, Snapshot } from "./decide.ts";

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
    const pr = { number: 7, draft: false, headSha: HEAD, labels: [] };

    expect(admit({ ...SNAPSHOT, pr })).toEqual({ kind: "arm", pr: 7 });
    expect(admit({ ...SNAPSHOT, pr, armed: true }).kind).toBe("none");
  });

  test("a draft PR, or a ready one behind this head, runs the Stop checks again", () => {
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: true, headSha: HEAD, labels: [] } })).toEqual({
      kind: "stop-checks",
    });
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: false, headSha: "b".repeat(40), labels: [] } })).toEqual({
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
    const cases: Array<[string, Answer]> = [
      ["YES, the task is done and tested.", { kind: "yes" }],
      ["  **YES** done", { kind: "yes" }],
      ["NO: I asked the Owner which file to change.", { kind: "no" }],
      ["I think YES", { kind: "no" }],
      ["yes", { kind: "no" }],
      ["", { kind: "no" }],
      ["YESTERDAY", { kind: "no" }],
    ];

    for (const [text, answer] of cases) {
      expect(answerOf(text)).toEqual(answer);
    }
  });

  test("YES, HOLD: on the first line is a hold with the trimmed rest of that line as its reason", () => {
    const cases: Array<[string, Answer]> = [
      [
        "YES, HOLD: renames the agent-review check, which the dev ruleset requires",
        { kind: "hold", reason: "renames the agent-review check, which the dev ruleset requires" },
      ],
      ["\n **YES,HOLD:   a stored format  \nmore text", { kind: "hold", reason: "a stored format" }],
      ["YES, HOLD:", { kind: "hold", reason: "(no reason given)" }],
      ["YES, HOLD:   \nthe reason is on the next line", { kind: "hold", reason: "(no reason given)" }],
      [`YES, HOLD: ${"r".repeat(400)}`, { kind: "hold", reason: "r".repeat(300) }],
      ["YES, HOLD:no space after the colon", { kind: "hold", reason: "no space after the colon" }],
      ["Maybe YES, HOLD: a hedge", { kind: "no" }],
      ["**YES, HOLD**: renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      ["**YES**, HOLD: renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      ["**YES, HOLD:** renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      ["__YES, HOLD__: renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      ["_YES_, HOLD: renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      ["YES, **HOLD**: renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      ["# YES, HOLD: renames a stored label", { kind: "hold", reason: "renames a stored label" }],
      [
        "YES, HOLD: changes the scripts/**/*.ts glob in layers.map.ts",
        { kind: "hold", reason: "changes the scripts/**/*.ts glob in layers.map.ts" },
      ],
      ["__YES__ done", { kind: "yes" }],
      ["# YES done", { kind: "yes" }],
      ["YESÉ", { kind: "no" }],
      ["YES7", { kind: "no" }],
      ["YES, hold: lower case", { kind: "yes" }],
      ["NO, HOLD: not finished", { kind: "no" }],
    ];

    for (const [text, answer] of cases) {
      expect(answerOf(text)).toEqual(answer);
    }
  });
});

describe("decide", () => {
  const draft = { number: 7, draft: true, headSha: HEAD, labels: [] };
  const ready = { number: 7, draft: false, headSha: HEAD, labels: [] };

  test("no from the Done judge changes nothing", () => {
    expect(decide(null, { kind: "no" }).kind).toBe("none");
    expect(decide(draft, { kind: "no" }).kind).toBe("none");
  });

  test("yes opens the PR when there is none, pushes and readies a draft, pushes a ready one", () => {
    expect(decide(null, { kind: "yes" })).toEqual({ kind: "open", hold: null });
    expect(decide(draft, { kind: "yes" })).toEqual({ kind: "push", pr: 7, ready: true, hold: null });
    expect(decide(ready, { kind: "yes" })).toEqual({ kind: "push", pr: 7, ready: false, hold: null });
  });

  test("a hold publishes as yes does, carrying its reason", () => {
    const hold: Answer = { kind: "hold", reason: "a stored format" };

    expect(decide(null, hold)).toEqual({ kind: "open", hold: "a stored format" });
    expect(decide(draft, hold)).toEqual({ kind: "push", pr: 7, ready: true, hold: "a stored format" });
    expect(decide(ready, hold)).toEqual({ kind: "push", pr: 7, ready: false, hold: "a stored format" });
  });
});

describe("holdStepsOf", () => {
  test("a hold on a PR without land:human adds the label and posts the Author's marked comment", () => {
    expect(holdStepsOf("renames the agent-review check, which the dev ruleset requires", ["enhancement"])).toEqual({
      addLabel: true,
      comment: `Held for the Owner by the Author: renames the agent-review check, which the dev ruleset requires\n\n${AUTHOR_MARK}`,
    });
    expect(holdStepsOf("(no reason given)", [])).toEqual({
      addLabel: true,
      comment: "Held for the Owner by the Author: (no reason given)\n\n<!-- lab-author-reply -->",
    });
  });

  test("no hold, or a PR that carries land:human already, adds nothing and posts nothing", () => {
    expect(holdStepsOf(null, [])).toEqual({ addLabel: false, comment: null });
    expect(holdStepsOf(null, ["land:human"])).toEqual({ addLabel: false, comment: null });
    expect(holdStepsOf("a stored format", ["land-ok", "land:human"])).toEqual({ addLabel: false, comment: null });
  });
});

describe("armReason", () => {
  test("names the PR, the PR watch, thread and comment commands, and asks for no question", () => {
    const reason = armReason(12, {
      prWatch: "bun /r/scripts/land-loop/pr-watch.ts 12",
      thread: "bun /r/scripts/land-loop/thread.ts",
      comment: "bun /r/scripts/land-loop/comment.ts 12",
    });

    expect(reason).toContain("PR #12 is ready");
    expect(reason).toContain("    bun /r/scripts/land-loop/pr-watch.ts 12");
    expect(reason).toContain('`bun /r/scripts/land-loop/thread.ts <thread-id> "Fixed in <sha>: <what changed>"`');
    expect(reason).toContain(
      '- A finding you reject: reply with your reason and resolve: `bun /r/scripts/land-loop/thread.ts <thread-id> --reject "<your reason>"`. Then stop.\n- A finding you fix in part: it is a fix; start with "Fixed in <sha>: " and name what stays as is.\n',
    );
    expect(reason).toContain('`bun /r/scripts/land-loop/comment.ts 12 "<what you decided and why>"`');
    expect(reason).toContain("never with `gh pr comment`");
    expect(reason).toContain(
      "Each line it prints is a failing check, an Important or Nit finding, a human comment, or a change of state of the PR. Judge every finding, a Nit as an Important: fix it or reject it. Pre-existing findings never block: leave them.",
    );
    expect(reason).not.toContain("Nit and Pre-existing findings never block");
    expect(reason).toContain("Never ask the Owner a question");
    expect(reason).not.toContain("held this PR");
  });

  test("with a hold, the line right after the first one says why and keeps land:human on", () => {
    const commands = { prWatch: "w", thread: "t", comment: "c" };
    const lines = armReason(12, commands, "a stored format").split("\n");

    expect(lines[0]).toStartWith("PR #12 is ready for review.");
    expect(lines[1]).toBe(
      "The Done judge held this PR for the Owner's read: a stored format. Do not remove land:human.",
    );
    expect(lines.slice(2)).toEqual(armReason(12, commands).split("\n").slice(1));
    expect(armReason(12, commands, "a stored format.").split("\n")[1]).toBe(
      "The Done judge held this PR for the Owner's read: a stored format. Do not remove land:human.",
    );
    expect(armReason(12, commands, "renames .lab/state files").split("\n")[1]).toBe(
      "The Done judge held this PR for the Owner's read: renames .lab/state files. Do not remove land:human.",
    );
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
