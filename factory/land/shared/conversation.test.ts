import { describe, expect, test } from "bun:test";

import { conversationArgsOf, conversationOf } from "./conversation.ts";

describe("the conversation of a pull request", () => {
  test("the command pages through the PR's comments and prints one JSON line each: its id as text, its author's login, its body", () => {
    expect(conversationArgsOf(12)).toEqual([
      "gh",
      "api",
      "--paginate",
      "repos/{owner}/{repo}/issues/12/comments?per_page=100",
      "--jq",
      ".[] | {id: (.id | tostring), author: .user.login, body}",
    ]);
  });

  test("each line reads as one comment, in order, and a blank line as none", () => {
    const lines = [
      JSON.stringify({ id: "1", author: "bengous", body: "first" }),
      "",
      JSON.stringify({ id: "2", author: "someone", body: "second\nline" }),
    ].join("\n");

    expect(conversationOf(lines)).toEqual([
      { id: "1", author: "bengous", body: "first" },
      { id: "2", author: "someone", body: "second\nline" },
    ]);
    expect(conversationOf("")).toEqual([]);
  });

  test("an App's login loses REST's [bot] suffix, and a deleted user's comment has an unknown author", () => {
    const lines = [
      JSON.stringify({ id: "1", author: "bengous-labs-agents[bot]", body: "state" }),
      JSON.stringify({ id: "2", author: null, body: "gone" }),
      JSON.stringify({ id: "3", author: "a[bot]b", body: "no suffix" }),
    ].join("\n");

    expect(conversationOf(lines).map((comment) => comment.author)).toEqual([
      "bengous-labs-agents",
      "unknown",
      "a[bot]b",
    ]);
  });

  test("a line that does not read throws, naming what it is", () => {
    expect(() => conversationOf(JSON.stringify({ id: 1, author: "x", body: "numeric id" }))).toThrow(
      "a conversation comment",
    );
  });
});
