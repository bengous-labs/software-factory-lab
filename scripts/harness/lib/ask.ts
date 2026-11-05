/**
 * One headless model call through the Agent SDK: a prompt in, an answer to a JSON schema out, and no
 * tool. The tool list is empty, no filesystem setting, CLAUDE.md, hook or MCP server is loaded, and a
 * `PreToolUse` hook refuses by code every tool call but the one that returns the schema's answer.
 */

import { type HookCallback, type Options, query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export interface Question {
  readonly model: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type Answer =
  | { readonly kind: "answered"; readonly structured: unknown; readonly costUsd: number }
  | { readonly kind: "failed"; readonly error: string; readonly costUsd: number | null };

/** Asks one question; never throws, a failure is an answer of kind `failed`. */
export type Ask = (question: Question) => Promise<Answer>;

/** The tool Claude Code adds to a session with an output schema, to return the schema's answer. */
export const STRUCTURED_OUTPUT = "StructuredOutput";

export function toolDecision(toolName: string): "allow" | "deny" {
  return toolName === STRUCTURED_OUTPUT ? "allow" : "deny";
}

export const refuseTools: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};

  const decision = toolDecision(input.tool_name);

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(decision === "deny" ? { permissionDecisionReason: "this call runs with no tool" } : {}),
    },
  };
};

export function optionsOf(question: Question, abortController: AbortController): Options {
  return {
    model: question.model,
    cwd: question.cwd,
    abortController,
    tools: [],
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    permissionMode: "dontAsk",
    outputFormat: { type: "json_schema", schema: { ...question.schema } },
    hooks: { PreToolUse: [{ hooks: [refuseTools], onFailure: "block" }] },
  };
}

/** The answer a call's result message carries; `thrown` is what the call threw, if it threw. */
export function answerOf(result: SDKResultMessage | undefined, thrown: string | null): Answer {
  if (result === undefined) return { kind: "failed", error: thrown ?? "the call ended without a result", costUsd: null };

  const costUsd = result.total_cost_usd;

  if (result.subtype !== "success") return { kind: "failed", error: `${result.subtype}: ${result.errors.join("; ")}`, costUsd };

  if (result.is_error) return { kind: "failed", error: result.result || "the result is flagged as an error", costUsd };

  if (result.structured_output === undefined) return { kind: "failed", error: "the result carries no structured output", costUsd };

  return { kind: "answered", structured: result.structured_output, costUsd };
}

export const ask: Ask = async (question) => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), question.timeoutMs);
  let result: SDKResultMessage | undefined;
  let thrown: string | null = null;

  try {
    for await (const message of query({ prompt: question.prompt, options: optionsOf(question, abortController) })) {
      if (message.type === "result") result = message;
    }
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  return answerOf(result, abortController.signal.aborted ? `timed out after ${question.timeoutMs} ms` : thrown);
};
