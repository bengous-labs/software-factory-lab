import { describe, expect, test } from "bun:test";

import { DONE_JUDGE } from "./done-judge.actor.ts";

describe("the Done judge's settings", () => {
  test("a fork reads with the read-only tools alone: no tool that writes, fetches, waits or delegates, and never none", () => {
    expect(DONE_JUDGE.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  });

  test("a fork asks its user nothing, and has three minutes", () => {
    expect(DONE_JUDGE.permissionMode).toBe("dontAsk");
    expect(DONE_JUDGE.timeoutMs).toBe(180_000);
  });
});
