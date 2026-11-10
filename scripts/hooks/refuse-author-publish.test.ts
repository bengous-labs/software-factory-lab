import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { answerOf, publishingOf, refusalFor } from "./refuse-author-publish.ts";

const SCRIPT = join(import.meta.dir, "refuse-author-publish.ts");

describe("publishingOf", () => {
  test("git push, gh pr create and gh pr ready publish, whatever their options", () => {
    const cases: Array<[string, string]> = [
      ["git push", "git push"],
      ["git push --force-with-lease -u origin HEAD:refs/heads/feat/1-x", "git push"],
      ["git -C ../other push origin", "git push"],
      ["git -c credential.helper= --git-dir=.git push", "git push"],
      ["/usr/bin/git push", "git push"],
      ["gh pr create --base dev --title x --body y", "gh pr create"],
      ["gh pr new --fill", "gh pr new"],
      ["gh pr ready 12", "gh pr ready"],
      ["gh -R bengous-labs/software-factory-lab pr ready 12", "gh pr ready"],
      ["gh pr --repo o/r create", "gh pr create"],
    ];

    for (const [command, published] of cases) {
      expect(publishingOf(command)).toBe(published);
    }
  });

  test("a publishing command is found after another command, in a subshell, and behind a wrapper or a shell", () => {
    const commands = [
      "git add . && git commit -m x && git push",
      "bun check; gh pr create --fill",
      "(cd ../w && git push)",
      "echo $(git push 2>&1)",
      "echo `git push`",
      "GH_TOKEN=x git push",
      "env GIT_TRACE=1 git push",
      "command git push",
      "timeout 60 git push origin",
      "echo origin | xargs git push",
      'bash -c "git push origin"',
      "sh -lc 'gh pr ready 12'",
      'eval "git push"',
      "eval git push",
      "git push &",
      "true || git push",
    ];

    for (const command of commands) {
      expect(publishingOf(command)).not.toBeNull();
    }
  });

  test("the commands an Author does run publish nothing", () => {
    const commands = [
      "",
      "git status",
      "git add -A && git commit -m 'feat: x'",
      'git commit -m "the guard refuses git push and gh pr create"',
      "git log --grep push",
      "git stash push -m wip",
      "git remote set-url --push origin x",
      "git fetch origin dev && git rebase origin/dev",
      "git -C push status",
      "gh pr view 12 --json state",
      "gh pr checks 12",
      "gh pr list --head feat/1-x",
      "gh api user -q .login",
      "gh issue create --title ready",
      'grep -rn "git push" scripts',
      "bun check",
      'bash -c "git status"',
      "pushd /tmp && popd",
    ];

    for (const command of commands) {
      expect(publishingOf(command)).toBeNull();
    }
  });
});

/** The PreToolUse input of a Bash call of `command`. */
const input = (command: string): string => JSON.stringify({ cwd: "/w", tool_input: { command } });

describe("answerOf", () => {
  test("an Author's publishing command is refused, and told what publishes instead", () => {
    expect(answerOf(input("git push origin HEAD"))).toBe(
      "Refused: an Author does not run `git push`. The Stop hook pushes your branch and opens or readies its pull request when you stop: commit, then stop.",
    );
    expect(answerOf(input("gh pr ready 12"))).toBe(refusalFor("gh pr ready"));
    expect(answerOf(input("gh pr create --fill"))).toBe(refusalFor("gh pr create"));
  });

  test("any other command is allowed", () => {
    expect(answerOf(input("git commit -m x"))).toBeNull();
    expect(answerOf(JSON.stringify({ cwd: "/w", tool_input: {} }))).toBeNull();
  });

  test("an input that does not read is refused: the guard fails closed", () => {
    expect(answerOf("null")).toBe(
      "Refused: the hook that keeps an Author from publishing could not read this call (the PreToolUse input: Expected object).",
    );
    expect(answerOf("")).toStartWith("Refused: the hook that keeps an Author from publishing could not read this call");
  });
});

/** Runs the hook on a Bash call of `command` with `env` added to a clean environment; returns what it printed. */
async function hook(command: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(["bun", SCRIPT], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: new TextEncoder().encode(input(command)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

  expect(code).toBe(0);

  return stdout.trim();
}

describe("the hook", () => {
  test("in an Author session git push, gh pr create and gh pr ready are refused", async () => {
    for (const [command, published] of [
      ["git push", "git push"],
      ["gh pr create --fill", "gh pr create"],
      ["gh pr ready 12", "gh pr ready"],
    ] as const) {
      expect(JSON.parse(await hook(command, { LAB_AUTHOR: "1" }))).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: refusalFor(published),
        },
      });
    }

    expect(await hook("git commit -m x", { LAB_AUTHOR: "1" })).toBe("");
  });

  test("in a session without the marker they are not", async () => {
    for (const command of ["git push", "gh pr create --fill", "gh pr ready 12"]) {
      expect(await hook(command, {})).toBe("");
      expect(await hook(command, { LAB_AUTHOR: "0" })).toBe("");
    }
  });
});
