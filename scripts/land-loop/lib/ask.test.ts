import { describe, expect, test } from "bun:test";

import type { Options, PreToolUseHookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  type Answer,
  answerOf,
  askWith,
  modelOf,
  optionsOf,
  type Question,
  refuseTools,
  type Stream,
  STRUCTURED_OUTPUT,
  toolDecision,
} from "./ask.ts";

const HAIKU = "claude-haiku-5-5";

const QUESTION: Question = { model: "haiku", prompt: "p", schema: { type: "object" }, cwd: "/repo", timeoutMs: 1000 };

const preToolUse = (toolName: string): PreToolUseHookInput => ({
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: {},
  tool_use_id: "t1",
  session_id: "s",
  transcript_path: "/t.jsonl",
  cwd: "/repo",
});

const decisionOf = async (toolName: string): Promise<unknown> =>
  (await refuseTools(preToolUse(toolName), "t1", { signal: new AbortController().signal })) as unknown;

function result(fields: Record<string, unknown>): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.01,
    modelUsage: { [HAIKU]: { costUSD: 0.01 } },
    ...fields,
  } as unknown as SDKResultMessage;
}

describe("tools", () => {
  test("every tool is refused but the one that returns the schema's answer", () => {
    for (const name of [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "WebFetch",
      "Agent",
      "mcp__github__create_pull_request",
    ]) {
      expect(toolDecision(name)).toBe("deny");
    }

    expect(toolDecision(STRUCTURED_OUTPUT)).toBe("allow");
  });

  test("the hook turns that decision into a PreToolUse permission decision", async () => {
    expect(await decisionOf("Write")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "this call runs with no tool",
      },
    });
    expect(await decisionOf(STRUCTURED_OUTPUT)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
  });

  test("the options list no tool, load no setting, deny every prompt, and block a failing guard", () => {
    const options = optionsOf(QUESTION, new AbortController());

    expect(options).toEqual(
      expect.objectContaining({
        model: "haiku",
        cwd: "/repo",
        tools: [],
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        permissionMode: "dontAsk",
        outputFormat: { type: "json_schema", schema: { type: "object" } },
      }),
    );
    expect(options.hooks?.PreToolUse).toEqual([{ hooks: [refuseTools], onFailure: "block" }]);
    expect(options.canUseTool).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
  });
});

describe("modelOf", () => {
  test("the exact model is the one that cost the most", () => {
    expect(modelOf({ [HAIKU]: { costUSD: 0.001 }, "claude-opus-5-5": { costUSD: 0.049 } })).toBe("claude-opus-5-5");
    expect(modelOf({})).toBeNull();
  });
});

describe("answerOf", () => {
  test("a success with structured output is an answer, with its cost and its model", () => {
    expect(answerOf(result({ structured_output: { findings: [] } }), null)).toEqual({
      kind: "answered",
      structured: { findings: [] },
      costUsd: 0.01,
      model: HAIKU,
    });
  });

  test("an error result fails with its subtype and errors, and keeps its cost and its model", () => {
    const failed = result({ subtype: "error_max_structured_output_retries", errors: ["no valid output"] });

    expect(answerOf(failed, "Claude Code returned an error result")).toEqual({
      kind: "failed",
      error: "error_max_structured_output_retries: no valid output",
      costUsd: 0.01,
      model: HAIKU,
    });
  });

  test("a success flagged as an error, or with no structured output, fails", () => {
    const failed = (error: string): Answer => ({ kind: "failed", error, costUsd: 0.01, model: HAIKU });

    expect(answerOf(result({ is_error: true, result: "API Error: 529" }), null)).toEqual(failed("API Error: 529"));
    expect(answerOf(result({ is_error: true }), null)).toEqual(failed("the result is flagged as an error"));
    expect(answerOf(result({}), null)).toEqual(failed("the result carries no structured output"));
  });

  test("a call that ends without a result fails with what it threw, and names no model", () => {
    expect(answerOf(undefined, "timed out after 1000 ms")).toEqual({
      kind: "failed",
      error: "timed out after 1000 ms",
      costUsd: null,
      model: null,
    });
    expect(answerOf(undefined, null)).toEqual({
      kind: "failed",
      error: "the call ended without a result",
      costUsd: null,
      model: null,
    });
  });
});

describe("askWith", () => {
  const untilAborted = (options: Options): Promise<never> =>
    new Promise((_, reject) =>
      options.abortController?.signal.addEventListener("abort", () => reject(new Error("aborted by the caller"))),
    );

  const streamOf = (
    body: (options: Options) => AsyncGenerator<SDKMessage>,
  ): { stream: Stream; calls: { prompt: string; options: Options }[] } => {
    const calls: { prompt: string; options: Options }[] = [];

    return {
      stream: (call) => {
        calls.push(call);

        return body(call.options);
      },
      calls,
    };
  };

  test("the stream gets the question's prompt and options, and its result is the answer", async () => {
    const { stream, calls } = streamOf(async function* () {
      yield result({ structured_output: { ok: true } });
    });

    expect(await askWith(stream)(QUESTION)).toEqual({
      kind: "answered",
      structured: { ok: true },
      costUsd: 0.01,
      model: HAIKU,
    });
    expect(calls[0]?.prompt).toBe("p");
    expect(calls[0]?.options).toEqual(
      expect.objectContaining({ model: "haiku", tools: [], permissionMode: "dontAsk" }),
    );
  });

  test("an error result followed by a throw answers with the result's error, not the throw", async () => {
    const { stream } = streamOf(async function* () {
      yield result({ subtype: "error_during_execution", errors: ["overloaded"] });
      throw new Error("Claude Code returned an error result");
    });

    expect(await askWith(stream)(QUESTION)).toMatchObject({
      kind: "failed",
      error: "error_during_execution: overloaded",
    });
  });

  test("a throw with no result answers with the thrown message", async () => {
    const { stream } = streamOf(async function* () {
      yield* [];
      throw new Error("Native CLI binary not found");
    });

    expect(await askWith(stream)(QUESTION)).toEqual({
      kind: "failed",
      error: "Native CLI binary not found",
      costUsd: null,
      model: null,
    });
  });

  test("a call that outlives its timeout is aborted and reads as timed out", async () => {
    const { stream } = streamOf(async function* (options) {
      yield* [];
      await untilAborted(options);
    });

    expect(await askWith(stream)({ ...QUESTION, timeoutMs: 10 })).toEqual({
      kind: "failed",
      error: "timed out after 10 ms",
      costUsd: null,
      model: null,
    });
  });

  test("a result read before the timeout still answers when the call is aborted after it", async () => {
    const { stream } = streamOf(async function* (options) {
      yield result({ structured_output: { ok: true } });
      await untilAborted(options);
    });

    expect(await askWith(stream)({ ...QUESTION, timeoutMs: 10 })).toMatchObject({
      kind: "answered",
      structured: { ok: true },
    });
  });

  test("a call that ends in time is not aborted", async () => {
    let signal: AbortSignal | undefined;
    const { stream } = streamOf(async function* (options) {
      signal = options.abortController?.signal;
      yield result({ structured_output: {} });
    });

    await askWith(stream)({ ...QUESTION, timeoutMs: 20 });
    await Bun.sleep(40);

    expect(signal?.aborted).toBe(false);
  });
});
