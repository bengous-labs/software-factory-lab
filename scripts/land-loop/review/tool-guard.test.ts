import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Schema } from "effect";
import * as fc from "fast-check";

import { resolverOf } from "../lib/resolve.ts";
import { BASH_REASON, bashGuard, guardOf, pathGuard, readGuardOf } from "./tool-guard.ts";
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

const kindOfCommand = (command: string): readonly [string, string] => [command, bashGuard(command).kind];

/** Each subcommand with a flag of its own. */
const FLAGGED = [
  "git diff --cached",
  "git log --oneline",
  "git show --stat HEAD",
  "git blame -w app/src/task.ts",
  "git ls-files --cached",
  "git rev-parse --short HEAD",
  "git merge-base --is-ancestor HEAD dev",
  "git status --short",
  "git grep -n cleanTitle",
];

/** Each option that carries a number, a range or a filter in its own token, for the subcommand that admits it. */
const BOUNDED_OPTIONS = [
  ["diff", "-U10"],
  ["diff", "--unified=10"],
  ["diff", "--stat=100"],
  ["diff", "--stat=100,20"],
  ["diff", "--diff-filter=AM"],
  ["log", "-10"],
  ["log", "-n10"],
  ["log", "--max-count=10"],
  ["log", "--skip=10"],
  ["log", "-U10"],
  ["show", "-U10"],
  ["show", "--unified=10"],
  ["blame", "-L10,20"],
  ["blame", "-L10,+20"],
  ["rev-parse", "--short=10"],
  ["grep", "-A10"],
  ["grep", "-B10"],
  ["grep", "-C10"],
  ["grep", "--context=10"],
  ["grep", "--after-context=10"],
  ["grep", "--before-context=10"],
  ["grep", "--max-depth=10"],
] as const;

/** Each option that carries any text in its own token, for the subcommand that admits it. */
const TEXT_OPTIONS = [
  ["log", "--format=%h%n"],
  ["log", "--pretty=%h%n"],
  ["log", "--since=2.weeks"],
  ["log", "--until=2.weeks"],
  ["log", "--author=ann"],
  ["log", "--grep=fix"],
  ["log", "-Sclean"],
  ["log", "-Gclean"],
  ["show", "--format=%h%n"],
  ["show", "--pretty=%h%n"],
] as const;

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
      "cat log README.md",
    ]) {
      expect([command, bashGuard(command)]).toEqual([command, { kind: "deny", reason: BASH_REASON }]);
    }
  });

  test("each subcommand of the list runs bare and with a flag of its own", () => {
    for (const subcommand of [
      "diff",
      "log",
      "show",
      "blame",
      "ls-files",
      "rev-parse",
      "merge-base",
      "status",
      "grep",
    ]) {
      expect(kindOfCommand(`git ${subcommand}`)).toEqual([`git ${subcommand}`, "allow"]);
    }

    for (const command of FLAGGED) {
      expect(kindOfCommand(command)).toEqual([command, "allow"]);
    }
  });

  test("an option that carries its value takes a value of several characters, and nothing before the option", () => {
    for (const [subcommand, option] of [...BOUNDED_OPTIONS, ...TEXT_OPTIONS]) {
      expect(kindOfCommand(`git ${subcommand} ${option}`)).toEqual([`git ${subcommand} ${option}`, "allow"]);
      expect(kindOfCommand(`git ${subcommand} -x${option}`)).toEqual([`git ${subcommand} -x${option}`, "deny"]);
    }
  });

  test("an option that carries a number, a range or a filter takes nothing after its value", () => {
    for (const [subcommand, option] of BOUNDED_OPTIONS) {
      expect(kindOfCommand(`git ${subcommand} ${option}z`)).toEqual([`git ${subcommand} ${option}z`, "deny"]);
    }
  });

  test("an option that takes the next token as its value needs one, of its own pattern and whole", () => {
    for (const command of [
      "git log -n 10",
      "git blame -L 10,20 app/src/task.ts",
      "git blame -L 10,+20 app/src/task.ts",
      "git grep -A 10 cleanTitle",
      "git grep -B 10 cleanTitle",
      "git grep -C 10 cleanTitle",
      "git grep -e cleanTitle",
    ]) {
      expect(kindOfCommand(command)).toEqual([command, "allow"]);
    }

    for (const command of [
      "git log -n x10",
      "git log -n 10z",
      "git blame -L x10,20",
      "git blame -L 10,20z",
      "git grep -A x10",
      "git grep -A 10z",
      "git grep -e",
    ]) {
      expect(kindOfCommand(command)).toEqual([command, "deny"]);
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

  test("a Grep pattern is any text: only the path it searches is held to the checkout", () => {
    expect(kindOf("Grep", { pattern: "/etc/passwd", path: "app" })).toBe("allow");
    expect(kindOf("Grep", { pattern: "/etc/passwd", path: "/etc" })).toBe("deny");
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

describe("readGuardOf", () => {
  /** A worktree of the PR's head beside a checkout of dev, with a link the PR commits that leads out. */
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "read-guard-")));
  const root = join(parent, "pr");
  mkdirSync(join(root, "app/src"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(join(parent, "dev"));
  writeFileSync(join(root, "app/src/cli.ts"), "x\n");
  writeFileSync(join(root, ".git/config"), "[core]\n");
  writeFileSync(join(parent, "dev/AGENTS.md"), "a\n");
  symlinkSync(join(parent, "dev/AGENTS.md"), join(root, "leak"));

  const readGuard = readGuardOf({ root, resolve: resolverOf(root) });
  const pathDenied = { kind: "deny", reason: "read only inside the pull request's checkout, outside .git" } as const;

  test("Read in the worktree, Grep with no path, and a read-only git command are allowed", () => {
    expect(readGuard("Read", { file_path: join(root, "app/src/cli.ts") })).toEqual({ kind: "allow" });
    expect(readGuard("Read", { file_path: "app/src/cli.ts" })).toEqual({ kind: "allow" });
    expect(readGuard("Grep", { pattern: "x" })).toEqual({ kind: "allow" });
    expect(readGuard("Glob", { pattern: "**/*.ts" })).toEqual({ kind: "allow" });
    expect(readGuard("Bash", { command: "git log --oneline -5" })).toEqual({ kind: "allow" });
    expect(readGuard("Bash", { command: "git diff HEAD~1 --stat" })).toEqual({ kind: "allow" });
    expect(readGuard("StructuredOutput", { review: "light" })).toEqual({ kind: "allow" });
  });

  test("a shell command, a git write or a chained command is denied with bashGuard's reason", () => {
    for (const command of ["cat app/src/cli.ts", "git push", "git log; env"]) {
      expect(readGuard("Bash", { command })).toEqual({ kind: "deny", reason: BASH_REASON });
    }
  });

  test("a path outside the worktree, up to its parent, into .git, or through a committed link out is denied", () => {
    for (const file_path of ["/etc/passwd", "../dev/AGENTS.md", join(root, ".git/config"), join(root, "leak")]) {
      expect(readGuard("Read", { file_path })).toEqual(pathDenied);
    }
  });

  test("a write tool, a subagent, a skill, the web and a monitor are not admitted", () => {
    for (const name of ["Write", "Edit", "Agent", "Skill", "WebFetch", "Monitor"]) {
      expect(readGuard(name, {})).toEqual({ kind: "deny", reason: `the tool ${name} is not admitted here` });
    }
  });
});
