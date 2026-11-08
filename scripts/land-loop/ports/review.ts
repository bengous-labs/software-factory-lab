import type { Schema } from "effect";

import type { TokenCounts } from "../../lib/tokens.ts";

type ReviewEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** The guard's answer to one tool call: allow it, or deny it with a reason the reviewer reads. */
export type ToolDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };

/** Decides one tool call of the review session from the tool's name and its input, read as a JSON object. */
export type ToolGuard = (toolName: string, input: Schema.JsonObject) => ToolDecision;

export interface ReviewCall {
  readonly prompt: string;
  /** The checkout of the pull request's head, where the reviewer reads. */
  readonly cwd: string;
  readonly model: string;
  readonly effort: ReviewEffort;
  /** The JSON Schema the forked review's StructuredOutput call must follow. */
  readonly outputSchema: Schema.JsonObject;
  readonly guard: ToolGuard;
  readonly timeoutMs: number;
  /** The whole environment of the Claude Code process: nothing else of the runner's reaches it. */
  readonly env: Readonly<Record<string, string>>;
}

interface SessionFacts {
  /** The exact model that ran, null when no result names one. */
  readonly model: string | null;
  /** `claude_code_version` of the session's init message, null when none came. */
  readonly claudeCodeVersion: string | null;
  readonly tokens: TokenCounts | null;
}

/** What one review session gave: the input of the fork's accepted StructuredOutput call, or why there is none. */
export type SessionAnswer =
  | (SessionFacts & { readonly kind: "answered"; readonly structured: unknown })
  | (SessionFacts & { readonly kind: "failed"; readonly error: string });

/** Runs one review session; never throws, a failure is an answer of kind `failed`. */
export type ReviewSession = (call: ReviewCall) => Promise<SessionAnswer>;
