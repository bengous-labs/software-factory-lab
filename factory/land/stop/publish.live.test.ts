import { describe, expect, test } from "bun:test";

import type { Schema } from "effect";

import { AUTHOR_LOGIN, OWNER_LOGIN } from "../../install/logins.ts";
import { AUTHOR_MARK, REJECT_MARK } from "../shared/author-mark.ts";
import { questionCommentOf } from "./decide.ts";
import { doneQuestionOf } from "./done-judge.prompt.ts";
import { draftPr, FINISHED, HEAD, readyPr, stopIn, thread, TOKEN, UNFINISHED, world, writes } from "./stop.fixtures.ts";

const conversationLine = (id: string, author: string, body: string): string =>
  `${JSON.stringify({ id, author, body })}\n`;

describe("the Done judge", () => {
  test("a change that is not finished publishes nothing, and the stop goes", async () => {
    const found = world({ done: [UNFINISHED] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);
  });

  test("a question with no PR opens one in draft, posts the question on it, and leaves its relay to this session", async () => {
    const found = world({ branch: "feat/7-x", done: [{ ...FINISHED, question: "  Leave the doc, or update it?\n" }] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual(["push", "pr create", "pr comment"]);
    expect(found.calls.find((call) => call.argv.join(" ").startsWith("gh pr create"))?.argv).toContain("--draft");

    const comment = found.calls.find((call) => call.argv.join(" ").startsWith("gh pr comment"));
    expect(comment?.argv).toEqual(["gh", "pr", "comment", "12", "--body-file", "-"]);
    expect(comment?.options.stdin).toBe(questionCommentOf("Leave the doc, or update it?", "feat/7-x", "S1"));
    expect(comment?.options.env).toEqual({ GH_TOKEN: TOKEN });

    expect(found.relays).toEqual([{ pr: 12, session: "S1", headless: null, checkout: found.checkout }]);
    expect(found.records.find((record) => record.step === "done-judge")).toMatchObject({
      answer: "finished",
      question: "Leave the doc, or update it?",
    });
    expect(found.outcomes[0]?.line).toMatchObject({
      outcome: "asked",
      pr: 12,
      reason: "the Author's last message leaves a question to its user: Leave the doc, or update it?",
    });
  });

  test("a stop held on a question, or asking one, posts no rejection and logs each as dropped", async () => {
    const asked = conversationLine("1", AUTHOR_LOGIN, questionCommentOf("Which wording?", "agent/x", "S1"));
    const rejecting = { ...FINISHED, rejections: [{ thread: "T1", reason: "by design" }] };

    for (const answer of [rejecting, { ...rejecting, question: "And now?" }]) {
      const found = world({
        done: [answer],
        listed: draftPr("e".repeat(40)),
        conversation: asked,
        threads: [thread("T1", "nit")],
      });

      await stopIn(found);

      expect(writes(found.calls).filter((write) => write.includes("T1"))).toEqual([]);
      expect(found.records).toContainEqual({ step: "rejection-dropped", thread: "T1", reason: "by design" });
    }
  });

  test("a finished stop on a draft whose question the Owner has not answered readies nothing and pushes nothing", async () => {
    const asked = conversationLine("1", AUTHOR_LOGIN, questionCommentOf("Which wording?", "agent/x", "S1"));
    const found = world({ listed: draftPr("e".repeat(40)), conversation: asked });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);
    expect(found.outcomes[0]?.line).toMatchObject({
      outcome: "not-published",
      reason: "#12 holds a question to the Owner with no answer: nothing is pushed or readied",
    });
    expect(found.relays).toEqual([{ pr: 12, session: "S1", headless: null, checkout: found.checkout }]);

    const answered = world({
      listed: draftPr("e".repeat(40)),
      conversation: `${asked}${conversationLine("2", OWNER_LOGIN, "The first.")}`,
    });

    await stopIn(answered);
    expect(writes(answered.calls)).toEqual(["push", "pr ready"]);
  });

  test("a question still open on the PR is not posted again; one the Owner answered is followed by the new one", async () => {
    const asked = conversationLine("1", AUTHOR_LOGIN, questionCommentOf("Which wording?", "agent/x", "S1"));
    const answered = conversationLine("2", OWNER_LOGIN, "The first.");
    const asking = { done: [{ ...FINISHED, question: "Which wording, again?" }], listed: draftPr() };

    const repeated = world({ ...asking, conversation: asked });
    await stopIn(repeated);
    expect(writes(repeated.calls)).toEqual(["push"]);
    expect(repeated.records.find((record) => record.step === "question")).toEqual({
      step: "question",
      pr: 12,
      posted: false,
    });
    expect(repeated.relays).toHaveLength(1);

    const next = world({ ...asking, conversation: `${asked}${answered}` });
    await stopIn(next);
    expect(writes(next.calls)).toEqual(["push", "pr comment"]);
  });

  test("a question on a ready PR sends it to draft before the push, and nothing readies it: nothing lands while it is open", async () => {
    const found = world({ done: [{ ...FINISHED, question: "Which wording?" }], listed: readyPr("e".repeat(40)) });

    await stopIn(found);

    expect(writes(found.calls)).toEqual(["pr ready --undo", "push", "pr comment"]);
  });

  test("not finished, then finished, on the same head with no new commit: the second stop publishes", async () => {
    const found = world({ done: [UNFINISHED, FINISHED] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual(["push", "pr create"]);
    expect(found.outcomes.map((outcome) => outcome.line)).toMatchObject([
      {
        head: HEAD,
        outcome: "not-published",
        reason: "the Done judge says the change is not finished: a test is missing",
      },
      { head: HEAD, outcome: "published", pr: 12 },
    ]);
  });

  test("an answer that does not fit the schema is no answer: the hook blocks once, then lets the session end, and publishes nothing", async () => {
    const unfit: Array<Schema.Json | undefined> = [
      undefined,
      "YES",
      "YES, HOLD: a stored format",
      { finished: "yes", reason: "done", rejections: [] },
      { finished: true, reason: "done" },
    ];

    for (const answer of unfit) {
      const first = world({ done: [answer] });

      expect(await stopIn(first)).toEqual({
        kind: "block",
        reason:
          "The Stop hook could not ask whether your change is finished (the Done judge's fork exited 0 with no answer that reads), so nothing was published. Stop again to retry; ask no question.",
      });
      expect(await stopIn(first, true)).toEqual({ kind: "allow" });
      expect(writes(first.calls)).toEqual([]);
      expect(first.records.filter((record) => record.step === "done-judge")).toMatchObject([
        { answer: "none" },
        { answer: "none" },
      ]);
    }
  });

  test("a fork that exits non-zero gave no answer, whatever it printed", async () => {
    const found = world({ doneCode: 124 });
    const blocked = await stopIn(found);

    expect(blocked.kind === "block" && blocked.reason).toContain("exited 124");
    expect(writes(found.calls)).toEqual([]);
  });

  test("no answer puts land:human: the hook edits no label and posts no comment, whatever the judge answers", async () => {
    const answers: Array<Schema.Json | undefined> = [
      FINISHED,
      UNFINISHED,
      "YES, HOLD: a stored format",
      { finished: true, question: "", reason: "HOLD: a human should read this", rejections: [] },
      { finished: true, question: "", reason: "done", rejections: [], hold: "a stored format" },
    ];

    for (const answer of answers) {
      for (const listed of ["[]", draftPr(), readyPr("e".repeat(40))]) {
        const found = world({ done: [answer], listed });
        await stopIn(found);

        expect(found.calls.filter((call) => /^gh pr (edit|comment)/u.test(call.argv.join(" ")))).toEqual([]);
        expect(found.calls.some((call) => call.argv.join(" ").includes("land:human"))).toBe(false);
      }
    }
  });

  test("the question lists the App's open Important and Nit findings of the PR, not a resolved or Pre-existing one", async () => {
    const found = world({
      listed: draftPr(),
      threads: [
        thread("T1", "important"),
        thread("T2", "nit"),
        thread("T3", "nit", true),
        thread("T4", "pre_existing"),
      ],
    });

    await stopIn(found);

    expect(found.calls.find((call) => call.argv[0] === "claude")?.argv.at(-1)).toBe(
      doneQuestionOf([
        { thread: "T1", where: "app/src/cli.ts:7", severity: "important", summary: "T1 is wrong" },
        { thread: "T2", where: "app/src/cli.ts:7", severity: "nit", summary: "T2 is wrong" },
      ]),
    );
  });
});

describe("rejections", () => {
  const REJECTING = {
    finished: true,
    question: "",
    reason: "done",
    rejections: [{ thread: "T1", reason: "by design: <cli> reads it" }],
  };

  test("a rejection is posted with its marks and its thread resolved, before the push", async () => {
    const found = world({ done: [REJECTING], listed: draftPr(), threads: [thread("T1", "important")] });
    await stopIn(found);

    expect(writes(found.calls)).toEqual(["reply T1", "resolve T1", "push", "pr ready"]);
    expect(
      found.calls.find((call) => call.argv.join(" ").includes("addPullRequestReviewThreadReply"))?.argv.at(-1),
    ).toBe(`body=Rejected: by design: &lt;cli> reads it\n\n${REJECT_MARK}\n\n${AUTHOR_MARK}`);
    expect(found.records).toContainEqual({ step: "rejection", thread: "T1" });
  });

  test("when the push fails, nothing is written after the rejection, and the outcome says so", async () => {
    const found = world({
      done: [REJECTING],
      listed: draftPr(),
      threads: [thread("T1", "important"), thread("T2", "nit")],
      failing: ["git -c"],
    });

    expect(stopIn(found)).rejects.toThrow("git -c url.https://github.com/.pushInsteadOf=git@github.com: exited 1");
    await stopIn(found).catch(() => {});

    expect(writes(found.calls).slice(0, 3)).toEqual(["reply T1", "resolve T1", "push"]);
    expect(writes(found.calls).filter((write) => write !== "push" && !write.endsWith("T1"))).toEqual([]);
    expect(found.relays).toEqual([]);
    expect(found.outcomes[0]?.line).toMatchObject({ outcome: "not-published" });
    expect(String(found.outcomes[0]?.line.reason)).toStartWith("the Stop hook failed: git -c");
  });

  test("a rejection that names no open thread of the App is dropped and logged, and nothing is posted for it", async () => {
    const found = world({
      done: [
        {
          finished: true,
          question: "",
          reason: "done",
          rejections: [
            { thread: "T9", reason: "not mine" },
            { thread: "T3", reason: "resolved before" },
          ],
        },
      ],
      listed: draftPr(),
      threads: [thread("T1", "important"), thread("T3", "nit", true)],
    });

    await stopIn(found);

    expect(writes(found.calls)).toEqual(["push", "pr ready"]);
    expect(found.records).toContainEqual({ step: "rejection-dropped", thread: "T9", reason: "not mine" });
    expect(found.records).toContainEqual({ step: "rejection-dropped", thread: "T3", reason: "resolved before" });
  });

  test("a Publication leaves the App's open Nit threads open, for the Owner to read; an Important's too", async () => {
    const found = world({
      listed: readyPr("e".repeat(40)),
      threads: [thread("T1", "important"), thread("T2", "nit"), thread("T3", "nit"), thread("T4", "pre_existing")],
    });

    await stopIn(found);

    expect(writes(found.calls)).toEqual(["push"]);
    expect(found.records.some((record) => record.step === "nits")).toBe(false);
  });

  test("a rejected Nit is resolved by its rejection; the other Nits stay open", async () => {
    const found = world({ done: [REJECTING], listed: draftPr(), threads: [thread("T1", "nit"), thread("T2", "nit")] });
    await stopIn(found);

    expect(writes(found.calls)).toEqual(["reply T1", "resolve T1", "push", "pr ready"]);
  });

  test("no reply the hook posts cites a commit: a fix is declared by nobody", async () => {
    const found = world({ listed: draftPr(), threads: [thread("T1", "important"), thread("T2", "nit")] });
    await stopIn(found);

    expect(writes(found.calls)).toEqual(["push", "pr ready"]);
  });

  test("a stop on a PR ready at this head writes nothing and asks no fork, its Nit threads left open", async () => {
    const found = world({ listed: readyPr(), threads: [thread("T1", "important"), thread("T2", "nit")] });

    expect(await stopIn(found)).toEqual({ kind: "allow" });
    expect(writes(found.calls)).toEqual([]);
    expect(found.calls.some((call) => call.argv[0] === "claude" || call.argv[0] === "bun")).toBe(false);
  });
});
