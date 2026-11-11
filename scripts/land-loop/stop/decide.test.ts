import { describe, expect, test } from "bun:test";

import { AUTHOR_MARK, QUESTION_MARK, REJECT_MARK } from "../author-mark.ts";
import { AUTHOR_LOGIN, OWNER_LOGIN } from "../logins.ts";
import {
  admit,
  afterClosed,
  afterStopChecks,
  byOwner,
  bystanderOf,
  chainOf,
  checkoutOf,
  closingLineOf,
  decide,
  DONE_SCHEMA,
  doneAnswerOf,
  noAuthorToken,
  noDoneAnswer,
  outcomeLineOf,
  questionCommentOf,
  questionOpen,
  quotedQuestionOf,
  rejectionReplyOf,
  rejectionsOf,
} from "./decide.ts";
import type { Admission, DoneAnswer, Snapshot } from "./decide.ts";

const HEAD = "a".repeat(40);

const SNAPSHOT: Snapshot = {
  branch: "agent/clear-command",
  head: HEAD,
  treeClean: true,
  ahead: 2,
  pr: null,
};

const FINISHED: DoneAnswer = { finished: true, question: "", reason: "done and tested", rejections: [] };

describe("bystanderOf", () => {
  test("a session whose environment holds LAB_AUTHOR=1, and is no fork, is an Author", () => {
    expect(bystanderOf({ author: true, forkFlag: false, forkMarker: false })).toBeNull();
  });

  test("a session without the marker is left alone, whatever its branch", () => {
    expect(bystanderOf({ author: false, forkFlag: false, forkMarker: false })).toBe(
      "this session is not an Author: its environment holds no LAB_AUTHOR=1",
    );
  });

  test("a fork is left alone though it inherits the Author's marker", () => {
    expect(bystanderOf({ author: true, forkFlag: true, forkMarker: false })).toBe(
      "this session is a fork the hook launched",
    );
    expect(bystanderOf({ author: true, forkFlag: false, forkMarker: true })).toBe("this session is a fork, resumed");
    expect(bystanderOf({ author: false, forkFlag: true, forkMarker: true })).toBe(
      "this session is a fork the hook launched",
    );
  });
});

describe("checkoutOf", () => {
  test("a branch checked out in a worktree of its own may be published", () => {
    expect(checkoutOf({ mainCheckout: false, branch: "feat/1-x" })).toEqual({
      kind: "publishable",
      branch: "feat/1-x",
    });
  });

  test("nothing is published from a detached HEAD, an ignored branch, or the main checkout", () => {
    const cases: Array<[boolean, string | null, string]> = [
      [false, null, "HEAD is detached"],
      [false, "dev", "dev is never published"],
      [false, "main", "main is never published"],
      [false, "lab/q1-docs", "lab/q1-docs is never published"],
      [true, "feat/1-x", "this session works in the main checkout: an Author publishes from its own worktree"],
      [true, "dev", "dev is never published"],
      [true, null, "HEAD is detached"],
    ];

    for (const [mainCheckout, branch, reason] of cases) {
      expect(checkoutOf({ mainCheckout, branch })).toEqual({ kind: "refused", reason });
    }
  });

  test("a branch that only starts like an ignored one is published", () => {
    for (const branch of ["develop", "mainline", "lab", "labs/x", "feat/dev", "x/lab/y"]) {
      expect(checkoutOf({ mainCheckout: false, branch }).kind).toBe("publishable");
    }
  });
});

describe("chainOf", () => {
  test("a first stop follows no block", () => {
    expect(chainOf(false, false)).toEqual({ blocked: false, reported: false });
  });

  test("a stop after the block that asked for the commit leaves the failures their one block", () => {
    expect(chainOf(true, true)).toEqual({ blocked: true, reported: false });
  });

  test("a stop after any other block is after a reported failure", () => {
    expect(chainOf(true, false)).toEqual({ blocked: true, reported: true });
  });

  test("a commit asked for in a chain that ended counts for nothing in the next one", () => {
    expect(chainOf(false, true)).toEqual({ blocked: false, reported: false });
  });
});

describe("admit", () => {
  test("a clean branch with commits dev lacks and no open PR asks for the branch's closed PRs", () => {
    expect(admit(SNAPSHOT, false)).toEqual({ kind: "read-closed" });
    expect(admit({ ...SNAPSHOT, ahead: 1 }, true)).toEqual({ kind: "read-closed" });
  });

  test("a dirty tree blocks once with a message that only asks to commit, whatever the branch holds", () => {
    const block: Admission = {
      kind: "block",
      reason: "Commit your changes, then stop.",
      outcome: "the tree has uncommitted changes",
    };

    const ready = { number: 7, draft: false, headSha: HEAD };

    expect(admit({ ...SNAPSHOT, treeClean: false }, false)).toEqual(block);
    expect(admit({ ...SNAPSHOT, treeClean: false, ahead: 0 }, false)).toEqual(block);
    expect(admit({ ...SNAPSHOT, treeClean: false, pr: ready }, false)).toEqual(block);
  });

  test("a later stop of the chain on a tree still dirty lets the session end, and publishes nothing", () => {
    const none: Admission = { kind: "none", reason: "the tree has uncommitted changes" };

    expect(admit({ ...SNAPSHOT, treeClean: false }, true)).toEqual(none);
    expect(admit({ ...SNAPSHOT, treeClean: false, ahead: 0 }, true)).toEqual(none);
  });

  test("nothing is published with no new commit, on the first stop as after a block", () => {
    const none: Admission = { kind: "none", reason: "agent/clear-command has no commit that dev lacks" };

    expect(admit({ ...SNAPSHOT, ahead: 0 }, false)).toEqual(none);
    expect(admit({ ...SNAPSHOT, ahead: 0 }, true)).toEqual(none);
  });

  test("a PR ready at this head publishes nothing", () => {
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: false, headSha: HEAD } }, false)).toEqual({
      kind: "ready",
      pr: 7,
      reason: `#7 is ready at ${HEAD} already`,
    });
  });

  test("a draft PR, or a ready one behind this head, runs the Stop checks again", () => {
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: true, headSha: HEAD } }, false)).toEqual({
      kind: "stop-checks",
    });
    expect(admit({ ...SNAPSHOT, pr: { number: 7, draft: false, headSha: "b".repeat(40) } }, false)).toEqual({
      kind: "stop-checks",
    });
  });
});

describe("afterClosed", () => {
  test("a PR closed without landing at this head publishes nothing, and the reason names it", () => {
    expect(
      afterClosed(HEAD, [
        { number: 9, headSha: "b".repeat(40) },
        { number: 146, headSha: HEAD },
      ]),
    ).toEqual({
      kind: "none",
      reason: `#146 was closed without landing at ${HEAD}: a stop at the head it had publishes nothing`,
    });
  });

  test("no closed PR, or one closed at another head, runs the Stop checks", () => {
    expect(afterClosed(HEAD, [])).toEqual({ kind: "stop-checks" });
    expect(afterClosed(HEAD, [{ number: 146, headSha: "b".repeat(40) }])).toEqual({ kind: "stop-checks" });
  });
});

describe("noAuthorToken", () => {
  test("no token blocks once, naming its path, then lets the session end with nothing published", () => {
    expect(noAuthorToken("/h/author-token", false)).toEqual({
      kind: "block",
      reason:
        "The Stop hook found no Author token at /h/author-token, so nothing was published. The Owner provisions it (.claude/rules/identities.md). Stop, and ask no question.",
    });
    expect(noAuthorToken("/h/author-token", true)).toEqual({
      kind: "none",
      reason: "no Author token after a block: nothing is published",
    });
  });
});

describe("afterStopChecks", () => {
  test("green Stop checks ask the Done judge", () => {
    expect(afterStopChecks({ kind: "green" }, false)).toEqual({ kind: "ask-done-judge" });
    expect(afterStopChecks({ kind: "green" }, true)).toEqual({ kind: "ask-done-judge" });
  });

  test("red Stop checks block once with their report, then let the session end", () => {
    const red = { kind: "red", report: "1 fail" } as const;

    expect(afterStopChecks(red, false)).toEqual({
      kind: "block",
      reason:
        "The Stop checks are red on this head, so nothing was published:\n\n1 fail\n\nFix them and commit, then stop.",
    });
    expect(afterStopChecks(red, true)).toEqual({
      kind: "none",
      reason: "the Stop checks are still red after a block: nothing is published",
    });
  });
});

describe("doneAnswerOf", () => {
  test("a structured output that fits the schema is the Done judge's answer", () => {
    const finished = { finished: true, question: "", reason: "done", rejections: [] };

    const unfinished = {
      finished: false,
      question: "Which wording do you want?",
      reason: "a test is missing",
      rejections: [{ thread: "T1", reason: "by design" }],
    };

    expect(doneAnswerOf({ code: 0, structured: finished })).toEqual(finished);
    expect(doneAnswerOf({ code: 0, structured: unfinished })).toEqual(unfinished);
  });

  test("a fork that exits non-zero gave no answer, whatever its output", () => {
    const structured = { finished: true, question: "", reason: "done", rejections: [] };

    for (const code of [1, 124, -1]) {
      expect(doneAnswerOf({ code, structured })).toBeNull();
    }
  });

  test("an output that does not fit the schema is no answer", () => {
    const unfit: unknown[] = [
      undefined,
      null,
      "YES",
      "YES, HOLD: a stored format",
      {},
      { finished: "yes", question: "", reason: "done", rejections: [] },
      { finished: true, reason: "done", rejections: [] },
      { finished: true, question: null, reason: "done", rejections: [] },
      { finished: true, question: "", rejections: [] },
      { finished: true, question: "", reason: "done" },
      { finished: true, question: "", reason: "done", rejections: [{ thread: "T1" }] },
      { finished: true, question: "", reason: "done", rejections: "none" },
    ];

    for (const structured of unfit) {
      expect(doneAnswerOf({ code: 0, structured })).toBeNull();
    }
  });

  test("the schema the fork follows names the four fields, and no hold", () => {
    expect(DONE_SCHEMA).toEqual({
      type: "object",
      properties: {
        finished: { type: "boolean" },
        question: { type: "string" },
        reason: { type: "string" },
        rejections: {
          type: "array",
          items: {
            type: "object",
            properties: { thread: { type: "string" }, reason: { type: "string" } },
            required: ["thread", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["finished", "question", "reason", "rejections"],
      additionalProperties: false,
    });
  });
});

describe("noDoneAnswer", () => {
  test("no answer blocks once, naming the fork's exit code, then lets the session end", () => {
    expect(noDoneAnswer(1, false)).toEqual({
      kind: "block",
      reason:
        "The Stop hook could not ask whether your change is finished (the Done judge's fork exited 1 with no answer that reads), so nothing was published. Stop again to retry; ask no question.",
    });
    expect(noDoneAnswer(0, true)).toEqual({
      kind: "none",
      reason: "the Done judge gave no answer after a block: nothing is published",
    });
  });
});

describe("decide", () => {
  const draft = { number: 7, draft: true, headSha: HEAD };
  const ready = { number: 7, draft: false, headSha: HEAD };

  test("a change the Done judge says is not finished publishes nothing, and says why", () => {
    const unfinished: DoneAnswer = { finished: false, question: "", reason: "a test is missing", rejections: [] };

    expect(decide(null, unfinished)).toEqual({
      kind: "none",
      reason: "the Done judge says the change is not finished: a test is missing",
    });
    expect(decide(draft, unfinished).kind).toBe("none");
  });

  test("a question left to the user asks the Owner on a draft, whatever the Done judge says of the change, and quotes it", () => {
    const asking: DoneAnswer = { ...FINISHED, question: "  Leave the doc, or update it in this PR?\n" };
    const reason = "the Author's last message leaves a question to its user: Leave the doc, or update it in this PR?";
    const question = "Leave the doc, or update it in this PR?";

    expect(decide(null, asking)).toEqual({ kind: "ask", question, reason, pr: null, toDraft: false });
    expect(decide(draft, asking)).toEqual({ kind: "ask", question, reason, pr: 7, toDraft: false });
  });

  test("a question on a ready PR sends it back to draft: nothing lands while it is open", () => {
    expect(decide(ready, { ...FINISHED, question: "Which wording?" })).toMatchObject({
      kind: "ask",
      pr: 7,
      toDraft: true,
    });
  });

  test("a change both unfinished and asking keeps both reasons", () => {
    const asking: DoneAnswer = {
      finished: false,
      question: "Which wording?",
      reason: "a test is missing",
      rejections: [],
    };

    expect(decide(ready, asking)).toMatchObject({
      kind: "ask",
      reason:
        "the Author's last message leaves a question to its user: Which wording?; the Done judge says the change is not finished: a test is missing",
    });
  });

  test("a question is quoted trimmed, then cut to its first 300 characters", () => {
    expect(quotedQuestionOf(`  ${"a".repeat(300)}b`)).toBe("a".repeat(300));
    expect(quotedQuestionOf(" Which wording?\n")).toBe("Which wording?");
    expect(quotedQuestionOf(" \n\t")).toBe("");
  });

  test("the quoted question is cut to its first 300 characters", () => {
    const action = decide(null, { ...FINISHED, question: `${"a".repeat(300)}b` });

    expect(action).toMatchObject({
      kind: "ask",
      question: "a".repeat(300),
      reason: `the Author's last message leaves a question to its user: ${"a".repeat(300)}`,
    });
  });

  test("a question of blanks alone is no question", () => {
    expect(decide(null, { ...FINISHED, question: " \n\t" })).toEqual({ kind: "open" });
  });

  test("a finished change opens the PR when there is none, pushes and readies a draft, pushes a ready one", () => {
    expect(decide(null, FINISHED)).toEqual({ kind: "open" });
    expect(decide(draft, FINISHED)).toEqual({ kind: "push", pr: 7, ready: true });
    expect(decide(ready, FINISHED)).toEqual({ kind: "push", pr: 7, ready: false });
  });

  test("no answer holds a PR: an action names no label", () => {
    for (const action of [decide(null, FINISHED), decide(draft, FINISHED), decide(ready, FINISHED)]) {
      expect(JSON.stringify(action)).not.toContain("hold");
      expect(JSON.stringify(action)).not.toContain("land:human");
    }
  });
});

describe("the Owner's question", () => {
  const asked = { author: AUTHOR_LOGIN, body: questionCommentOf("Which wording?", "feat/7-x", "S1") };
  const answer = { author: OWNER_LOGIN, body: "The first one." };

  test("the comment quotes the question line by line, escaped, names the branch and the session, and carries both marks", () => {
    const body = questionCommentOf("Keep <b>?\nOr drop it?", "feat/7-x", "S1");

    expect(body).toBe(
      [
        "The Author of `feat/7-x` (session `S1`) asks the Owner, and waits for the answer:",
        "",
        "> Keep &lt;b>?\n> Or drop it?",
        "",
        "Answer in a comment on this pull request: it reaches the Author's session. The pull request stays in draft until the Author stops with no question.",
        "",
        QUESTION_MARK,
        "",
        AUTHOR_MARK,
      ].join("\n"),
    );
  });

  test("a question is open from the hook's comment until the Owner's next comment", () => {
    expect(questionOpen([])).toBe(false);
    expect(questionOpen([asked])).toBe(true);
    expect(questionOpen([answer, asked])).toBe(true);
    expect(questionOpen([asked, answer])).toBe(false);
    expect(questionOpen([asked, answer, asked])).toBe(true);
  });

  test("only the machine account's marked comment asks, and only the Owner's own words answer", () => {
    expect(questionOpen([{ ...asked, author: "someone" }])).toBe(false);
    expect(questionOpen([{ ...asked, body: "Which wording?" }])).toBe(false);
    expect(questionOpen([asked, { ...answer, author: "someone" }])).toBe(true);
    expect(questionOpen([asked, { ...answer, body: `posted for the Author\n\n${AUTHOR_MARK}` }])).toBe(true);
  });

  test("the Owner's words are a comment of the Owner's login that the hook did not post", () => {
    expect(byOwner(answer)).toBe(true);
    expect(byOwner({ ...answer, author: AUTHOR_LOGIN })).toBe(false);
    expect(byOwner({ author: OWNER_LOGIN, body: `x ${AUTHOR_MARK}` })).toBe(false);
  });
});

describe("rejectionsOf", () => {
  test("a rejection that names an open thread of the App is posted", () => {
    expect(rejectionsOf([{ thread: "T1", reason: "by design" }], ["T1", "T2"])).toEqual({
      posted: [{ thread: "T1", reason: "by design" }],
      dropped: [],
    });
  });

  test("each open thread takes its own rejection", () => {
    const both = [
      { thread: "T1", reason: "by design" },
      { thread: "T2", reason: "out of scope" },
    ];

    expect(rejectionsOf(both, ["T1", "T2"])).toEqual({ posted: both, dropped: [] });
  });

  test("a rejection that names no open thread, names one twice, or gives no reason is dropped", () => {
    expect(
      rejectionsOf(
        [
          { thread: "T9", reason: "not a thread of this PR" },
          { thread: "T1", reason: "by design" },
          { thread: "T1", reason: "again" },
          { thread: "T2", reason: "  " },
        ],
        ["T1", "T2"],
      ),
    ).toEqual({
      posted: [{ thread: "T1", reason: "by design" }],
      dropped: [
        { thread: "T9", reason: "not a thread of this PR" },
        { thread: "T1", reason: "again" },
        { thread: "T2", reason: "  " },
      ],
    });
    expect(rejectionsOf([{ thread: "T1", reason: "by design" }], [])).toEqual({
      posted: [],
      dropped: [{ thread: "T1", reason: "by design" }],
    });
  });
});

describe("rejectionReplyOf", () => {
  test("the reply carries the Author's reason, the reject mark and the Author's mark", () => {
    expect(rejectionReplyOf("  the flag is read by <cli>  ")).toBe(
      `Rejected: the flag is read by &lt;cli>\n\n${REJECT_MARK}\n\n${AUTHOR_MARK}`,
    );
  });
});

describe("outcomeLineOf", () => {
  const facts = { at: "2026-11-10T10:00:00.000Z", session: "S1", worktree: "/w", branch: "feat/1-x", head: HEAD };

  test("a Publication names its PR", () => {
    expect(JSON.parse(outcomeLineOf(facts, { kind: "published", pr: 12 }))).toEqual({
      ...facts,
      outcome: "published",
      pr: 12,
    });
  });

  test("a stop that publishes nothing says why", () => {
    expect(
      JSON.parse(outcomeLineOf(facts, { kind: "not-published", reason: "the tree has uncommitted changes" })),
    ).toEqual({ ...facts, outcome: "not-published", reason: "the tree has uncommitted changes" });
  });

  test("the line is one line", () => {
    expect(outcomeLineOf(facts, { kind: "not-published", reason: "a\nb" })).not.toContain("\n");
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
