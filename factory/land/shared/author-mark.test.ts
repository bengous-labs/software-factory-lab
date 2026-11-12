import { describe, expect, test } from "bun:test";

import { AUTHOR_LOGIN, OWNER_LOGIN } from "../../install/logins.ts";
import { fixedRecordBodyOf, questionCommentOf } from "../stop/decide.ts";
import { AUTHOR_MARK, byOwner, FIXED_MARK, fixedListOf, openQuestionOf, questionOpen } from "./author-mark.ts";

describe("the Owner's question", () => {
  const asked = { author: AUTHOR_LOGIN, body: questionCommentOf("Which wording?", "feat/7-x", "S1") };
  const answer = { author: OWNER_LOGIN, body: "The first one." };

  test("a question is open from the hook's comment until the Owner's next comment", () => {
    expect(questionOpen([])).toBe(false);
    expect(questionOpen([asked])).toBe(true);
    expect(questionOpen([answer, asked])).toBe(true);
    expect(questionOpen([asked, answer])).toBe(false);
    expect(questionOpen([asked, answer, asked])).toBe(true);
  });

  test("the open question is the hook's last marked comment, the one no comment of the Owner follows", () => {
    const later = { ...asked, body: questionCommentOf("Which file?", "feat/7-x", "S1") };

    expect(openQuestionOf([])).toBeNull();
    expect(openQuestionOf([asked, later])).toBe(later);
    expect(openQuestionOf([asked, answer, later])).toBe(later);
    expect(openQuestionOf([later, answer])).toBeNull();
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

describe("the findings the Author fixed", () => {
  test("the list reads back as written, ids of GitHub's alphabet included; a body with no list names none", () => {
    const body = fixedRecordBodyOf({ comment: null, fixed: [] }, ["PRRT_kwDOQ0-ab_c1", "PRRT_x2"]) ?? "";

    expect(fixedListOf(body)).toEqual(["PRRT_kwDOQ0-ab_c1", "PRRT_x2"]);
    expect(fixedListOf(`${FIXED_MARK} -->`)).toEqual([]);
    expect(fixedListOf("a comment")).toBeNull();
  });

  test("the list is a line of its own: a mark inside a line, before or after other words, holds none", () => {
    expect(fixedListOf(`x ${FIXED_MARK} T1 -->`)).toBeNull();
    expect(fixedListOf(`${FIXED_MARK} T1 --> x`)).toBeNull();
    expect(fixedListOf(`> ${FIXED_MARK} T9 -->`)).toBeNull();
    expect(fixedListOf(`intro\n${FIXED_MARK} T1 -->\nend`)).toEqual(["T1"]);
  });
});
