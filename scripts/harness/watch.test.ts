import { describe, expect, test } from "bun:test";

import { eventsOf, type PrState } from "./watch.ts";

const HEAD = "c0ffee1234567890c0ffee1234567890c0ffee12";

const OPEN: PrState = { state: "OPEN", draft: false, head: HEAD, checks: [], threads: [] };

describe("eventsOf", () => {
  test("a quiet ready PR prints nothing", () => {
    expect(eventsOf(7, OPEN)).toEqual([]);
  });

  test("a failing check prints once per head; a passing or pending one prints nothing", () => {
    const checks = [
      { name: "validate", bucket: "fail", link: "https://ci/1" },
      { name: "land-gate", bucket: "pending", link: "" },
      { name: "agent-review", bucket: "pass", link: "" },
    ];

    expect(eventsOf(7, { ...OPEN, checks })).toEqual([
      { key: `check:validate:${HEAD}`, line: "Check validate failed on c0ffee1: https://ci/1" },
    ]);
  });

  test("an open Important finding or human comment prints with its thread id; a resolved one, a Nit or a Pre-existing prints nothing", () => {
    const threads = [
      { id: "T1", resolved: false, path: "app/src/cli.ts", line: 12, author: "bengous-labs-agents", body: "**Important**: off\n\n<!-- lab-finding severity=important -->" },
      { id: "T2", resolved: true, path: "a.ts", line: 1, author: "x", body: "old" },
      { id: "T3", resolved: false, path: "a.ts", line: 2, author: "bengous-labs-agents", body: "**Nit**: n <!-- lab-finding severity=nit -->" },
      { id: "T4", resolved: false, path: "a.ts", line: 3, author: "bengous-labs-agents", body: "p <!-- lab-finding severity=pre_existing -->" },
      { id: "T5", resolved: false, path: "a.ts", line: 4, author: "bengous", body: "why this name?" },
    ];

    expect(eventsOf(7, { ...OPEN, threads }).map((event) => event.key)).toEqual(["thread:T1", "thread:T5"]);
    expect(eventsOf(7, { ...OPEN, threads })[0]?.line).toStartWith("Finding T1 on app/src/cli.ts:12 by bengous-labs-agents: **Important**: off");
  });

  test("a draft PR says it is the author's turn, once per head", () => {
    expect(eventsOf(7, { ...OPEN, draft: true })).toEqual([
      { key: `draft:${HEAD}`, line: "PR #7 is a draft again at c0ffee1: fix or answer the findings, then stop." },
    ]);
  });

  test("a merged or closed PR ends the watch, whatever else it carries", () => {
    expect(eventsOf(7, { ...OPEN, state: "MERGED", draft: true })).toEqual([
      { key: "end", line: "PR #7 merged. Stop watching." },
    ]);
    expect(eventsOf(7, { ...OPEN, state: "CLOSED" })[0]?.key).toBe("end");
  });
});
