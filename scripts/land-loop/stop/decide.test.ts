import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AUTHOR_MARK } from "../author-mark.ts";
import { factoryConfigOf } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import {
  admit,
  afterAuthorToken,
  afterLocalReview,
  afterStopChecks,
  answeredImportantsOf,
  answerOf,
  answersOf,
  answersRecordName,
  armReason,
  bodyWithBlock,
  closingLineOf,
  decide,
  holdStepsOf,
  localReviewBlockOf,
  localReviewNeeded,
  localReviewOf,
  localReviewReason,
  nitLinesOf,
  rejectArgsOf,
  reviewRecordName,
  riskyPathsOf,
} from "./decide.ts";
import type { Answer, LocalFinding, LocalReviewContext, LocalReviewRecord, Snapshot } from "./decide.ts";

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

  test("a YES line that names HOLD off the YES, HOLD: form still holds, so it fails closed", () => {
    const cases: Array<[string, string]> = [
      ["YES, HOLD - renames a stored label", "renames a stored label"],
      ["YES, HOLD — renames a stored label", "renames a stored label"],
      ["YES, HOLD – renames a stored label", "renames a stored label"],
      ["YES, HOLD : renames a stored label", "renames a stored label"],
      ["**YES, HOLD** renames a stored label", "renames a stored label"],
      ["YES. HOLD: renames a stored label", "renames a stored label"],
      ["# YES, HOLD — renames a stored label", "renames a stored label"],
      ["__YES__ - HOLD: renames a stored label", "renames a stored label"],
      ["YES HOLD", "(no reason given)"],
    ];

    for (const [text, reason] of cases) {
      expect(answerOf(text)).toEqual({ kind: "hold", reason });
    }
  });

  test("the reason loses the emphasis that closes a bolded line, and keeps its own markup", () => {
    const cases: Array<[string, string]> = [
      ["**YES, HOLD: renames a stored label**", "renames a stored label"],
      ["**YES, HOLD: renames a stored label**  ", "renames a stored label"],
      ["**YES, HOLD: renames a stored label **", "renames a stored label"],
      ["**YES, HOLD: changes the scripts/**/*.ts glob**", "changes the scripts/**/*.ts glob"],
      ["__YES, HOLD: renames a stored label.__", "renames a stored label."],
      ["YES, HOLD:_id field renamed", "_id field renamed"],
      ["YES, HOLD: renames the id_", "renames the id_"],
      ["YES, HOLD:** renames a stored label", "renames a stored label"],
      ["YES, HOLD:**", "(no reason given)"],
    ];

    for (const [text, reason] of cases) {
      expect(answerOf(text)).toEqual({ kind: "hold", reason });
    }
  });

  test("HOLD inside a longer word is no hold", () => {
    expect(answerOf("YES, the THRESHOLD is met")).toEqual({ kind: "yes" });
    expect(answerOf("YES, HOLDS up")).toEqual({ kind: "yes" });
    expect(answerOf("YES, HOLD7 is a name")).toEqual({ kind: "yes" });
    expect(answerOf("YES, 7HOLD is a name")).toEqual({ kind: "yes" });
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

const POLICY: RoutingPolicy = factoryConfigOf(readFileSync(".github/software-factory.json", "utf8")).land.routing;

const finding = (
  severity: LocalFinding["severity"],
  file: string,
  line: number | null,
  summary: string,
): LocalFinding => ({ file, line, severity, summary, failureScenario: `${summary} Scenario.` });

const DECIDE_598: LocalFinding = {
  file: "scripts/land-loop/merge-bot/decide.ts",
  line: 598,
  severity: "important",
  summary:
    "The routing of an empty patch is read from the record without a routing step, so a PR with no file lands auto.",
  failureScenario:
    'A PR whose diff is empty: patchOf returns "empty", decide finds no triage for it, routes it, then merges it on the rules\' auto answer.',
};

const MAIN_421: LocalFinding = {
  file: "scripts/land-loop/merge-bot/main.ts",
  line: 421,
  severity: "important",
  summary:
    "The snapshot's `now` is taken after the review job read, so a slow read makes a fresh request read as past its deadline.",
  failureScenario: "A review requested 44 minutes ago, a job read that takes 2 minutes: the request reads as failed.",
};

const reviewOf = (findings: readonly LocalFinding[]): LocalReviewRecord => ({
  findings,
  model: "claude-opus-5-5",
  tokens: null,
});

const TWO_IMPORTANT = reviewOf([
  DECIDE_598,
  finding("nit", "a.ts", 1, "a nit"),
  finding("pre_existing", "b.ts", 2, "old"),
  MAIN_421,
]);

describe("localReviewNeeded", () => {
  test("a factory, Owner or deep-review path, or the factory config, needs the local review; the app's commands and docs do not", () => {
    expect(localReviewNeeded(["scripts/land-loop/stop/hook.ts"], POLICY)).toBe(true);
    expect(localReviewNeeded([".github/workflows/ci.yml"], POLICY)).toBe(true);
    expect(localReviewNeeded(["app/src/store/store.ts"], POLICY)).toBe(true);
    expect(localReviewNeeded([".github/software-factory.json"], POLICY)).toBe(true);
    expect(localReviewNeeded(["app/src/commands/add.ts", "docs/usage.md"], POLICY)).toBe(false);
    expect(localReviewNeeded(["docs/usage.md", "app/src/store/store.ts"], POLICY)).toBe(true);
    expect(localReviewNeeded([], POLICY)).toBe(false);
  });

  test("each list of the policy counts on its own, and the config path whatever the policy", () => {
    const empty: RoutingPolicy = { ownerPaths: [], factoryPaths: [], deepReviewPaths: [], lineCap: 400 };

    expect(localReviewNeeded([".github/software-factory.json"], empty)).toBe(true);
    expect(localReviewNeeded(["x/a.ts"], { ...empty, ownerPaths: ["x/**"] })).toBe(true);
    expect(localReviewNeeded(["x/a.ts"], { ...empty, factoryPaths: ["x/**"] })).toBe(true);
    expect(localReviewNeeded(["x/a.ts"], { ...empty, deepReviewPaths: ["x/**"] })).toBe(true);
    expect(localReviewNeeded(["x/a.ts"], empty)).toBe(false);
  });
});

const REJECT = "bun scripts/land-loop/local-review.ts";

const CONTEXT: LocalReviewContext = { stopHookActive: false, reviewedNow: false, rejectCommand: REJECT };

describe("localReviewReason", () => {
  test("two unanswered Importants and one Nit give the block text, word for word", () => {
    expect(localReviewReason(TWO_IMPORTANT, {}, REJECT))
      .toBe(`The local review found 2 Important finding(s) on this head without an answer, so nothing was published:

1. scripts/land-loop/merge-bot/decide.ts:598: The routing of an empty patch is read from the record without a routing step, so a PR with no file lands auto.
   A PR whose diff is empty: patchOf returns "empty", decide finds no triage for it, routes it, then merges it on the rules' auto answer.
2. scripts/land-loop/merge-bot/main.ts:421: The snapshot's \`now\` is taken after the review job read, so a slow read makes a fresh request read as past its deadline.
   A review requested 44 minutes ago, a job read that takes 2 minutes: the request reads as failed.

Fix a finding with a commit, or reject it: bun scripts/land-loop/local-review.ts reject <n> "<reason>". Then stop. A Nit never blocks: 1 Nit is in .lab/stop.log.`);
  });

  test("an answered Important is skipped and keeps the others' numbers; no Nit, or two, take the plural", () => {
    const reason = localReviewReason(reviewOf([DECIDE_598, MAIN_421]), { "1": "Rejected: no" }, REJECT);

    expect(reason.startsWith("The local review found 1 Important finding(s) on this head")).toBe(true);
    expect(reason).not.toContain("1. ");
    expect(reason).toContain(":\n\n2. scripts/land-loop/merge-bot/main.ts:421: ");
    expect(reason.endsWith("A Nit never blocks: 0 Nits are in .lab/stop.log.")).toBe(true);
    expect(
      localReviewReason(
        reviewOf([DECIDE_598, finding("nit", "a.ts", 1, "x"), finding("nit", "a.ts", 2, "y")]),
        {},
        REJECT,
      ),
    ).toContain("A Nit never blocks: 2 Nits are in .lab/stop.log.");
  });

  test("a finding with no line names its file alone", () => {
    expect(localReviewReason(reviewOf([finding("important", "a.ts", null, "broken")]), {}, REJECT)).toContain(
      ":\n\n1. a.ts: broken\n   broken Scenario.\n\nFix",
    );
  });

  test("the reject command is the one the hook names, an absolute path included", () => {
    expect(localReviewReason(TWO_IMPORTANT, {}, "bun /repo/scripts/land-loop/local-review.ts")).toContain(
      'or reject it: bun /repo/scripts/land-loop/local-review.ts reject <n> "<reason>". Then stop.',
    );
  });
});

describe("nitLinesOf", () => {
  test("each Nit is its place and its summary; no other severity is one", () => {
    expect(nitLinesOf(TWO_IMPORTANT)).toEqual(["a.ts:1: a nit"]);
    expect(nitLinesOf(reviewOf([finding("nit", "b.ts", null, "x")]))).toEqual(["b.ts: x"]);
  });
});

describe("afterLocalReview", () => {
  test("no Important, or every Important answered, publishes", () => {
    const answered = { "1": "Rejected: a", "2": "Rejected: b" };

    expect(afterLocalReview(reviewOf([finding("nit", "a.ts", 1, "x")]), {}, CONTEXT)).toEqual({ kind: "publish" });
    expect(afterLocalReview(TWO_IMPORTANT, answered, CONTEXT)).toEqual({ kind: "publish" });
    expect(afterLocalReview(TWO_IMPORTANT, answered, { ...CONTEXT, stopHookActive: true })).toEqual({
      kind: "publish",
    });
  });

  test("an unanswered Important blocks with the block text, then lets the session end with nothing published", () => {
    const answers = { "1": "Rejected: a" };

    expect(afterLocalReview(TWO_IMPORTANT, answers, CONTEXT)).toEqual({
      kind: "block",
      reason: localReviewReason(TWO_IMPORTANT, answers, REJECT),
    });
    expect(afterLocalReview(TWO_IMPORTANT, answers, { ...CONTEXT, stopHookActive: true })).toEqual({
      kind: "none",
      reason: "the local review is still red after a block: nothing is published",
    });
  });

  test("a review that ran in this stop blocks even right after a block: the Author never saw its findings", () => {
    expect(afterLocalReview(TWO_IMPORTANT, {}, { ...CONTEXT, stopHookActive: true, reviewedNow: true })).toEqual({
      kind: "block",
      reason: localReviewReason(TWO_IMPORTANT, {}, REJECT),
    });
    expect(afterLocalReview(TWO_IMPORTANT, {}, { ...CONTEXT, reviewedNow: true })).toEqual({
      kind: "block",
      reason: localReviewReason(TWO_IMPORTANT, {}, REJECT),
    });
  });

  test("a failed session blocks once with its error cut at 200 characters, then lets the session end, even just run", () => {
    const error = `timed out ${"x".repeat(300)}`;
    const reason = `The local review could not run (${error.slice(0, 200)}), so nothing was published. Stop again to retry; ask no question.`;

    const ended = {
      kind: "none",
      reason: "the local review is still red after a block: nothing is published",
    } as const;

    expect(afterLocalReview({ failed: error }, {}, CONTEXT)).toEqual({ kind: "block", reason });
    expect(afterLocalReview({ failed: error }, {}, { ...CONTEXT, reviewedNow: true })).toEqual({
      kind: "block",
      reason,
    });
    expect(afterLocalReview({ failed: error }, {}, { ...CONTEXT, stopHookActive: true })).toEqual(ended);
    expect(afterLocalReview({ failed: error }, {}, { ...CONTEXT, stopHookActive: true, reviewedNow: true })).toEqual(
      ended,
    );
  });
});

describe("rejectArgsOf", () => {
  test("reject <n> <reason> names an Important of the review", () => {
    expect(rejectArgsOf(["reject", "2", "the bound is inclusive"], TWO_IMPORTANT)).toEqual({
      n: 2,
      reason: "the bound is inclusive",
    });
    expect(rejectArgsOf(["reject", "1", "x"], TWO_IMPORTANT)).toEqual({ n: 1, reason: "x" });

    const twelve = reviewOf(Array.from({ length: 12 }, (_, index) => finding("important", "a.ts", index, "x")));

    expect(rejectArgsOf(["reject", "12", "x"], twelve)).toEqual({ n: 12, reason: "x" });
  });

  test("the records are named after their head", () => {
    expect(reviewRecordName(HEAD)).toBe(`review-${HEAD}.json`);
    expect(answersRecordName(HEAD)).toBe(`review-${HEAD}-answers.json`);
  });

  test("a missing or malformed number, a number with no Important, an empty reason or another verb is refused", () => {
    const refused: ReadonlyArray<readonly string[]> = [
      ["reject"],
      ["reject", "x", "r"],
      ["reject", "1.5", "r"],
      ["reject", "01x", "r"],
      ["reject", "0", "r"],
      ["reject", "3", "r"],
      ["reject", "2"],
      ["reject", "2", "  "],
      ["accept", "1", "r"],
      [],
    ];

    for (const argv of refused) {
      expect(rejectArgsOf(argv, TWO_IMPORTANT)).toBeNull();
    }
  });
});

describe("the local review records", () => {
  test("a record and its answers read back; a file outside the schema throws, naming it", () => {
    expect(localReviewOf("r.json", JSON.stringify(TWO_IMPORTANT))).toEqual(TWO_IMPORTANT);
    expect(answersOf("a.json", '{"1":"Rejected: x"}')).toEqual({ "1": "Rejected: x" });
    expect(() => localReviewOf("r.json", '{"findings":[]}')).toThrow("r.json");
    expect(() => localReviewOf("r.json", '{"findings":[{"file":"a.ts"}],"model":null,"tokens":null}')).toThrow(
      "r.json",
    );
    expect(() => answersOf("a.json", '{"1":2}')).toThrow("a.json");
  });
});

const HEAD_A = "ac95210".padEnd(40, "0");

const HEAD_B = "fa2392d".padEnd(40, "1");

const HEAD_C = "0c0ffee".padEnd(40, "2");

describe("localReviewBlockOf", () => {
  test("two reviewed heads, a fix and a rejection: the block of the Target", () => {
    const block = localReviewBlockOf([
      {
        head: HEAD_B,
        review: reviewOf([
          { ...DECIDE_598, summary: "The routing of an empty patch is read from the record without a routing step." },
          { ...MAIN_421, summary: "The snapshot's `now` is taken after the review job read." },
        ]),
        answers: {},
        nextHead: HEAD_C,
      },
      {
        head: HEAD_A,
        review: reviewOf([
          finding(
            "important",
            "scripts/land-loop/guarantees.test.ts",
            131,
            "The ownerPaths guarantee draws only from the parsed config.",
          ),
          finding("nit", "a", 1, "n"),
          finding("nit", "b", 1, "n"),
          finding("pre_existing", "c", 1, "n"),
          finding("nit", "c", 1, "n"),
        ]),
        answers: { "1": "Rejected: the Owner's globs are pinned as literals since fa2392d" },
        nextHead: null,
      },
    ]);

    expect(block).toBe(`<!-- lab-local-review -->
Local review (deep, ac95210): 2 Important fixed, 1 rejected, 3 Nit.
<details><summary>Findings</summary>

- scripts/land-loop/merge-bot/decide.ts:598: The routing of an empty patch is read from the record without a routing step. | Author: Fixed in 0c0ffee
- scripts/land-loop/merge-bot/main.ts:421: The snapshot's \`now\` is taken after the review job read. | Author: Fixed in 0c0ffee
- scripts/land-loop/guarantees.test.ts:131: The ownerPaths guarantee draws only from the parsed config. | Author: Rejected: the Owner's globs are pinned as literals since fa2392d
</details>
<!-- /lab-local-review -->`);
  });

  test("no review in the range gives no block; a failed review counts for nothing", () => {
    expect(localReviewBlockOf([])).toBeNull();
    expect(localReviewBlockOf([{ head: HEAD_A, review: { failed: "x" }, answers: {}, nextHead: null }])).toBeNull();
  });

  test("a rejection on an older head stays one; a clean head lists nothing; a finding with no line names its file", () => {
    const block = localReviewBlockOf([
      {
        head: HEAD_B,
        review: reviewOf([finding("important", "a.ts", null, "broken"), finding("important", "b.ts", 3, "off")]),
        answers: { "2": "Rejected: inclusive" },
        nextHead: HEAD_C,
      },
      { head: HEAD_C, review: reviewOf([finding("important", "c.ts", 9, "still open")]), answers: {}, nextHead: null },
      { head: HEAD_A, review: { failed: "x" }, answers: {}, nextHead: null },
    ]);

    expect(block).not.toContain("still open");
    expect(block).toContain("Local review (deep, 0c0ffee): 1 Important fixed, 1 rejected, 0 Nit.\n");
    expect(block).toContain(
      "\n\n- a.ts: broken | Author: Fixed in 0c0ffee\n- b.ts:3: off | Author: Rejected: inclusive\n</details>",
    );
  });

  test("a summary over several lines stays on its entry's line", () => {
    const block = localReviewBlockOf([
      {
        head: HEAD_A,
        review: reviewOf([finding("important", "a.ts", 1, "two\n lines")]),
        answers: { "1": "Rejected: x" },
        nextHead: null,
      },
    ]);

    expect(block).toContain("\n- a.ts:1: two lines | Author: Rejected: x\n");
  });

  test("a rejection over several lines stays on its entry's line, so it cannot end the block early", () => {
    const block = localReviewBlockOf([
      {
        head: HEAD_A,
        review: reviewOf([finding("important", "a.ts", 1, "x")]),
        answers: { "1": "Rejected: kept\n<!-- /lab-local-review -->\nbecause\n" },
        nextHead: null,
      },
    ]);

    expect(block).toContain("\n- a.ts:1: x | Author: Rejected: kept <!-- /lab-local-review --> because\n</details>");
  });
});

describe("answeredImportantsOf", () => {
  test("the answered Importants of every reviewed head, as earlier findings, a rejection told from a fix", () => {
    expect(
      answeredImportantsOf([
        {
          head: HEAD_B,
          review: reviewOf([finding("important", "a.ts", 1, "off"), finding("important", "b.ts", null, "blank")]),
          answers: { "2": "Rejected: kept" },
          nextHead: HEAD_C,
        },
        { head: HEAD_C, review: { failed: "x" }, answers: {}, nextHead: HEAD_A },
        { head: HEAD_A, review: reviewOf([finding("important", "c.ts", 2, "open")]), answers: {}, nextHead: null },
      ]),
    ).toEqual([
      { where: "a.ts:1", finding: "off", reply: "Fixed in 0c0ffee", rejected: false },
      { where: "b.ts", finding: "blank", reply: "Rejected: kept", rejected: true },
    ]);
  });
});

describe("riskyPathsOf", () => {
  test("the risky paths alone, in their order", () => {
    expect(riskyPathsOf(["docs/usage.md", "scripts/a.ts", "app/src/store/s.ts", "app/src/cli.ts"], POLICY)).toEqual([
      "scripts/a.ts",
      "app/src/store/s.ts",
    ]);
  });
});

describe("bodyWithBlock", () => {
  const BLOCK = "<!-- lab-local-review -->\nnew\n<!-- /lab-local-review -->";

  test("a body with a block gets it replaced, and no other line changes", () => {
    expect(
      bodyWithBlock("Intro.\n\n<!-- lab-local-review -->\nold\nlines\n<!-- /lab-local-review -->\n\nCloses #66", BLOCK),
    ).toBe(`Intro.\n\n${BLOCK}\n\nCloses #66`);
  });

  test("a body without one gets it before its closing line, or at its end", () => {
    expect(bodyWithBlock("Intro.\n\nCloses #66", BLOCK)).toBe(`Intro.\n\n${BLOCK}\n\nCloses #66`);
    expect(bodyWithBlock("Intro.\n\nCloses #66\n", BLOCK)).toBe(`Intro.\n\n${BLOCK}\n\nCloses #66`);
    expect(bodyWithBlock("Closes #66", BLOCK)).toBe(`${BLOCK}\n\nCloses #66`);
    expect(bodyWithBlock("Intro.\n\nSee #66.", BLOCK)).toBe(`Intro.\n\nSee #66.\n\n${BLOCK}`);
    expect(bodyWithBlock("Intro.\n\nCloses #66 and more", BLOCK)).toBe(`Intro.\n\nCloses #66 and more\n\n${BLOCK}`);
    expect(bodyWithBlock("", BLOCK)).toBe(BLOCK);
    expect(bodyWithBlock("Intro.\n", BLOCK)).toBe(`Intro.\n\n${BLOCK}`);
    expect(bodyWithBlock("Intro.\n\nSee Closes #66", BLOCK)).toBe(`Intro.\n\nSee Closes #66\n\n${BLOCK}`);
  });

  test("a block at the body's start is replaced; a marker without its pair is no block", () => {
    expect(bodyWithBlock("<!-- lab-local-review -->\nold\n<!-- /lab-local-review -->\n\nCloses #66", BLOCK)).toBe(
      `${BLOCK}\n\nCloses #66`,
    );
    expect(bodyWithBlock("Intro <!-- lab-local-review -->", BLOCK)).toBe(`Intro <!-- lab-local-review -->\n\n${BLOCK}`);
    expect(bodyWithBlock("Intro <!-- /lab-local-review -->", BLOCK)).toBe(
      `Intro <!-- /lab-local-review -->\n\n${BLOCK}`,
    );
  });
});
