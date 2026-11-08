import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BASH_REASON, PATH_REASON } from "../review/tool-guard.ts";
import { forkGuardAnswer, scopeOf } from "./fork-guard.ts";

/** An Author's worktree with one file and a `.git` directory, and a file outside it. */
function worktree() {
  const base = mkdtempSync(join(tmpdir(), "fork-guard-"));
  const cwd = join(base, "worktree");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(cwd, "a.ts"), "export {};\n");
  writeFileSync(join(cwd, ".git", "config"), "");
  writeFileSync(join(base, "secret"), "");

  return { cwd, outside: join(base, "secret") };
}

const ALLOWED = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });

const denied = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });

/** The hook's output for one tool call of a fork whose cwd is `cwd`. */
function answer(cwd: string, toolName: string, toolInput: Record<string, string>): string {
  const stdin = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd });

  return forkGuardAnswer(stdin, scopeOf);
}

/** A scope that throws, as `scopeOf` does on a worktree that does not resolve. */
function throwing(cwd: string): never {
  throw new Error(`no worktree at ${cwd}`);
}

describe("forkGuardAnswer", () => {
  test("a Read of a file in the Author's worktree is allowed", () => {
    const { cwd } = worktree();

    expect(answer(cwd, "Read", { file_path: join(cwd, "a.ts") })).toBe(ALLOWED);
    expect(answer(cwd, "Read", { file_path: "a.ts" })).toBe(ALLOWED);
  });

  test("Grep and Glob in the worktree are allowed", () => {
    const { cwd } = worktree();

    expect(answer(cwd, "Grep", { pattern: "export", path: cwd })).toBe(ALLOWED);
    expect(answer(cwd, "Grep", { pattern: "export" })).toBe(ALLOWED);
    expect(answer(cwd, "Glob", { pattern: "**/*.ts" })).toBe(ALLOWED);
  });

  test("a read-only git command is allowed", () => {
    const { cwd } = worktree();

    expect(answer(cwd, "Bash", { command: "git diff origin/dev...HEAD --stat" })).toBe(ALLOWED);
  });

  test("a git push, bun check or a chained command is denied with the Bash reason", () => {
    const { cwd } = worktree();

    for (const command of ["git push", "bun check", "git log; env"]) {
      expect(answer(cwd, "Bash", { command })).toBe(denied(BASH_REASON));
    }
  });

  test("a Read outside the worktree, or under .git, is denied with the path reason", () => {
    const { cwd, outside } = worktree();

    expect(answer(cwd, "Read", { file_path: outside })).toBe(denied(PATH_REASON));
    expect(answer(cwd, "Read", { file_path: join(cwd, ".git", "config") })).toBe(denied(PATH_REASON));
  });

  test("Monitor, Write, Edit, Agent and Skill are denied when a call reaches the guard", () => {
    const { cwd } = worktree();

    for (const tool of ["Monitor", "Write", "Edit", "Agent", "Skill"]) {
      expect(answer(cwd, tool, {})).toBe(denied(`the tool ${tool} is not admitted here`));
    }
  });

  test("a guard that throws, such as on a worktree that does not resolve, denies the call", () => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/gone" });

    expect(forkGuardAnswer(stdin, throwing)).toBe(denied("the fork guard failed: no worktree at /gone"));
    expect(forkGuardAnswer(stdin, scopeOf)).toStartWith(denied("the fork guard failed: ENOENT").slice(0, -3));
  });

  test("an input that does not decode is denied", () => {
    expect(forkGuardAnswer("not json", scopeOf)).toBe(denied("the hook input does not read"));
    expect(forkGuardAnswer(JSON.stringify({ tool_name: "Read", cwd: "/" }), scopeOf)).toBe(
      denied("the hook input does not read"),
    );
  });
});
