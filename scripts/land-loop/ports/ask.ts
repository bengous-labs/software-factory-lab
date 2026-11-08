import type { Schema } from "effect";

import type { ToolGuard } from "./review.ts";

export interface Question {
  readonly model: string;
  readonly prompt: string;
  /** The JSON Schema the answer must follow; the caller decodes `structured` with its own Effect schema. */
  readonly schema: Schema.JsonObject;
  /** The root the guard reads under. */
  readonly cwd: string;
  readonly guard: ToolGuard;
  /** The whole environment of the Claude Code process: nothing else of the caller's reaches it. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Where a question reads, under which guard, with which environment. */
export type Reader = Pick<Question, "cwd" | "guard" | "env">;

/** `model` is the exact model that ran, null when no result names one. */
export type Answer =
  | { readonly kind: "answered"; readonly structured: unknown; readonly costUsd: number; readonly model: string | null }
  | { readonly kind: "failed"; readonly error: string; readonly costUsd: number | null; readonly model: string | null };

/** Asks one question; never throws, a failure is an answer of kind `failed`. */
export type Ask = (question: Question) => Promise<Answer>;
