/**
 * What the Stop hook asks a fork of the Author's session, and what it reads back: the session's transcript,
 * which says whether it is itself a fork and which model it runs on, the command that asks a fork, and the
 * answer a fork prints.
 */

import { Predicate, Result, Schema } from "effect";

import { isApiWorker } from "../../lib/author-session.ts";
import { requiredOf } from "../../lib/env.ts";
import type { Env } from "../../lib/env.ts";
import { decodeJson } from "../../lib/json.ts";
import { ModelUsage, tokensOf } from "../../lib/tokens.ts";
import type { TokenCounts } from "../../lib/tokens.ts";
import { apiKeyHelperOf, apiWorkerSandboxOf, ONE_RESULT } from "../shared/api-worker.ts";
import type { ApiWorkerPlace } from "../shared/api-worker.ts";
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

/** What the fork of an API Worker's session has that another fork has not: its key helper and its sandbox. */
export type ApiFork = ReturnType<typeof apiForkIn>;

function apiForkIn(place: ApiWorkerPlace) {
  return { ...ONE_RESULT, apiKeyHelper: apiKeyHelperOf(place.home), sandbox: apiWorkerSandboxOf(place) };
}

/**
 * What the forks of the session whose environment is `env` add to their settings. An API Worker's forks
 * bill the key their session bills, so a stop publishes while the subscription has no usage left, and a
 * fork reads the prompt cache its session wrote; their commands run in the session's sandbox, since a
 * fork carries on from what the Worker's session read; `checkout` is the main checkout, which that
 * sandbox hides. Null for any other session: its forks take its login.
 */
export function apiForkOf(env: Env, checkout: string): ApiFork | null {
  return isApiWorker(env) ? apiForkIn({ home: requiredOf(env, "HOME"), checkout }) : null;
}

/** The fork guard's door, by its path from the checkout that holds the hook's own files. */
const FORK_GUARD = "factory/bin/fork-guard.ts";

/**
 * The settings of a fork, as the JSON its command passes: every tool call under the fork guard of
 * `checkout`, the checkout that holds the hook's own files, and what an API Worker's fork adds. The
 * guard starts in that checkout: a fork runs in the Author's worktree, and `bun` reads the `bunfig.toml`
 * of the directory it starts in. The helper names the key's file, never the key.
 */
export function forkSettingsOf(checkout: string, api: ApiFork | null): string {
  const command = `cd "${checkout}" && bun "${checkout}/${FORK_GUARD}"`;
  const hooks = { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] }] };

  return JSON.stringify({ ...api, hooks });
}

/**
 * The command that asks a fork of `session`: a resumed fork of it, with the Done judge's tools, each call
 * under the guard `settings` wire, and its answer printed as JSON. An `isolated` fork, an API Worker's,
 * loads no settings but those, as its session's turns do (`shared/api-worker.ts`): the worktree's own
 * would run the hooks of the branch the Worker edits. The flag is written here, where `local/judges`
 * reads the whole command.
 */
export function forkArgvOf(session: string, ask: ForkAsk, settings: string, isolated: boolean): string[] {
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
    ...(isolated ? ["--setting-sources", ""] : []),
    "--strict-mcp-config",
    ...(ask.schema === null ? [] : ["--json-schema", JSON.stringify(ask.schema)]),
    "--output-format",
    "json",
    ...(ask.model === null ? [] : ["--model", ask.model]),
    ask.prompt,
  ];
}
