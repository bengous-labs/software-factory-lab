import { describe, expect, test } from "bun:test";

import { bashCallOf, partsOf } from "./bash.ts";

describe("bashCallOf", () => {
  test("reads tool_input.command and cwd, and an empty command when there is none", () => {
    expect(bashCallOf(JSON.stringify({ cwd: "/repo", tool_input: { command: "git status" } }))).toEqual({
      command: "git status",
      cwd: "/repo",
    });
    expect(bashCallOf(JSON.stringify({ cwd: "/repo", tool_input: {} }))).toEqual({ command: "", cwd: "/repo" });
  });

  test("refuses an input that is not a tool call's", () => {
    expect(() => bashCallOf("null")).toThrow("the PreToolUse input: Expected object");
    expect(() => bashCallOf(JSON.stringify({ tool_input: {} }))).toThrow('Missing key\n  at ["cwd"]');
  });
});

describe("partsOf", () => {
  test("cuts at operators, and keeps a quoted operator inside its word", () => {
    expect(partsOf('git add . && git commit -m "a; b" | cat\n(ls) || x & y;z')).toEqual([
      ["git", "add", "."],
      "&&",
      ["git", "commit", "-m", "a; b"],
      "|",
      ["cat"],
      ";",
      "(",
      ["ls"],
      ")",
      "||",
      ["x"],
      "&",
      ["y"],
      ";",
      ["z"],
    ]);
    expect(partsOf("git commit -m ''")).toEqual([["git", "commit", "-m", ""]]);
  });
});
