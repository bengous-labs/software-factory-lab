import { describe, expect, test } from "bun:test";

import { requiredOf } from "./env.ts";

describe("requiredOf", () => {
  test("gives the value of a variable that is set", () => {
    expect(requiredOf({ REVIEW_PR: "12" }, "REVIEW_PR")).toBe("12");
  });

  test("refuses a variable that is unset or empty, and names it", () => {
    expect(() => requiredOf({}, "REVIEW_PR")).toThrow("REVIEW_PR is unset");
    expect(() => requiredOf({ REVIEW_PR: "" }, "REVIEW_PR")).toThrow("REVIEW_PR is unset");
  });
});
