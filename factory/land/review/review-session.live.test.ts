import { describe, expect, test } from "bun:test";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Schema } from "effect";

import type { Stream } from "../shared/ask.live.ts";
import type { ReviewCall, ToolGuard } from "../shared/review.port.ts";
import { CODE_REVIEW } from "./code-review.actor.ts";
import { FORK_PARENT, optionsOf, sessionWith } from "./review-session.live.ts";

const SONNET = "claude-sonnet-5-5";

const allowReads: ToolGuard = (toolName) =>
  toolName === "Read" ? { kind: "allow" } : { kind: "deny", reason: `no ${toolName}` };

const CALL: ReviewCall = {
  prompt: "/code-review medium --max-findings all a...b",
  cwd: "/work/pr",
  model: "sonnet",
  effort: "medium",
  tools: CODE_REVIEW.tools,
  outputSchema: { type: "object" },
  guard: allowReads,
  timeoutMs: 1000,
  env: { PATH: "/usr/bin", HOME: "/home/runner", CLAUDE_CONFIG_DIR: "/tmp/fresh" },
};

function message(fields: Readonly<Record<string, Schema.Json>>): SDKMessage {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: a test fixture holding only the fields the session reads, in the shape the phase 0 runs logged.
  return { uuid: "u", session_id: "s", ...fields } as unknown as SDKMessage;
}

const INIT = message({ type: "system", subtype: "init", claude_code_version: "2.1.318" });

const structuredCall = (id: string, input: Schema.Json, parent: string = FORK_PARENT): SDKMessage =>
  message({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name: "StructuredOutput", input }] },
  });

const toolResult = (id: string, isError: boolean, parent: string = FORK_PARENT): SDKMessage =>
  message({
    type: "user",
    parent_tool_use_id: parent,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: isError ? "Output does not match required schema" : "Structured output provided successfully",
        },
      ],
    },
  });

const RESULT = message({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Command completed",
  num_turns: 0,
  modelUsage: {
    [SONNET]: {
      inputTokens: 41_022,
      outputTokens: 3310,
      cacheReadInputTokens: 812_400,
      cacheCreationInputTokens: 60_211,
    },
  },
});

const FINDINGS = { findings: [] };

interface RecordedStream {
  readonly stream: Stream;
  readonly calls: ReadonlyArray<{ readonly prompt: string; readonly options: Options }>;
}

function streamOf(messages: readonly SDKMessage[]): RecordedStream {
  const calls: Array<{ prompt: string; options: Options }> = [];

  return {
    async *stream(call) {
      calls.push(call);
      yield* messages;
    },
    calls,
  };
}

/** A stream that yields nothing until the session aborts it, then throws as the SDK does. */
const untilAborted: Stream = (call) => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      new Promise<never>((_, reject) => {
        call.options.abortController?.signal.addEventListener("abort", () => {
          reject(new Error("Claude Code process aborted by user"));
        });
      }),
  }),
});

describe("optionsOf", () => {
  test("read-only tools under the guard, the code-review skill only, nothing loaded from the checkout, and the call's env alone", () => {
    const options = optionsOf(CALL, new AbortController());

    expect(options).toMatchObject({
      model: "sonnet",
      effort: "medium",
      cwd: "/work/pr",
      tools: ["Read", "Grep", "Glob", "Bash", "Agent", "Skill"],
      permissionMode: "dontAsk",
      skills: ["code-review"],
      settingSources: [],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      persistSession: false,
    });
    expect(options.tools).not.toContain("ReportFindings");
    expect(options.env).toEqual(CALL.env);
    expect(options.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(options.hooks?.PreToolUse?.[0]?.onFailure).toBe("block");
    expect(options.allowedTools).toBeUndefined();
  });
});

describe("sessionWith", () => {
  test("the fork's accepted StructuredOutput call is the answer, with the Claude Code version, model and tokens", async () => {
    const { stream, calls } = streamOf([INIT, structuredCall("c1", FINDINGS), toolResult("c1", false), RESULT]);

    expect(await sessionWith(stream)(CALL)).toEqual({
      kind: "answered",
      structured: FINDINGS,
      model: SONNET,
      claudeCodeVersion: "2.1.318",
      tokens: { input: 41_022, output: 3310, cacheRead: 812_400, cacheCreation: 60_211 },
    });
    expect(calls[0]?.prompt).toBe(CALL.prompt);
  });

  test("a call the CLI refuses against the schema is not the answer; the next accepted one is", async () => {
    const second = { findings: [{ file: "a.ts" }] };

    const { stream } = streamOf([
      structuredCall("c1", { findings: "bad" }),
      toolResult("c1", true),
      structuredCall("c2", second),
      toolResult("c2", false),
      RESULT,
    ]);

    expect(await sessionWith(stream)(CALL)).toMatchObject({ kind: "answered", structured: second });
  });

  test("a StructuredOutput call from another parent, or none at all, fails the session", async () => {
    const elsewhere = streamOf([
      structuredCall("c1", FINDINGS, "toolu_sub"),
      toolResult("c1", false, "toolu_sub"),
      RESULT,
    ]);

    const nothing = streamOf([INIT, RESULT]);

    for (const { stream } of [elsewhere, nothing]) {
      expect(await sessionWith(stream)(CALL)).toMatchObject({
        kind: "failed",
        error: "no StructuredOutput call from the forked review",
      });
    }
  });

  test("an error result fails with its subtype and errors", async () => {
    const error = message({
      type: "result",
      subtype: "error_during_execution",
      errors: ["overloaded"],
      modelUsage: {},
    });

    expect(await sessionWith(streamOf([error]).stream)(CALL)).toMatchObject({
      kind: "failed",
      error: "error_during_execution: overloaded",
    });
  });

  test("a session that outlives its timeout is aborted and fails with the delay", async () => {
    expect(await sessionWith(untilAborted)({ ...CALL, timeoutMs: 10 })).toEqual({
      kind: "failed",
      error: "timed out after 10 ms",
      model: null,
      claudeCodeVersion: null,
      tokens: null,
    });
  });
});
