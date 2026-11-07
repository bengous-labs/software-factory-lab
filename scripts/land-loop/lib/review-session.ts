/**
 * One review session through the Agent SDK. The prompt starts with `/code-review`, which Claude Code
 * runs as a forked command; the fork reads the checkout with the tools a guard allows call by call,
 * and returns its findings through StructuredOutput. No filesystem setting, hook, skill, CLAUDE.md or
 * MCP server of the checkout is loaded, and the process gets only the environment the call names.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback, Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { Option, Schema } from "effect";

import type { ReviewCall, ReviewSession, SessionAnswer, ToolDecision, ToolGuard } from "../ports/review.ts";
import { modelOf, STRUCTURED_OUTPUT } from "./ask.ts";
import type { Stream } from "./ask.ts";

/** The tools of the session. The CLI adds StructuredOutput itself, for `outputFormat`. */
export const REVIEW_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "Bash", "Agent", "Skill"];

/**
 * The `parent_tool_use_id` Claude Code gives every message of the skill's forked command. An external
 * name: Claude Code writes it, and an answer from any other parent is not the review's.
 */
export const FORK_PARENT = "forked-command-code-review";

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

export function optionsOf(call: ReviewCall, abortController: AbortController): Options {
  return {
    model: call.model,
    effort: call.effort,
    cwd: call.cwd,
    abortController,
    tools: [...REVIEW_TOOLS],
    permissionMode: "dontAsk",
    hooks: { PreToolUse: [{ hooks: [guardHook(call.guard)], onFailure: "block" }] },
    skills: ["code-review"],
    settingSources: [],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    persistSession: false,
    env: { ...call.env },
    outputFormat: { type: "json_schema", schema: call.outputSchema },
  };
}

/** What the stream has shown so far. */
interface Reading {
  readonly claudeCodeVersion: string | null;
  /** The inputs of the fork's StructuredOutput calls, by tool_use id, until their result comes. */
  readonly pending: ReadonlyMap<string, unknown>;
  /** The input of the last fork's StructuredOutput call the CLI accepted. */
  readonly accepted: { readonly input: unknown } | null;
  readonly result: SDKResultMessage | null;
}

const NOTHING_READ: Reading = { claudeCodeVersion: null, pending: new Map(), accepted: null, result: null };

function readFork(reading: Reading, message: SDKMessage): Reading {
  if (message.type === "assistant") {
    const calls = message.message.content.flatMap((block) =>
      block.type === "tool_use" && block.name === STRUCTURED_OUTPUT ? [[block.id, block.input] as const] : [],
    );

    return calls.length === 0 ? reading : { ...reading, pending: new Map([...reading.pending, ...calls]) };
  }

  if (message.type !== "user" || !Array.isArray(message.message.content)) {
    return reading;
  }

  const answered = message.message.content.flatMap((block) =>
    block.type === "tool_result" && block.is_error !== true && reading.pending.has(block.tool_use_id)
      ? [block.tool_use_id]
      : [],
  );

  const last = answered.at(-1);

  return last === undefined ? reading : { ...reading, accepted: { input: reading.pending.get(last) } };
}

/** `reading` with what `message` adds. Only the fork's own StructuredOutput calls can be the answer. */
function readMessage(reading: Reading, message: SDKMessage): Reading {
  if (message.type === "system" && message.subtype === "init") {
    return { ...reading, claudeCodeVersion: message.claude_code_version };
  }

  if (message.type === "result") {
    return { ...reading, result: message };
  }

  return (message.type === "assistant" || message.type === "user") && message.parent_tool_use_id === FORK_PARENT
    ? readFork(reading, message)
    : reading;
}

/** The session's answer once the stream has ended; `failure` is what ended it early, if anything did. */
function answerOf(reading: Reading, failure: string | null): SessionAnswer {
  const { result } = reading;

  const facts = {
    model: result === null ? null : modelOf(result.modelUsage),
    claudeCodeVersion: reading.claudeCodeVersion,
    costUsd: result?.total_cost_usd ?? null,
  };

  const failed = (error: string): SessionAnswer => ({ kind: "failed", error, ...facts });

  if (result === null) {
    return failed(failure ?? "the session ended without a result");
  }

  if (result.subtype !== "success") {
    return failed(`${result.subtype}: ${result.errors.join("; ")}`);
  }

  if (result.is_error) {
    return failed(result.result || "the result is flagged as an error");
  }

  return reading.accepted === null
    ? failed("no StructuredOutput call from the forked review")
    : { kind: "answered", structured: reading.accepted.input, ...facts };
}

/** A `ReviewSession` over `stream`; the timer aborts the session, and a result read before the abort still answers. */
export function sessionWith(stream: Stream): ReviewSession {
  return async (call) => {
    const abortController = new AbortController();

    const timer = setTimeout(() => {
      abortController.abort();
    }, call.timeoutMs);

    let reading = NOTHING_READ;
    let thrown: string | null = null;

    try {
      for await (const message of stream({ prompt: call.prompt, options: optionsOf(call, abortController) })) {
        reading = readMessage(reading, message);
      }
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }

    return answerOf(reading, abortController.signal.aborted ? `timed out after ${call.timeoutMs} ms` : thrown);
  };
}

export const reviewSession: ReviewSession = sessionWith(query);
