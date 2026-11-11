/**
 * The decisions of the Worker bench (`bench.ts`): its arguments, the settings and prompt a Worker is
 * launched with, what a session's transcript says it loaded, and the report.
 */

import { parseArgs } from "node:util";

import { Predicate, Schema } from "effect";

import { decodeJson } from "../lib/json.ts";

export const HELP = `usage: bun scripts/lab/bench.ts --issue <file> --runs <n> [--model <model>] [--wake <file>]

Launches <n> headless Worker sessions, each in a throwaway clone of the current commit, on a fake issue,
then prints per session its closing message, the rules under .claude/rules/ it loaded, and whether its
transcript holds an output style reminder other than the Worker's. The sessions run with the Worker's
settings minus LAB_AUTHOR: the Stop hook stays a bystander, and nothing is published.

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

/** The settings of a Worker (`.claude/rules/identities.md`) but its `env`: no `LAB_AUTHOR`, so no Author, and no token. */
export const WORKER_SETTINGS = { outputStyle: WORKER_STYLE } as const;

export function workerPrompt(issue: string): string {
  return [
    "Implement the issue below. Read AGENTS.md first and follow its 'Your task' section.",
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

const TranscriptLine = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  attachment: Schema.optionalKey(
    Schema.Struct({
      type: Schema.String,
      path: Schema.optionalKey(Schema.String),
      files: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
      style: Schema.optionalKey(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
    }),
  ),
});

type Attachment = NonNullable<(typeof TranscriptLine)["Type"]["attachment"]>;

export interface Reading {
  readonly rules: readonly string[];
  readonly foreignStyles: readonly string[];
}

const RULES = ".claude/rules/";

function loadedPaths(attachment: Attachment): string[] {
  if (attachment.type === "instructions") {
    return (attachment.files ?? []).map((file) => file.path);
  }

  return attachment.type === "nested_memory" && attachment.path !== undefined ? [attachment.path] : [];
}

function styleOf(attachment: Attachment): string | undefined {
  if (attachment.type !== "output_style" && attachment.type !== "output_style_instructions") {
    return undefined;
  }

  return Predicate.isString(attachment.style) ? attachment.style : attachment.style?.name;
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].toSorted();

/**
 * What one session's transcript says it loaded. Read from the session's own file alone: a fork's
 * transcript starts with the session's first message, and reading it would count that message again.
 */
export function readingOf(transcript: string): Reading {
  const attachments = transcript
    .split("\n")
    .filter((text) => text.trim() !== "")
    .flatMap((text, index) => decodeJson(TranscriptLine, `transcript line ${index + 1}`, text).attachment ?? []);

  const rules = attachments
    .flatMap((attachment) => loadedPaths(attachment))
    .flatMap((path) => (path.includes(`/${RULES}`) ? [path.slice(path.indexOf(RULES))] : []));

  const styles = attachments.flatMap((attachment) => styleOf(attachment) ?? []);

  return {
    rules: sortedUnique(rules),
    foreignStyles: sortedUnique(styles.filter((style) => style !== WORKER_STYLE)),
  };
}

export interface SessionReport {
  readonly run: number;
  readonly dir: string;
  /** The closing message of the launch, then of the Wake when there is one. */
  readonly closings: readonly Closing[];
  readonly reading: Reading;
}

export interface BenchHeader {
  readonly issue: string;
  readonly runs: number;
  readonly model: string | undefined;
  readonly root: string;
}

function sessionLines({ run, dir, closings, reading }: SessionReport): string[] {
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
