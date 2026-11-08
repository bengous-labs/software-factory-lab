import { describe, expect, test } from "bun:test";

import type {
  HookCallback,
  Options,
  PreToolUseHookInput,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Schema } from "effect";

import type { Answer, Question } from "../ports/ask.ts";
import type { ToolGuard } from "../ports/review.ts";
import { answerOf, askWith, guardHook, modelOf, optionsOf } from "./ask.ts";
import type { Stream } from "./ask.ts";

const HAIKU = "claude-haiku-5-5";

const allowReads: ToolGuard = (toolName) =>
  toolName === "Read" ? { kind: "allow" } : { kind: "deny", reason: `no ${toolName}` };

const QUESTION: Question = {
  model: "haiku",
  prompt: "p",
  schema: { type: "object" },
  cwd: "/repo",
  guard: allowReads,
  env: { PATH: "/usr/bin", HOME: "/home/runner", CLAUDE_CONFIG_DIR: "/tmp/fresh" },
  timeoutMs: 1000,
};

const preToolUse = (toolName: string, toolInput: Schema.Json): PreToolUseHookInput => ({
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: "t1",
  session_id: "s",
  transcript_path: "/t.jsonl",
  cwd: "/repo",
});

const noHook: HookCallback = () => Promise.resolve({});

const hookOf = (hook: HookCallback, input: PreToolUseHookInput): ReturnType<HookCallback> =>
  hook(input, "t1", { signal: new AbortController().signal });

function result(fields: Readonly<Record<string, Schema.Json>>): SDKResultMessage {
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: a test fixture holding only the fields answerOf reads.
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

const failedWith = (error: string): Answer => ({ kind: "failed", error, costUsd: 0.01, model: HAIKU });

const untilAborted = (options: Options): Promise<never> =>
  new Promise((_, reject) => {
    options.abortController?.signal.addEventListener("abort", () => {
      reject(new Error("aborted by the caller"));
    });
  });

interface RecordedStream {
  readonly stream: Stream;
  readonly calls: ReadonlyArray<{ readonly prompt: string; readonly options: Options }>;
}

function streamOf(body: (options: Options) => AsyncGenerator<SDKMessage>): RecordedStream {
  const calls: Array<{ prompt: string; options: Options }> = [];

  return {
    stream: (call) => {
      calls.push(call);

      return body(call.options);
    },
    calls,
  };
}

describe("guardHook", () => {
  test("the guard's decision becomes the PreToolUse permission decision, allow included", async () => {
    const hook = guardHook(allowReads);

    expect(await hookOf(hook, preToolUse("Read", { file_path: "/repo/a.ts" }))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(await hookOf(hook, preToolUse("Write", { file_path: "/repo/a.ts" }))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no Write",
      },
    });
  });

  test("a tool input that is not a JSON object is denied before the guard sees it", async () => {
    expect(
      await hookOf(
        guardHook(() => ({ kind: "allow" })),
        preToolUse("Read", "a.ts"),
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "the tool input is not a JSON object",
      },
    });
  });
});

describe("optionsOf", () => {
  test("the read-only tools under the question's guard, no setting or hook loaded, the question's env alone, every prompt denied", async () => {
    const options = optionsOf(QUESTION, new AbortController());

    expect(options).toMatchObject({
      model: "haiku",
      cwd: "/repo",
      tools: ["Read", "Grep", "Glob", "Bash"],
      strictMcpConfig: true,
      settingSources: [],
      settings: { disableAllHooks: true },
      persistSession: false,
      permissionMode: "dontAsk",
    });
    expect(options.env).toEqual(QUESTION.env);
    expect(options.env).not.toBe(QUESTION.env);
    expect(options.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
    expect(options.canUseTool).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();

    const preToolUseHooks = options.hooks?.PreToolUse ?? [];

    expect(preToolUseHooks).toHaveLength(1);
    expect(preToolUseHooks[0]?.onFailure).toBe("block");

    const [hook = noHook] = preToolUseHooks[0]?.hooks ?? [];

    expect(await hookOf(hook, preToolUse("Write", {}))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no Write" },
    });
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
    expect(answerOf(result({ is_error: true, result: "API Error: 529" }), null)).toEqual(failedWith("API Error: 529"));
    expect(answerOf(result({ is_error: true }), null)).toEqual(failedWith("the result is flagged as an error"));
    expect(answerOf(result({}), null)).toEqual(failedWith("the result carries no structured output"));
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
    expect(calls[0]?.options).toMatchObject({ model: "haiku", cwd: "/repo", permissionMode: "dontAsk" });
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
