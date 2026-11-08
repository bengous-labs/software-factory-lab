/**
 * One headless model call through the Agent SDK: a prompt in, an answer to a JSON schema out, and the
 * read-only tools the caller's guard allows call by call. No filesystem setting, CLAUDE.md, hook or MCP
 * server is loaded, and the process gets only the environment the call names.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";

import type { Answer, Ask, Question } from "../ports/ask.ts";
import type { ToolDecision, ToolGuard } from "../ports/review.ts";

/** The tool Claude Code adds to a session with an output schema, to return the schema's answer. */
export const STRUCTURED_OUTPUT = "StructuredOutput";

const decodeToolInput = Schema.decodeUnknownOption(Schema.JsonObject);

/** A PreToolUse hook that asks `guard` about every tool call and turns its decision into a permission decision. */
export function guardHook(guard: ToolGuard): HookCallback {
  return (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return Promise.resolve({});
    }

    const decision = Option.match(decodeToolInput(input.tool_input), {
      onNone: (): ToolDecision => ({ kind: "deny", reason: "the tool input is not a JSON object" }),
      onSome: (toolInput) => guard(input.tool_name, toolInput),
    });

    return Promise.resolve({
      hookSpecificOutput:
        decision.kind === "allow"
          ? { hookEventName: "PreToolUse", permissionDecision: "allow" }
          : { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
    });
  };
}

export function optionsOf(question: Question, abortController: AbortController): Options {
  return {
    model: question.model,
    cwd: question.cwd,
    abortController,
    tools: ["Read", "Grep", "Glob", "Bash"],
    env: { ...question.env },
    strictMcpConfig: true,
    settingSources: [],
    settings: { disableAllHooks: true },
    persistSession: false,
    permissionMode: "dontAsk",
    outputFormat: { type: "json_schema", schema: question.schema },
    hooks: { PreToolUse: [{ hooks: [guardHook(question.guard)], onFailure: "block" }] },
  };
}

/** The exact model of a call: the one that cost the most, when several ran. */
export function modelOf(modelUsage: Readonly<Record<string, { readonly costUSD: number }>>): string | null {
  return Object.entries(modelUsage).toSorted((a, b) => b[1].costUSD - a[1].costUSD)[0]?.[0] ?? null;
}

/** The answer a call's result message carries; `thrown` is what the call threw, if it threw. */
export function answerOf(result: SDKResultMessage | undefined, thrown: string | null): Answer {
  if (result === undefined) {
    return { kind: "failed", error: thrown ?? "the call ended without a result", costUsd: null, model: null };
  }

  const costUsd = result.total_cost_usd;
  const model = modelOf(result.modelUsage);
  const failed = (error: string): Answer => ({ kind: "failed", error, costUsd, model });

  if (result.subtype !== "success") {
    return failed(`${result.subtype}: ${result.errors.join("; ")}`);
  }

  if (result.is_error) {
    return failed(result.result || "the result is flagged as an error");
  }

  if (result.structured_output === undefined) {
    return failed("the result carries no structured output");
  }

  return { kind: "answered", structured: result.structured_output, costUsd, model };
}

/** The messages of one SDK call, as `query()` yields them. */
export type Stream = (call: { readonly prompt: string; readonly options: Options }) => AsyncIterable<SDKMessage>;

/** An `Ask` over `stream`; the timer aborts the call, and a result read before the abort still answers. */
export function askWith(stream: Stream): Ask {
  return async (question) => {
    const abortController = new AbortController();

    const timer = setTimeout(() => {
      abortController.abort();
    }, question.timeoutMs);

    let result: SDKResultMessage | undefined;
    let thrown: string | null = null;

    try {
      for await (const message of stream({ prompt: question.prompt, options: optionsOf(question, abortController) })) {
        if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    return answerOf(result, abortController.signal.aborted ? `timed out after ${question.timeoutMs} ms` : thrown);
  };
}

export const ask: Ask = askWith(query);
