/**
 * The Routing judge, past the Routing rules: the model of `routing-judge.actor.ts` reads the change,
 * headless, with read-only tools under the guard of `shared/tool-guard.ts`, and answers the Review depth and,
 * on a Patch delta, whether it is read again; the Land route is the Routing rules' alone. Any failure, or an
 * answer outside the schema, answers review:deep and a second round: the safe side.
 */

import { Result, Schema } from "effect";

import type { TokenCounts } from "../../lib/tokens.ts";
import type { Ask, Reader } from "../shared/ask.port.ts";
import { ROUTING_JUDGE } from "./routing-judge.actor.ts";
import { routingPromptOf } from "./routing-judge.prompt.ts";
import type { RoutingAnswer } from "./routing-rules.ts";

export const SCHEMA = {
  type: "object",
  properties: {
    review: { type: "string", enum: ["none", "light", "deep"] },
    second_round: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["review", "second_round", "reason"],
  additionalProperties: false,
};

/** The answer SCHEMA describes, decoded from the call's structured output. */
export const RoutingJudgeAnswer = Schema.Struct({
  review: Schema.Literals(["none", "light", "deep"]),
  second_round: Schema.Boolean,
  reason: Schema.String,
});

export type RoutingJudgeAnswer = typeof RoutingJudgeAnswer.Type;

const decodeRoutingJudgeAnswer = Schema.decodeUnknownResult(RoutingJudgeAnswer);

/** The Routing answer the judge's answer carries, given by `model`. */
export function routingOf(answer: RoutingJudgeAnswer, model: string | null): RoutingAnswer {
  return { land: "auto", review: answer.review, secondRound: answer.second_round, reason: answer.reason, model };
}

/** The safe side, when the judge could not answer: a deep review and a second round. */
export function judgeFailed(why: string, model: string): RoutingAnswer {
  return {
    land: "auto",
    review: "deep",
    secondRound: true,
    reason: `the Routing judge failed: ${why.slice(0, 200)}`,
    model,
  };
}

/** The Routing judge's answer, with the tokens its call counted. */
export interface RoutingVerdict {
  readonly routing: RoutingAnswer;
  readonly tokens: TokenCounts | null;
}

export async function routingJudge(
  ask: Ask,
  reader: Reader,
  stat: string,
  diff: string,
  patchDelta: boolean,
): Promise<RoutingVerdict> {
  const answer = await ask({
    model: ROUTING_JUDGE.model,
    tools: ROUTING_JUDGE.tools,
    prompt: routingPromptOf(stat, diff, patchDelta),
    schema: SCHEMA,
    ...reader,
    timeoutMs: ROUTING_JUDGE.timeoutMs,
  });

  const { tokens } = answer;

  const safeSide = (why: string): RoutingVerdict => ({
    routing: judgeFailed(why, answer.model ?? ROUTING_JUDGE.model),
    tokens,
  });

  if (answer.kind === "failed") {
    return safeSide(answer.error);
  }

  const decoded = decodeRoutingJudgeAnswer(answer.structured);

  return Result.isFailure(decoded)
    ? safeSide(`its answer does not read: ${decoded.failure.message}`)
    : { routing: routingOf(decoded.success, answer.model), tokens };
}
