#!/usr/bin/env bun

/**
 * The Stop hook of the Author's session. It reads the session, git and the branch's PR, decides with
 * `decide.ts`, and acts: runs the Stop checks, runs the Done judge, which asks a fork of the session
 * whether the task is finished, then publishes: pushes the branch, opens or readies the PR, and tells
 * the Author to arm its PR watch. Every step is appended to `.lab/stop.log` as one JSON line, with the
 * fork's latency and cost.
 *
 * Reads the Stop input on stdin; `LAB_STOP_FORK=1` marks a fork this hook launched.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Predicate, Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { checked, run as runCli } from "../lib/run.ts";
import type { Run } from "../ports/run.ts";
import { admit, afterStopChecks, answerOf, armReason, decide, FORK_MARKER, IGNORED_BRANCH } from "./decide.ts";
import type { Action, PullRequest, Snapshot, StopChecks } from "./decide.ts";

export const FORK_FLAG = "LAB_STOP_FORK";

const TRUNK = "dev";

const FORK_TIMEOUT_MS = 180_000;

const STOP_CHECKS_TIMEOUT_MS = 300_000;

export const DONE_QUESTION = `${FORK_MARKER} Stop hook question, not the Owner's: is your current change finished and committed, with no question pending for the Owner? Watching the pull request is the Land loop's job, not part of this answer. Answer YES or NO, then a reason.`;

export const BODY_REQUEST = `${FORK_MARKER} Stop hook request, not the Owner's: write the pull request for the commits on this branch. First line: its title, as a conventional commit subject. Then a blank line, then its body in Markdown: what changed and why, and how you verified it. Print nothing else.`;

export const StopInput = Schema.Struct({
  session_id: Schema.String,
  transcript_path: Schema.String,
  cwd: Schema.String,
  stop_hook_active: Schema.optionalKey(Schema.Boolean),
});

export type StopInput = typeof StopInput.Type;

export interface Deps {
  readonly run: Run;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
}

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

/** The lines of the transcript at `path`; a missing transcript has none. */
export function linesOf(path: string): TranscriptLine[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
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
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const model = lines[index]?.message?.model;

    if (lines[index]?.type === "assistant" && model !== undefined && model !== "<synthetic>") {
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
export const ForkOutput = Schema.Struct({
  result: Schema.optionalKey(Schema.String),
  total_cost_usd: Schema.optionalKey(Schema.Finite),
  usage: Schema.optionalKey(Schema.Struct({ cache_read_input_tokens: Schema.optionalKey(Schema.Finite) })),
});

const decodeForkOutput = Schema.decodeResult(Schema.fromJsonString(ForkOutput));

/** `unreadable` says why the fork's output did not read: such a fork gave no answer. */
export interface ForkResult {
  readonly text: string;
  readonly ms: number;
  readonly costUsd: number | null;
  readonly cacheRead: number | null;
  readonly code: number;
  readonly unreadable: string | null;
}

/** The answer a fork printed; output that does not read is no answer, and says why. */
export function forkResultOf(stdout: string, code: number, ms: number): ForkResult {
  const out = decodeForkOutput(stdout);

  if (Result.isFailure(out)) {
    return { text: "", ms, costUsd: null, cacheRead: null, code, unreadable: out.failure.message };
  }

  return {
    text: out.success.result ?? "",
    ms,
    costUsd: out.success.total_cost_usd ?? null,
    cacheRead: out.success.usage?.cache_read_input_tokens ?? null,
    code,
    unreadable: null,
  };
}

async function askFork(deps: Deps, input: StopInput, model: string | null, prompt: string): Promise<ForkResult> {
  const started = deps.now();

  // No tool: a fork that re-armed the session's PR watch waited on it until it was killed (#38, #39).
  const argv = [
    "claude",
    "-p",
    "--resume",
    input.session_id,
    "--fork-session",
    "--tools",
    "",
    "--strict-mcp-config",
    "--output-format",
    "json",
  ];

  const ran = await deps.run([...argv, ...(model === null ? [] : ["--model", model]), prompt], {
    cwd: input.cwd,
    env: { [FORK_FLAG]: "1" },
    timeoutMs: FORK_TIMEOUT_MS,
  });

  return forkResultOf(ran.stdout, ran.code, deps.now() - started);
}

async function gitOut(deps: Deps, cwd: string, args: readonly string[]): Promise<string> {
  return (await checked(deps.run, ["git", ...args], { cwd })).trim();
}

export const ListedPrs = Schema.Array(
  Schema.Struct({ number: Schema.Finite, isDraft: Schema.Boolean, headRefOid: Schema.String }),
);

async function prOf(deps: Deps, cwd: string, branch: string): Promise<PullRequest | null> {
  const listed = decodeJson(
    ListedPrs,
    "gh pr list",
    await checked(
      deps.run,
      ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number,isDraft,headRefOid"],
      { cwd },
    ),
  );

  const pr = listed[0];

  return pr === undefined ? null : { number: pr.number, draft: pr.isDraft, headSha: pr.headRefOid };
}

async function stopChecks(deps: Deps, cwd: string, stateDir: string, head: string): Promise<StopChecks> {
  // An on-disk name: existing state files carry it, so it stays.
  const record = join(stateDir, `gates-${head}`);

  if (existsSync(record)) {
    return { kind: "green" };
  }

  const ran = await deps.run(["bun", "check"], { cwd, timeoutMs: STOP_CHECKS_TIMEOUT_MS });

  if (ran.code !== 0) {
    return { kind: "red", report: `${ran.stdout}\n${ran.stderr}`.trim().slice(-3000) };
  }

  writeFileSync(record, "green\n");

  return { kind: "green" };
}

export type Outcome = { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string };

/**
 * A Done judge whose fork exits non-zero or prints nothing gave no answer, which is not a NO: the
 * first such stop blocks so the Author stops again and the hook asks again; a second one lets the
 * session end.
 */
export function doneJudgeFailure(code: number, text: string, stopHookActive: boolean): Outcome | null {
  if (code === 0 && text.trim() !== "") {
    return null;
  }

  if (stopHookActive) {
    return { kind: "allow" };
  }

  return {
    kind: "block",
    reason: `The Stop hook could not ask whether your change is finished (the Done judge's fork exited ${code} with no answer), so nothing was published. Stop again to retry; ask no question.`,
  };
}

/** Reads, decides and acts; returns what Claude Code is told. `log` gets one record per step. */
/** One `.lab/stop.log` record: the step it logs, and that step's fields. */
export interface StopLogRecord {
  readonly step: string;
  readonly [field: string]: Schema.Json;
}

export async function stop(input: StopInput, deps: Deps, log: (record: StopLogRecord) => void): Promise<Outcome> {
  const { cwd } = input;
  const root = await gitOut(deps, cwd, ["rev-parse", "--show-toplevel"]);
  const stateDir = join(root, ".lab", "state");
  mkdirSync(stateDir, { recursive: true });

  const transcript = linesOf(input.transcript_path);
  const branch = (await deps.run(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd })).stdout.trim() || null;
  const head = await gitOut(deps, cwd, ["rev-parse", "HEAD"]);
  const forkFlag = deps.env[FORK_FLAG] === "1";
  const forkMarker = hasForkMarker(transcript);

  const early: Pick<Snapshot, "forkFlag" | "forkMarker" | "branch"> = { forkFlag, forkMarker, branch };

  if (forkFlag || forkMarker || branch === null || IGNORED_BRANCH.test(branch)) {
    const admission = admit({
      ...early,
      stopHookActive: false,
      head,
      treeClean: true,
      ahead: 1,
      pr: null,
      armed: false,
    });

    log({ step: "admit", ...admission });

    return { kind: "allow" };
  }

  await deps.run(["git", "fetch", "--quiet", "origin", TRUNK], { cwd, timeoutMs: 60_000 });

  const snapshot: Snapshot = {
    ...early,
    stopHookActive: input.stop_hook_active === true,
    head,
    treeClean: (await gitOut(deps, cwd, ["status", "--porcelain"])) === "",
    ahead: Number(await gitOut(deps, cwd, ["rev-list", "--count", `origin/${TRUNK}..HEAD`])),
    pr: IGNORED_BRANCH.test(branch) ? null : await prOf(deps, cwd, branch),
    armed: false,
  };

  const armedFile = (pr: number): string => join(stateDir, `armed-${pr}-${head}`);
  const withArmed = { ...snapshot, armed: snapshot.pr !== null && existsSync(armedFile(snapshot.pr.number)) };
  const prWatch = `bun ${join(root, "scripts", "land-loop", "pr-watch.ts")}`;
  const thread = `bun ${join(root, "scripts", "land-loop", "thread.ts")}`;

  const admission = admit(withArmed);
  log({ step: "admit", branch, head, pr: withArmed.pr?.number ?? null, ...admission });

  if (admission.kind === "none") {
    return { kind: "allow" };
  }

  if (admission.kind === "arm") {
    writeFileSync(armedFile(admission.pr), "asked\n");

    return { kind: "block", reason: armReason(admission.pr, `${prWatch} ${admission.pr}`, thread) };
  }

  const next = afterStopChecks(await stopChecks(deps, cwd, stateDir, head), withArmed.stopHookActive);
  log({ step: "stop-checks", next: next.kind });

  if (next.kind === "none") {
    return { kind: "allow" };
  }

  if (next.kind === "block") {
    return { kind: "block", reason: next.reason };
  }

  const model = modelOf(transcript);
  const doneJudge = await askFork(deps, input, model, DONE_QUESTION);
  const answer = answerOf(doneJudge.text);
  log({
    step: "done-judge",
    model,
    answer,
    ms: doneJudge.ms,
    costUsd: doneJudge.costUsd,
    cacheRead: doneJudge.cacheRead,
    code: doneJudge.code,
    unreadable: doneJudge.unreadable,
    text: doneJudge.text.slice(0, 300),
  });

  const failed = doneJudgeFailure(doneJudge.code, doneJudge.text, withArmed.stopHookActive);

  if (failed !== null) {
    return failed;
  }

  const action: Action = decide(withArmed.pr, answer);

  if (action.kind === "none") {
    return { kind: "allow" };
  }

  await checked(deps.run, ["git", "push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`], {
    cwd,
    timeoutMs: 120_000,
  });

  let number: number;

  if (action.kind === "open") {
    const bodyFork = await askFork(deps, input, model, BODY_REQUEST);
    const subject = await gitOut(deps, cwd, ["log", "-1", "--format=%s"]);
    const text = prTextOf(bodyFork.text) ?? { title: subject, body: "" };
    log({
      step: "body-fork",
      ms: bodyFork.ms,
      costUsd: bodyFork.costUsd,
      cacheRead: bodyFork.cacheRead,
      unreadable: bodyFork.unreadable,
      title: text.title,
    });

    const url = await checked(
      deps.run,
      ["gh", "pr", "create", "--base", TRUNK, "--head", branch, "--title", text.title, "--body-file", "-"],
      { cwd, stdin: text.body === "" ? "(no body)" : text.body },
    );

    number = Number(/\/pull\/(\d+)/u.exec(url)?.[1]);
  } else {
    number = action.pr;

    if (action.ready) {
      await checked(deps.run, ["gh", "pr", "ready", String(number)], { cwd });
    }
  }

  log({ step: "published", action: action.kind, pr: number, head });
  writeFileSync(armedFile(number), "asked\n");

  return { kind: "block", reason: armReason(number, `${prWatch} ${number}`, thread) };
}

if (import.meta.main) {
  const input = decodeJson(StopInput, "the Stop input", await Bun.stdin.text());
  const logFile = join(input.cwd, ".lab", "stop.log");
  mkdirSync(join(input.cwd, ".lab"), { recursive: true });

  const log = (record: StopLogRecord): void => {
    appendFileSync(
      logFile,
      `${JSON.stringify({ at: new Date().toISOString(), session: input.session_id, ...record })}\n`,
    );
  };

  try {
    const outcome = await stop(input, { run: runCli, env: process.env, now: Date.now }, log);

    if (outcome.kind === "block") {
      console.log(JSON.stringify({ decision: "block", reason: outcome.reason }));
    }
  } catch (error) {
    log({ step: "error", message: error instanceof Error ? error.message : String(error) });
    console.error(`stop hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}
