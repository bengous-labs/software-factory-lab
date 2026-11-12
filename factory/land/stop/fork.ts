/**
 * What the Stop hook asks a fork of the Author's session, and what it reads back: the session's transcript,
 * which says whether it is itself a fork and which model it runs on, the command that asks a fork, and the
 * answer a fork prints.
 */

import { Predicate, Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { ModelUsage, tokensOf } from "../../lib/tokens.ts";
import type { TokenCounts } from "../../lib/tokens.ts";
import { FORK_MARKER } from "./decide.ts";
import { DONE_JUDGE } from "./done-judge.actor.ts";

/** One line of a session transcript, as far as this hook reads it: a message's model and its text blocks. */
export const TranscriptLine = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(
    Schema.Struct({
      model: Schema.optionalKey(Schema.String),
      content: Schema.optionalKey(
        Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))]),
      ),
    }),
  ),
});

export type TranscriptLine = typeof TranscriptLine.Type;

type Content = NonNullable<NonNullable<TranscriptLine["message"]>["content"]>;

/** The lines the transcript `text`, read from `path`, holds. */
export function transcriptLinesOf(text: string, path: string): TranscriptLine[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      line.trim() === "" ? [] : [decodeJson(TranscriptLine, `${path} line ${index + 1}`, line)],
    );
}

function textOf(content: Content | undefined): string {
  if (content === undefined) {
    return "";
  }

  return Predicate.isString(content) ? content : content.map((block) => block.text ?? "").join("");
}

/** Whether a user turn of the transcript opens with the fork marker. */
export function hasForkMarker(lines: readonly TranscriptLine[]): boolean {
  return lines.some(
    (line) => line.type === "user" && textOf(line.message?.content).trimStart().startsWith(FORK_MARKER),
  );
}

/** The model of the last assistant message: the Stop input does not carry it. */
export function modelOf(lines: readonly TranscriptLine[]): string | null {
  for (const line of lines.toReversed()) {
    const model = line.message?.model;

    if (line.type === "assistant" && model !== undefined && model !== "<synthetic>") {
      return model;
    }
  }

  return null;
}

/** The title and body a fork wrote: its first line, then the rest. */
export function prTextOf(text: string): { title: string; body: string } | null {
  const [first = "", ...rest] = text.trim().split("\n");
  const title = first.replace(/^#+\s*/u, "").trim();

  return title === "" ? null : { title, body: rest.join("\n").trim() };
}

/** What `claude -p --output-format json` prints, as far as this hook reads it. */
const ForkOutput = Schema.Struct({
  result: Schema.optionalKey(Schema.String),
  /** The answer a fork asked with `--json-schema` gives. */
  structured_output: Schema.optionalKey(Schema.Unknown),
  // Read on its own: a usage that does not read loses the tokens, never the fork's answer.
  modelUsage: Schema.optionalKey(Schema.Unknown),
});

const decodeForkOutput = Schema.decodeResult(Schema.fromJsonString(ForkOutput));

const decodeModelUsage = Schema.decodeUnknownResult(ModelUsage);

/** `unreadable` says why the fork's output did not read: such a fork gave no answer. */
export interface ForkResult {
  readonly text: string;
  /** The fork's structured output; undefined when it gave none. */
  readonly structured: unknown;
  readonly ms: number;
  readonly tokens: TokenCounts | null;
  readonly code: number;
  readonly unreadable: string | null;
}

/** The answer a fork printed; output that does not read is no answer, and says why. */
export function forkResultOf(stdout: string, code: number, ms: number): ForkResult {
  const out = decodeForkOutput(stdout);

  if (Result.isFailure(out)) {
    return {
      text: "",
      structured: undefined,
      ms,
      tokens: null,
      code,
      unreadable: out.failure.message,
    };
  }

  return {
    text: out.success.result ?? "",
    structured: out.success.structured_output,
    ms,
    tokens: Result.match(decodeModelUsage(out.success.modelUsage), {
      onFailure: () => null,
      onSuccess: tokensOf,
    }),
    code,
    unreadable: null,
  };
}

/** What the hook asks a fork: the prompt, on the session's model, and the JSON Schema its answer follows, if any. */
export interface ForkAsk {
  readonly model: string | null;
  readonly prompt: string;
  readonly schema: Schema.JsonObject | null;
}

/**
 * The command that asks a fork of `session`: a resumed fork of it, with the Done judge's tools, each call
 * under the guard `settings` wire, and its answer printed as JSON.
 */
export function forkArgvOf(session: string, ask: ForkAsk, settings: string): string[] {
  return [
    "claude",
    "-p",
    "--resume",
    session,
    "--fork-session",
    "--tools",
    DONE_JUDGE.tools.join(","),
    "--permission-mode",
    DONE_JUDGE.permissionMode,
    "--settings",
    settings,
    "--strict-mcp-config",
    ...(ask.schema === null ? [] : ["--json-schema", JSON.stringify(ask.schema)]),
    "--output-format",
    "json",
    ...(ask.model === null ? [] : ["--model", ask.model]),
    ask.prompt,
  ];
}
