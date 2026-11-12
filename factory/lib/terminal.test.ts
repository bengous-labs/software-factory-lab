import { describe, expect, test } from "bun:test";

import { printableOf } from "./terminal.ts";

describe("printableOf", () => {
  test("drops the control characters an issue title may carry, escape sequences included", () => {
    expect(printableOf("Add\u001B[2J a\u0007 flag\u009B\n")).toBe("Add[2J a flag");
  });
});
