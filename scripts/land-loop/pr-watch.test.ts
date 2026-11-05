import { describe, expect, test } from "bun:test";

import { AUTHOR_MARK } from "./thread.ts";
import { wakesOf, type PrState } from "./pr-watch.ts";

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

  test("an open Important finding prints as a Finding and a human thread as a Comment, with its thread id; a resolved one, a Nit or a Pre-existing prints nothing", () => {
    const threads = [
      { id: "T1", resolved: false, path: "app/src/cli.ts", line: 12, author: "bengous-labs-agents", body: "**Important**: off\n\n<!-- lab-finding severity=important -->", replies: [] },
      { id: "T2", resolved: true, path: "a.ts", line: 1, author: "x", body: "old", replies: [] },
      { id: "T3", resolved: false, path: "a.ts", line: 2, author: "bengous-labs-agents", body: "**Nit**: n <!-- lab-finding severity=nit -->", replies: [] },
      { id: "T4", resolved: false, path: "a.ts", line: 3, author: "bengous-labs-agents", body: "p <!-- lab-finding severity=pre_existing -->", replies: [] },
      { id: "T5", resolved: false, path: "a.ts", line: 4, author: "bengous", body: "why this name?", replies: [] },
      { id: "T6", resolved: false, path: "a.ts", line: 5, author: "bengous", body: "quoting <!-- lab-finding severity=nit -->", replies: [] },
    ];

    const wakes = wakesOf(7, { ...OPEN, threads });

    expect(wakes.map((wake) => wake.key)).toEqual(["thread:T1", "thread:T5", "thread:T6"]);
    expect(wakes[0]?.line).toStartWith("Finding T1 on app/src/cli.ts:12 by bengous-labs-agents: **Important**: off");
    expect(wakes[1]?.line).toBe("Comment T5 on a.ts:4 by bengous: why this name?");
    expect(wakes[2]?.line).toStartWith("Comment T6 on a.ts:5 by bengous: quoting");
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
          { id: "C2", author: "bengous", body: `Fixed in abc.\n\n${AUTHOR_MARK}` },
          { id: "C4", author: "bengous-labs-agents", body: "re-checked" },
        ],
      },
      { id: "T8", resolved: true, path: "a.ts", line: 1, author: "bengous-labs-agents", body: nit, replies: [{ id: "C3", author: "bengous", body: "old" }] },
    ];

    expect(wakesOf(7, { ...OPEN, threads })).toEqual([
      { key: "comment:C1", line: "Reply in T7 on a.ts:9 by bengous: please fix this one anyway" },
    ]);
  });

  test("a conversation comment prints, except the App's own and the author's marked ones", () => {
    const comments = [
      { id: "11", author: "bengous", body: "rename the command to reopen" },
      { id: "12", author: "bengous-labs-agents", body: "Merge bot state for this PR" },
      { id: "13", author: "bengous", body: `done\n\n${AUTHOR_MARK}` },
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

  test("a landed or closed PR ends the PR watch, whatever else it carries", () => {
    expect(wakesOf(7, { ...OPEN, state: "MERGED", draft: true })).toEqual([
      { key: "end", line: "PR #7 landed. Stop watching." },
    ]);
    expect(wakesOf(7, { ...OPEN, state: "CLOSED" })[0]?.key).toBe("end");
  });
});
