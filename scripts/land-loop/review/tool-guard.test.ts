import { describe, expect, test } from "bun:test";

import type { Schema } from "effect";
import * as fc from "fast-check";

import { BASH_REASON, bashGuard, guardOf, pathGuard } from "./tool-guard.ts";
import type { Resolve } from "./tool-guard.ts";

const ROOT = "/work/pr";

/** Resolves like the runner: relative paths against the root, and one committed link that leads out. */
const resolve: Resolve = (path) => {
  const absolute = path.startsWith("/") ? path : `${ROOT}/${path}`;

  if (absolute === `${ROOT}/leak`) {
    return "/proc/1234/environ";
  }

  return absolute.includes("/missing") ? null : absolute;
};

const guard = guardOf({ root: ROOT, resolve });

const kindOf = (toolName: string, input: Schema.JsonObject): string => guard(toolName, input).kind;

describe("bashGuard", () => {
  test("one read-only git command from the list is allowed", () => {
    for (const command of [
      "git diff 812acd2...HEAD",
      "git diff --stat 812acd2...HEAD -- app/src/task.ts",
      "git --no-pager log --oneline -n 5",
      "git log -3 --format=%h%x09%s",
      "git show HEAD:app/src/task.ts",
      "git blame -L 10,20 -- app/src/task.ts",
      "git grep -n -e cleanTitle",
      "git rev-parse HEAD~1",
      "git merge-base HEAD dev",
      "git diff  --stat  HEAD~1",
    ]) {
      expect([command, bashGuard(command).kind]).toEqual([command, "allow"]);
    }
  });

  test("anything else is denied, with the reason the reviewer reads", () => {
    for (const command of [
      "",
      "git",
      "cat README.md",
      "git diff --no-index /etc/hostname /etc/hosts",
      "git -C / log",
      "git -c core.pager=sh log",
      "git log --output=/tmp/x",
      "git log '--output=/tmp/x'",
      "git diff *",
      "git log; cat /proc/self/environ",
      "git log | head",
      "git log $(id)",
      "git show HEAD:../../etc/passwd",
      "git blame -- /proc/self/environ",
      "git blame -L",
      "git log -n many",
      "git grep -f /proc/self/environ",
      "git grep -O cleanTitle",
      "git config --list",
      "git log ~/.ssh",
      "git log\ncat x",
      "env git log",
    ]) {
      expect([command, bashGuard(command)]).toEqual([command, { kind: "deny", reason: BASH_REASON }]);
    }
  });

  test("a command holding a shell operator, a quote or a glob is denied, whatever surrounds it", () => {
    const operator = fc.constantFrom(";", "&", "|", "<", ">", "(", ")", "$", "`", "'", '"', "*", "?", "\\", "\n", "{");
    const word = fc.stringMatching(/^[a-z0-9.-]{0,8}$/u);

    fc.assert(
      fc.property(word, operator, word, (before, op, after) => {
        expect(bashGuard(`git log ${before}${op}${after}`).kind).toBe("deny");
      }),
    );
  });
});

describe("pathGuard", () => {
  test("the root and what is under it pass, .git and what is outside do not", () => {
    expect(pathGuard("/r", "/r")).toBe(true);
    expect(pathGuard("/r/app/x.ts", "/r")).toBe(true);
    expect(pathGuard("/r/.gitignore", "/r")).toBe(true);
    expect(pathGuard("/r/.github/workflows/ci.yml", "/r")).toBe(true);
    expect(pathGuard("/r/.git", "/r")).toBe(false);
    expect(pathGuard("/r/.git/config", "/r")).toBe(false);
    expect(pathGuard("/rx/a", "/r")).toBe(false);
    expect(pathGuard("/proc/self/environ", "/r")).toBe(false);
  });
});

describe("guardOf", () => {
  test("Read, Grep and Glob read only under the checkout, outside .git, links followed", () => {
    expect(kindOf("Read", { file_path: `${ROOT}/app/src/task.ts` })).toBe("allow");
    expect(kindOf("Read", { file_path: "app/src/task.ts", offset: 10 })).toBe("allow");
    expect(kindOf("Read", { file_path: "/proc/self/environ" })).toBe("deny");
    expect(kindOf("Read", { file_path: `${ROOT}/leak` })).toBe("deny");
    expect(kindOf("Read", { file_path: `${ROOT}/.git/config` })).toBe("deny");
    expect(kindOf("Read", { file_path: `${ROOT}/missing` })).toBe("deny");
    expect(kindOf("Read", {})).toBe("deny");
    expect(kindOf("Grep", { pattern: "x" })).toBe("allow");
    expect(kindOf("Grep", { pattern: "x", path: "leak" })).toBe("deny");
    expect(kindOf("Grep", { pattern: "x", path: 3 })).toBe("deny");
    expect(kindOf("Glob", { pattern: "**/*.ts" })).toBe("allow");
    expect(kindOf("Glob", { pattern: "*.ts", path: "/etc" })).toBe("deny");
  });

  test("a Glob pattern stays relative to the checkout", () => {
    expect(guard("Glob", { pattern: "/proc/self/*" })).toEqual({
      kind: "deny",
      reason: "a Glob pattern is relative to the checkout, with no `..` segment",
    });
    expect(kindOf("Glob", { pattern: "../../*" })).toBe("deny");
    expect(kindOf("Glob", { pattern: "~/.claude/*" })).toBe("deny");
    expect(kindOf("Glob", {})).toBe("deny");
  });

  test("Bash goes through bashGuard", () => {
    expect(kindOf("Bash", { command: "git log --oneline -n 3", description: "x" })).toBe("allow");
    expect(kindOf("Bash", { command: "cat README.md" })).toBe("deny");
    expect(kindOf("Bash", {})).toBe("deny");
  });

  test("an Agent call runs here, under the same guard: no isolation, mode or team", () => {
    expect(kindOf("Agent", { description: "d", prompt: "p", subagent_type: "general-purpose" })).toBe("allow");
    expect(kindOf("Agent", { description: "d", prompt: "p", run_in_background: false })).toBe("allow");
    expect(kindOf("Agent", { description: "d", prompt: "p", isolation: "worktree" })).toBe("deny");
    expect(kindOf("Agent", { description: "d", prompt: "p", mode: "bypassPermissions" })).toBe("deny");
    expect(kindOf("Agent", { description: "d", prompt: "p", team_name: "t" })).toBe("deny");
  });

  test("only the code-review skill and the structured answer pass; every other tool is denied by name", () => {
    expect(kindOf("Skill", { skill: "code-review" })).toBe("allow");
    expect(kindOf("Skill", { skill: "simplify" })).toBe("deny");
    expect(kindOf("StructuredOutput", { findings: [] })).toBe("allow");

    for (const name of ["Write", "Edit", "NotebookEdit", "WebFetch", "ReportFindings", "Task"]) {
      expect(guard(name, {})).toEqual({ kind: "deny", reason: `the tool ${name} is not admitted in this review` });
    }
  });
});
