import { describe, expect, test } from "bun:test";

import { ROUTING_JUDGE } from "./routing-judge.actor.ts";

describe("the Routing judge's settings", () => {
  test("it reads with the read-only tools alone: no tool that writes, fetches, waits or delegates, and never none", () => {
    expect(ROUTING_JUDGE.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  });

  test("it runs on a small model, and has three minutes", () => {
    expect(ROUTING_JUDGE.model).toBe("haiku");
    expect(ROUTING_JUDGE.timeoutMs).toBe(180_000);
  });
});
