/**
 * The decisions of the Worker bench (`bench.ts`): its arguments, the settings and prompt a Worker is
 * launched with, what a session's transcript says it loaded, and the report.
 */

import { parseArgs } from "node:util";

import { Result, Schema } from "effect";

import { ROLE_VARIABLE } from "../lib/author-session.ts";
import { decodeJson } from "../lib/json.ts";
import { objectAt, parseJson } from "../lib/plain-json.ts";
import type { Json } from "../lib/plain-json.ts";

export const HELP = `usage: bun scripts/lab/bench.ts --issue <file> --runs <n> [--model <model>] [--wake <file>]

Launches <n> headless Worker sessions, each in a throwaway clone of the current commit, on a fake issue,
then prints per session its closing message, the rules under .claude/rules/ it loaded, and whether its
transcript holds an output style reminder other than the Worker's.

The sessions run with the Worker's settings, but LAB_ROLE=worker in place of LAB_AUTHOR=1: they read
the Worker's role and the guard refuses their git push, but they are no Author, so the Stop hook
publishes nothing. Their environment keeps only what claude needs, with no token, and gh reads an
empty config. They edit files and run git and bun with no prompt, outside any sandbox: a session that
means to can still reach what the Owner's files hold. Run a bench only on a change you have read.

  --issue <file>   the fake issue, in Markdown
  --runs <n>       how many sessions
  --model <model>  the model of the sessions (claude's own default without it)
  --wake <file>    resumes each session once with this file's text, as the relay's Wake would

A fake issue file is the body of a GitHub issue as the Worker would read it with gh issue view, written
for the change the bench probes: a "## Problem" that says what is wrong, "## Hints" if any, and a
"## Done when" whose boxes the Worker must reach, such as "- [ ] bun check passes". It names no issue
number: there is none to read on GitHub. Aim it at app/ unless the bench probes a rule another
directory loads. scripts/lab/fake-issues/ holds the fake issues of earlier benches.`;

export interface BenchArgs {
  readonly issue: string;
  readonly runs: number;
  readonly model: string | undefined;
  readonly wake: string | undefined;
}

export type Parsed =
  | { readonly kind: "run"; readonly args: BenchArgs }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function argsOf(argv: readonly string[]): Parsed {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        issue: { type: "string" },
        runs: { type: "string" },
        model: { type: "string" },
        wake: { type: "string" },
        help: { type: "boolean" },
      },
    });

    if (values.help === true) {
      return { kind: "help" };
    }

    if (values.issue === undefined || values.runs === undefined || !/^[1-9]\d*$/u.test(values.runs)) {
      return { kind: "error", message: "--issue <file> and --runs <n>, a positive integer, are required" };
    }

    return {
      kind: "run",
      args: { issue: values.issue, runs: Number(values.runs), model: values.model, wake: values.wake },
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

const WORKER_STYLE = "Proactive";

/**
 * The settings of a Worker (`.claude/rules/identities.md`), but its `env` holds `LAB_ROLE=worker` in place
 * of `LAB_AUTHOR=1` and `GH_TOKEN`: the Worker's role and guards, no Author, no token.
 */
export function workerSettings(ownerClaudeMd: string) {
  return {
    env: { [ROLE_VARIABLE]: "worker" },
    outputStyle: WORKER_STYLE,
    claudeMdExcludes: [ownerClaudeMd],
  };
}

/** The variables of the launcher's environment a bench session keeps: what claude and the tools need, no secret. */
const KEPT = ["HOME", "PATH", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "XDG_RUNTIME_DIR", "CLAUDE_CONFIG_DIR"];

/** A bench session's whole environment, from the launcher's: `KEPT`, and gh pointed at the empty `ghConfigDir`. */
export function benchEnvOf(env: Readonly<Record<string, string | undefined>>, ghConfigDir: string) {
  const kept = KEPT.flatMap((name) => {
    const value = env[name];

    return value === undefined ? [] : [[name, value] as const];
  });

  return Object.fromEntries([...kept, ["GH_CONFIG_DIR", ghConfigDir] as const]);
}

export function workerPrompt(issue: string): string {
  return [
    "Implement the issue below.",
    "The issue's 'Done when' section says which boxes are yours: reach them, and nothing beyond the issue.",
    "Work test-first. When your boxes are held and bun check passes, commit and end your turn.",
    "",
    issue,
  ].join("\n");
}

export interface Launch {
  readonly settings: string;
  readonly prompt: string;
  readonly model: string | undefined;
  readonly resume: string | undefined;
}

export function claudeArgv({ settings, prompt, model, resume }: Launch): string[] {
  return [
    "claude",
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(git *)",
    "Bash(bun *)",
    "--settings",
    settings,
    ...(model === undefined ? [] : ["--model", model]),
    ...(resume === undefined ? [] : ["--resume", resume]),
    prompt,
  ];
}

export interface Closing {
  readonly session: string;
  readonly message: string;
}

const ClaudeResult = Schema.Struct({ session_id: Schema.String, result: Schema.String, is_error: Schema.Boolean });

/** The session and closing message of `claude -p --output-format json`'s output; an error result throws. */
export function closingOf(stdout: string): Closing {
  const result = decodeJson(ClaudeResult, "claude's result", stdout);

  if (result.is_error) {
    throw new Error(`session ${result.session_id} ended in error: ${result.result}`);
  }

  return { session: result.session_id, message: result.result };
}

/** What one attachment loaded: instruction files by path, and output styles by name. */
interface Loaded {
  readonly paths: readonly string[];
  readonly styles: readonly string[];
}

const NOTHING: Loaded = { paths: [], styles: [] };

const TranscriptLine = Schema.Struct({ attachment: Schema.optionalKey(Schema.Struct({ type: Schema.String })) });

const Instructions = Schema.Struct({ files: Schema.Array(Schema.Struct({ path: Schema.String })) });

const NestedMemory = Schema.Struct({ path: Schema.String });

const OutputStyle = Schema.Struct({ style: Schema.String });

const OutputStyleInstructions = Schema.Struct({ style: Schema.Struct({ name: Schema.String }) });

function decoded<S extends Schema.ConstraintDecoder<unknown>>(schema: S, source: string, value: Json): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(value);

  if (Result.isFailure(result)) {
    throw new Error(`${source}: ${result.failure.message}`, { cause: result.failure });
  }

  return result.success;
}

/** What the attachment of one transcript line loaded; an attachment of a type the bench does not read loaded nothing. */
function loadedBy(text: string, source: string): Loaded {
  const type = decodeJson(TranscriptLine, source, text).attachment?.type ?? "";
  const attachment = (): Json => objectAt(source, parseJson(source, text))["attachment"] ?? null;

  switch (type) {
    case "instructions": {
      return { paths: decoded(Instructions, source, attachment()).files.map((file) => file.path), styles: [] };
    }

    case "nested_memory": {
      return { paths: [decoded(NestedMemory, source, attachment()).path], styles: [] };
    }

    case "output_style": {
      return { paths: [], styles: [decoded(OutputStyle, source, attachment()).style] };
    }

    case "output_style_instructions": {
      return { paths: [], styles: [decoded(OutputStyleInstructions, source, attachment()).style.name] };
    }

    default: {
      return NOTHING;
    }
  }
}

export interface Reading {
  readonly rules: readonly string[];
  readonly foreignStyles: readonly string[];
}

const RULES = ".claude/rules/";

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].toSorted();

/**
 * What one session's transcript says it loaded. Read from the session's own file alone: a fork's
 * transcript starts with the session's first message, and reading it would count that message again.
 */
export function readingOf(transcript: string): Reading {
  const loaded = transcript
    .split("\n")
    .map((text, index) => ({ text, source: `transcript line ${index + 1}` }))
    .filter(({ text }) => text.trim() !== "")
    .map(({ text, source }) => loadedBy(text, source));

  const rules = loaded
    .flatMap((each) => each.paths)
    .flatMap((path) => (path.includes(`/${RULES}`) ? [path.slice(path.indexOf(RULES))] : []));

  const styles = loaded.flatMap((each) => each.styles);

  return {
    rules: sortedUnique(rules),
    foreignStyles: sortedUnique(styles.filter((style) => style !== WORKER_STYLE)),
  };
}

export type SessionReport =
  | {
      readonly kind: "done";
      readonly run: number;
      readonly dir: string;
      /** The closing message of the launch, then of the Wake when there is one. */
      readonly closings: readonly Closing[];
      readonly reading: Reading;
    }
  | { readonly kind: "failed"; readonly run: number; readonly error: string };

export interface BenchHeader {
  readonly issue: string;
  readonly runs: number;
  readonly model: string | undefined;
  readonly root: string;
}

function sessionLines(session: SessionReport): string[] {
  if (session.kind === "failed") {
    return [`## Run ${session.run} failed`, session.error, ""];
  }

  const { run, dir, closings, reading } = session;
  const [launch, wake] = closings;
  const styles = reading.foreignStyles;

  return [
    `## Run ${run}, session ${launch?.session}, in ${dir}`,
    `Rules loaded: ${reading.rules.length === 0 ? "none" : reading.rules.join(", ")}`,
    `Output style: ${styles.length === 0 ? "the Worker's alone" : `a reminder of ${styles.join(", ")}`}`,
    "Closing message:",
    launch?.message ?? "",
    ...(wake === undefined ? [] : ["Closing message after the Wake:", wake.message]),
    "",
  ];
}

export function reportOf(header: BenchHeader, sessions: readonly SessionReport[]): string {
  const model = header.model ?? "the default model";

  return [
    `Bench: ${header.runs} runs of ${header.issue} on ${model}, clones under ${header.root}`,
    "",
    ...sessions.flatMap((session) => sessionLines(session)),
  ].join("\n");
}
