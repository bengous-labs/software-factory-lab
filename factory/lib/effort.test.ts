import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { Effort } from "./effort.ts";

describe("Effort", () => {
  test("names Claude Code's five levels, lowest first", () => {
    expect(Effort.literals).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test.each(["huge", "High", ""])("refuses %j", (level) => {
    expect(Schema.is(Effort)(level)).toBe(false);
  });
});
