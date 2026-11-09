import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { $ } from "bun";

import { answerOf, hookInputOf, refusalFor } from "./refuse-dispatch.ts";

const SCRIPT = join(import.meta.dir, "refuse-dispatch.ts");

const skillCall = (skill: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill, args: "12" }, cwd: "/r" });

const typedCommand = (command_name: string) =>
  JSON.stringify({
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_name,
    command_args: "12",
    command_source: "plugin",
    prompt: `/${command_name} 12`,
    cwd: "/r",
  });

describe("hookInputOf", () => {
  test("reads the skill of a Skill call and the name of a typed command", () => {
    expect(hookInputOf(skillCall("github-flow:dispatch"))).toEqual({
      hook_event_name: "PreToolUse",
      tool_input: { skill: "github-flow:dispatch" },
    });
    expect(hookInputOf(typedCommand("github-flow:shift"))).toEqual({
      hook_event_name: "UserPromptExpansion",
      command_name: "github-flow:shift",
    });
  });

  test("refuses an input that is neither", () => {
    expect(() => hookInputOf("null")).toThrow("the hook input: Expected");
    expect(() => hookInputOf(JSON.stringify({ hook_event_name: "PreToolUse", tool_input: {} }))).toThrow(
      "the hook input",
    );
  });
});

describe("refusalFor", () => {
  test("refuses dispatch and shift, naming the skill and the Worker session to start instead", () => {
    for (const name of ["github-flow:dispatch", "github-flow:shift"]) {
      const reason = refusalFor(name);

      expect(reason).toStartWith(`Refused: \`${name}\` runs each Worker as a subagent`);
      expect(reason).toContain("EnterWorktree");
    }
  });

  test("lets every other skill run", () => {
    for (const name of ["github-flow:pr", "github-flow:issue", "git:commit", "dispatch", "code-review"]) {
      expect(refusalFor(name)).toBeNull();
    }
  });
});

describe("answerOf", () => {
  test("denies a refused Skill call", () => {
    expect(JSON.parse(answerOf(hookInputOf(skillCall("github-flow:dispatch"))) ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: refusalFor("github-flow:dispatch"),
      },
    });
  });

  test("blocks a refused typed command", () => {
    expect(JSON.parse(answerOf(hookInputOf(typedCommand("github-flow:shift"))) ?? "")).toEqual({
      decision: "block",
      reason: refusalFor("github-flow:shift"),
    });
  });

  test("answers nothing for any other skill or command", () => {
    expect(answerOf(hookInputOf(skillCall("github-flow:pr")))).toBeNull();
    expect(answerOf(hookInputOf(typedCommand("code-review")))).toBeNull();
  });
});

const runHook = (stdin: string) => $`bun ${SCRIPT} < ${Buffer.from(stdin)}`.nothrow().quiet();

describe("the hook", () => {
  test("prints the refusal for dispatch, and nothing for another skill", async () => {
    const refused = await runHook(skillCall("github-flow:dispatch"));
    const allowed = await runHook(typedCommand("github-flow:pr"));

    expect(refused.exitCode).toBe(0);
    expect(JSON.parse(refused.stdout.toString())).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout.toString()).toBe("");
  });

  test("fails on an input that does not read", async () => {
    const ran = await runHook("not json");

    expect(ran.exitCode).not.toBe(0);
    expect(ran.stderr.toString()).toContain("the hook input");
  });
});
