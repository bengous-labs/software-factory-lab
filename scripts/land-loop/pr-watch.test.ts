import { describe, expect, test } from "bun:test";

import { decodeJson } from "../lib/json.ts";
import { AUTHOR_MARK } from "./author-mark.ts";
import { END_KEY, endOf, prStateOf, readingOf, SeenKeys, wakesOf } from "./pr-watch.ts";
import type { PrState } from "./pr-watch.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";

const OPEN: PrState = { state: "OPEN", draft: false, head: HEAD, checks: [], threads: [], comments: [] };

describe("wakesOf", () => {
  test("a quiet ready PR prints nothing", () => {
    expect(wakesOf(7, OPEN)).toEqual([]);
  });

  test("a failing check prints once per head; a passing or pending one prints nothing", () => {
    const checks = [
      { name: "validate", bucket: "fail", link: "https://ci/1" },
      { name: "land-gate", bucket: "pending", link: "" },
      { name: "agent-review", bucket: "pass", link: "" },
    ];

    expect(wakesOf(7, { ...OPEN, checks })).toEqual([
      { key: `check:validate:${HEAD}`, line: "Check validate failed on c0ffee1: https://ci/1" },
    ]);
  });

  test("an open Important or Nit finding prints as a Finding and a human thread as a Comment, with its thread id; a resolved one or a Pre-existing prints nothing", () => {
    const threads = [
      {
        id: "T1",
        resolved: false,
        path: "app/src/cli.ts",
        line: 12,
        author: "bengous-labs-agents",
        body: "**Important**: off\n\n<!-- lab-finding severity=important -->",
        replies: [],
      },
      { id: "T2", resolved: true, path: "a.ts", line: 1, author: "x", body: "old", replies: [] },
      {
        id: "T3",
        resolved: false,
        path: "a.ts",
        line: 2,
        author: "bengous-labs-agents",
        body: "**Nit**: n <!-- lab-finding severity=nit -->",
        replies: [],
      },
      {
        id: "T4",
        resolved: false,
        path: "a.ts",
        line: 3,
        author: "bengous-labs-agents",
        body: "p <!-- lab-finding severity=pre_existing -->",
        replies: [],
      },
      { id: "T5", resolved: false, path: "a.ts", line: 4, author: "bengous", body: "why this name?", replies: [] },
      {
        id: "T6",
        resolved: false,
        path: "a.ts",
        line: 5,
        author: "bengous",
        body: "quoting <!-- lab-finding severity=nit -->",
        replies: [],
      },
    ];

    const wakes = wakesOf(7, { ...OPEN, threads });

    expect(wakes.map((wake) => wake.key)).toEqual(["thread:T1", "thread:T3", "thread:T5", "thread:T6"]);
    expect(wakes[0]?.line).toStartWith("Finding T1 on app/src/cli.ts:12 by bengous-labs-agents: **Important**: off");
    expect(wakes[1]?.line).toBe(
      "Finding T3 on a.ts:2 by bengous-labs-agents: **Nit**: n <!-- lab-finding severity=nit -->",
    );
    expect(wakes[2]?.line).toBe("Comment T5 on a.ts:4 by bengous: why this name?");
    expect(wakes[3]?.line).toStartWith("Comment T6 on a.ts:5 by bengous: quoting");
  });

  test("a reply in an open thread prints, a Nit thread included, keyed by its comment id; the author's own marked reply does not", () => {
    const nit = "**Nit**: n <!-- lab-finding severity=nit -->";

    const threads = [
      {
        id: "T7",
        resolved: false,
        path: "a.ts",
        line: 9,
        author: "bengous-labs-agents",
        body: nit,
        replies: [
          { id: "C1", author: "bengous", body: "please fix this one anyway" },
          { id: "C2", author: "bengous-labs-author", body: `Fixed in abc.\n\n${AUTHOR_MARK}` },
          { id: "C4", author: "bengous-labs-agents", body: "re-checked" },
        ],
      },
      {
        id: "T8",
        resolved: true,
        path: "a.ts",
        line: 1,
        author: "bengous-labs-agents",
        body: nit,
        replies: [{ id: "C3", author: "bengous", body: "old" }],
      },
    ];

    expect(wakesOf(7, { ...OPEN, threads })).toEqual([
      { key: "thread:T7", line: `Finding T7 on a.ts:9 by bengous-labs-agents: ${nit}` },
      { key: "comment:C1", line: "Reply in T7 on a.ts:9 by bengous: please fix this one anyway" },
    ]);
  });

  test("the App's finding prints as the reviewer wrote it, its escapes read back; a human's as written", () => {
    const threads = [
      {
        id: "T9",
        resolved: false,
        path: "a.ts",
        line: 2,
        author: "bengous-labs-agents",
        body: String.raw`**Important**: reads review-\<head>.json`,
        replies: [],
      },
      {
        id: "T10",
        resolved: false,
        path: "a.ts",
        line: 3,
        author: "bengous",
        body: String.raw`keep \<word`,
        replies: [],
      },
    ];

    expect(wakesOf(7, { ...OPEN, threads }).map((wake) => wake.line)).toEqual([
      "Comment T9 on a.ts:2 by bengous-labs-agents: **Important**: reads review-<head>.json",
      String.raw`Comment T10 on a.ts:3 by bengous: keep \<word`,
    ]);
  });

  test("a conversation comment prints, except the App's own and the author's marked ones", () => {
    const comments = [
      { id: "11", author: "bengous", body: "rename the command to reopen" },
      { id: "12", author: "bengous-labs-agents", body: "Merge bot state for this PR" },
      { id: "13", author: "bengous-labs-author", body: `done\n\n${AUTHOR_MARK}` },
    ];

    expect(wakesOf(7, { ...OPEN, comments })).toEqual([
      { key: "comment:11", line: "Comment on PR #7 by bengous: rename the command to reopen" },
    ]);
  });

  test("a draft PR says it is the author's turn, once per head", () => {
    expect(wakesOf(7, { ...OPEN, draft: true })).toEqual([
      { key: `draft:${HEAD}`, line: "PR #7 is a draft again at c0ffee1: fix or answer the findings, then stop." },
    ]);
  });

  test("a landed or closed PR gives no Wake, whatever else it carries", () => {
    const checks = [{ name: "validate", bucket: "fail", link: "https://ci/1" }];

    expect(wakesOf(7, { ...OPEN, state: "MERGED", draft: true, checks })).toEqual([]);
    expect(wakesOf(7, { ...OPEN, state: "CLOSED", draft: true, checks })).toEqual([]);
  });
});

describe("endOf", () => {
  test("a landed or closed PR ends the PR watch with its end line; an open one does not", () => {
    expect(endOf(7, { ...OPEN, state: "MERGED", draft: true })).toBe("PR #7 landed. Stop watching.");
    expect(endOf(7, { ...OPEN, state: "CLOSED" })).toBe("PR #7 closed. Stop watching.");
    expect(endOf(7, OPEN)).toBeNull();
  });
});

describe("readingOf", () => {
  test("a PR watch armed again after its end line was printed ends at once and prints nothing", () => {
    expect(readingOf(7, { ...OPEN, state: "MERGED" }, new Set([END_KEY]))).toEqual({ wakes: [], ends: true });
    expect(readingOf(7, { ...OPEN, state: "CLOSED" }, new Set([END_KEY]))).toEqual({ wakes: [], ends: true });
  });

  test("a landed PR prints its end line, and only it, then ends", () => {
    const checks = [{ name: "validate", bucket: "fail", link: "https://ci/1" }];

    expect(readingOf(7, { ...OPEN, state: "MERGED", checks }, new Set())).toEqual({
      wakes: [{ key: END_KEY, line: "PR #7 landed. Stop watching." }],
      ends: true,
    });
  });

  test("an open PR prints only the Wakes not printed yet, and goes on", () => {
    const checks = [{ name: "validate", bucket: "fail", link: "https://ci/1" }];

    expect(readingOf(7, { ...OPEN, draft: true, checks }, new Set([`check:validate:${HEAD}`]))).toEqual({
      wakes: [
        { key: `draft:${HEAD}`, line: "PR #7 is a draft again at c0ffee1: fix or answer the findings, then stop." },
      ],
      ends: false,
    });
  });
});

const threads = (nodes: readonly object[]): string =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });

describe("prStateOf", () => {
  const view = JSON.stringify({ headRefOid: HEAD, isDraft: true, state: "OPEN" });

  test("reads the view, the checks, each conversation line and the threads gh prints", () => {
    const checks = JSON.stringify([{ bucket: "fail", link: "https://ci/1", name: "validate" }]);

    const conversation = [
      JSON.stringify({ id: "11", author: "bengous-labs-agents[bot]", body: "state" }),
      JSON.stringify({ id: "12", author: "owner", body: "hi" }),
      "",
    ].join("\n");

    const thread = {
      id: "T1",
      isResolved: false,
      path: "a.ts",
      line: null,
      comments: {
        nodes: [
          { id: "C1", author: null, body: "finding" },
          { id: "C2", author: { login: "owner" }, body: "reply" },
        ],
      },
    };

    expect(prStateOf(view, checks, conversation, threads([thread]))).toEqual({
      state: "OPEN",
      draft: true,
      head: HEAD,
      checks: [{ name: "validate", bucket: "fail", link: "https://ci/1" }],
      threads: [
        {
          id: "T1",
          resolved: false,
          path: "a.ts",
          line: null,
          author: "unknown",
          body: "finding",
          replies: [{ id: "C2", author: "owner", body: "reply" }],
        },
      ],
      comments: [
        { id: "11", author: "bengous-labs-agents", body: "state" },
        { id: "12", author: "owner", body: "hi" },
      ],
    });
  });

  test("a conversation comment by a deleted user reads, its author unknown", () => {
    const conversation = JSON.stringify({ id: "13", author: null, body: "old" });

    expect(prStateOf(view, "", conversation, threads([])).comments).toEqual([
      { id: "13", author: "unknown", body: "old" },
    ]);
  });

  test("no checks printed is no check", () => {
    expect(prStateOf(view, "", "", threads([])).checks).toEqual([]);
  });

  test("what gh prints outside its schema throws, naming the command", () => {
    const draft = JSON.stringify({ headRefOid: HEAD, isDraft: false, state: "DRAFT" });

    expect(() => prStateOf(draft, "", "", threads([]))).toThrow('gh pr view: Expected "OPEN" | "MERGED" | "CLOSED"');
    expect(() => prStateOf(view, "", JSON.stringify({ id: 11, author: "a", body: "b" }), threads([]))).toThrow(
      'a conversation comment: Expected string\n  at ["id"]',
    );
    expect(() => prStateOf(view, "", "", JSON.stringify({ data: null }))).toThrow("the review threads query: ");
    expect(() => prStateOf(view, JSON.stringify([{ name: "validate", bucket: "fail" }]), "", threads([]))).toThrow(
      'gh pr checks: Missing key\n  at [0]["link"]',
    );
  });
});

describe("SeenKeys", () => {
  test("the seen file is a list of keys; anything else is refused", () => {
    expect(decodeJson(SeenKeys, "watch-7.json", JSON.stringify(["end", "draft:x"]))).toEqual(["end", "draft:x"]);
    expect(() => decodeJson(SeenKeys, "watch-7.json", JSON.stringify({ end: true }))).toThrow("watch-7.json: ");
  });
});
