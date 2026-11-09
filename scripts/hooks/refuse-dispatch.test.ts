import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { $ } from "bun";
import { Schema } from "effect";

import { decodeJson } from "../lib/json.ts";
import { answerOf, hookInputOf, refusalFor, REFUSED, runOf } from "./refuse-dispatch.ts";

const SCRIPT = join(import.meta.dir, "refuse-dispatch.ts");

const SETTINGS = join(import.meta.dir, "..", "..", ".claude", "settings.json");

/** The hook entries of `.claude/settings.json`, as far as this test reads them. */
const Settings = Schema.Struct({
  hooks: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        matcher: Schema.optionalKey(Schema.String),
        hooks: Schema.Array(Schema.Struct({ command: Schema.String })),
      }),
    ),
  ),
});

/** The matcher of the `event` entry that runs refuse-dispatch.ts. */
function matcherOf(event: string): string | undefined {
  const settings = decodeJson(Settings, SETTINGS, readFileSync(SETTINGS, "utf8"));

  const entry = settings.hooks[event]?.find((candidate) =>
    candidate.hooks.some((hook) => hook.command.includes("scripts/hooks/refuse-dispatch.ts")),
  );

  return entry?.matcher;
}

/**
 * Whether Claude Code fires a hook with `matcher` for `value`: a matcher of letters, digits, `_`, `-`, spaces,
 * `,` and `|` is a list of exact names; any other is an unanchored JavaScript regular expression.
 */
function fires(matcher: string, value: string): boolean {
  return /^[\w\s,|-]*$/u.test(matcher)
    ? matcher.split(/[|,]/u).some((name) => name.trim() === value)
    : new RegExp(matcher, "u").test(value);
}

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

  test("reads a name with a leading slash or surrounding spaces, which the Skill tool still launches", () => {
    for (const name of ["/github-flow:dispatch", " github-flow:dispatch ", "\t/github-flow:shift\n"]) {
      expect(refusalFor(name)).toStartWith("Refused: `github-flow:");
    }
  });

  test("refuses the bare names, which the Skill tool also launches", () => {
    expect(refusalFor("dispatch")).toStartWith("Refused: `dispatch` runs each Worker as a subagent");
    expect(refusalFor(" /shift")).toStartWith("Refused: `shift` runs each Worker as a subagent");
  });

  test("lets every other skill run", () => {
    for (const name of ["github-flow:pr", "github-flow:issue", "git:commit", "other:dispatch", "code-review"]) {
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

  test("prints the block for a typed shift", async () => {
    const blocked = await runHook(typedCommand("github-flow:shift"));

    expect(blocked.exitCode).toBe(0);
    expect(JSON.parse(blocked.stdout.toString())).toEqual({
      decision: "block",
      reason: refusalFor("github-flow:shift"),
    });
  });

  test("refuses with exit 2 an input that does not read, so Claude Code does not run the call", async () => {
    const ran = await runHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_input: { command: "x" } }));

    expect(ran.exitCode).toBe(2);
    expect(ran.stdout.toString()).toBe("");
    expect(ran.stderr.toString()).toStartWith("Refused: refuse-dispatch could not read its input.");
  });
});

describe("runOf", () => {
  test("prints the answer and exits 0 for an input that reads", () => {
    expect(runOf(skillCall("github-flow:pr"))).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(runOf(skillCall("github-flow:dispatch"))).toEqual({
      code: 0,
      stdout: answerOf(hookInputOf(skillCall("github-flow:dispatch"))) ?? "",
      stderr: "",
    });
  });

  test("refuses on stderr with exit 2, naming why, for an input that does not read", () => {
    const run = runOf("not json");

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("the hook input");
  });
});

describe(".claude/settings.json", () => {
  test("the Skill hook runs refuse-dispatch on every Skill call", () => {
    expect(matcherOf("PreToolUse")).toBe("Skill");
  });

  test("the UserPromptExpansion hook fires for every refused name, and for no other command", () => {
    const matcher = matcherOf("UserPromptExpansion") ?? "";

    for (const name of REFUSED) {
      expect(fires(matcher, name)).toBe(true);
    }

    for (const name of ["github-flow:pr", "other:dispatch", "dispatcher", "git:commit"]) {
      expect(fires(matcher, name)).toBe(false);
    }
  });
});
