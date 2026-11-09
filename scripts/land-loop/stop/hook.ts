#!/usr/bin/env bun

/**
 * The Stop hook of the Author's session. It reads the session, git and the branch's PR, decides with
 * `decide.ts`, and acts: runs the Stop checks, runs the Done judge, which asks a fork of the session
 * whether the task is finished, runs a local deep review on a branch that touches a risky path, then
 * publishes: pushes the branch, opens or readies the PR with the local review's block in its body, and
 * tells the Author to arm its PR watch. Every step is appended to `.lab/stop.log` as one JSON line, with the
 * fork's latency and tokens.
 *
 * Reads the Stop input on stdin; `LAB_STOP_FORK=1` marks a fork this hook launched.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Predicate, Result, Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { ModelUsage, tokensOf } from "../../lib/tokens.ts";
import type { TokenCounts } from "../../lib/tokens.ts";
import { FACTORY_CONFIG_PATH, factoryConfigOf } from "../factory-config.ts";
import { authorTokenOf, ghEnv, pushArgs } from "../lib/author.ts";
import type { AuthorToken } from "../lib/author.ts";
import { resolverOf } from "../lib/resolve.ts";
import { reviewSession } from "../lib/review-session.ts";
import { checked, run as runCli } from "../lib/run.ts";
import type { ReviewCall, ReviewSession } from "../ports/review.ts";
import type { Run, RunOptions } from "../ports/run.ts";
import { promptOf } from "../review/review-prompt.ts";
import { OUTPUT_SCHEMA, resultOf } from "../review/review-report.ts";
import type { ReviewRequest } from "../review/review-report.ts";
import { REVIEW_SETTINGS } from "../review/review-settings.ts";
import { guardOf } from "../review/tool-guard.ts";
import {
  admit,
  afterAuthorToken,
  afterLocalReview,
  afterStopChecks,
  answeredImportantsOf,
  answerOf,
  answersOf,
  answersRecordName,
  armReason,
  bodyWithBlock,
  closingLineOf,
  decide,
  FORK_MARKER,
  holdStepsOf,
  IGNORED_BRANCH,
  localReviewBlockOf,
  localReviewNeeded,
  localReviewOf,
  nitLinesOf,
  reviewRecordName,
  riskyPathsOf,
} from "./decide.ts";
import type {
  Action,
  HoldSteps,
  LocalReview,
  LocalReviewAnswers,
  Next,
  PullRequest,
  ReviewedHead,
  Snapshot,
  StopChecks,
} from "./decide.ts";

export const FORK_FLAG = "LAB_STOP_FORK";

const TRUNK = "dev";

const FORK_TIMEOUT_MS = 180_000;

const STOP_CHECKS_TIMEOUT_MS = 300_000;

const LOCAL_REVIEW_TIMEOUT_MS = 600_000;

/** The repository of the hook's own files, where the fork guard lives; the Author's cwd may be another checkout. */
const REPO = resolve(import.meta.dir, "..", "..", "..");

// No Monitor: a fork that re-armed the session's PR watch waited on it until it was killed (#38, #39).
const FORK_TOOLS = "Read,Grep,Glob,Bash";

const FORK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `bun "${join(REPO, "scripts", "land-loop", "stop", "fork-guard.ts")}"`,
            timeout: 30,
          },
        ],
      },
    ],
  },
});

export const DONE_QUESTION = `${FORK_MARKER} Stop hook question, not the Owner's: is your current change finished and committed, with no question pending for the Owner? Watching the pull request is the Land loop's job, not part of this answer. Answer YES or NO, then a reason. When it is finished but a human should read it before it lands, answer YES, HOLD: and the reason instead: for example a change to a name or a format stored outside the code, or to a setting the Owner must change on GitHub.`;

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
  readonly reviewSession: ReviewSession;
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
  // Read on its own: a usage that does not read loses the tokens, never the fork's answer.
  modelUsage: Schema.optionalKey(Schema.Unknown),
});

const decodeForkOutput = Schema.decodeResult(Schema.fromJsonString(ForkOutput));

const decodeModelUsage = Schema.decodeUnknownResult(ModelUsage);

/** `unreadable` says why the fork's output did not read: such a fork gave no answer. */
export interface ForkResult {
  readonly text: string;
  readonly ms: number;
  readonly tokens: TokenCounts | null;
  readonly code: number;
  readonly unreadable: string | null;
}

/** The answer a fork printed; output that does not read is no answer, and says why. */
export function forkResultOf(stdout: string, code: number, ms: number): ForkResult {
  const out = decodeForkOutput(stdout);

  if (Result.isFailure(out)) {
    return { text: "", ms, tokens: null, code, unreadable: out.failure.message };
  }

  return {
    text: out.success.result ?? "",
    ms,
    tokens: Result.match(decodeModelUsage(out.success.modelUsage), { onFailure: () => null, onSuccess: tokensOf }),
    code,
    unreadable: null,
  };
}

async function askFork(deps: Deps, input: StopInput, model: string | null, prompt: string): Promise<ForkResult> {
  const started = deps.now();

  const argv = [
    "claude",
    "-p",
    "--resume",
    input.session_id,
    "--fork-session",
    "--tools",
    FORK_TOOLS,
    "--permission-mode",
    "dontAsk",
    "--settings",
    FORK_SETTINGS,
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
  Schema.Struct({
    number: Schema.Finite,
    isDraft: Schema.Boolean,
    headRefOid: Schema.String,
    labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);

/** The options of a `gh` call: with the Author's credential once its token is found. */
function ghOptions(cwd: string, author: AuthorToken): RunOptions {
  return author.kind === "found" ? { cwd, env: ghEnv(author.token) } : { cwd };
}

async function prOf(deps: Deps, cwd: string, branch: string, author: AuthorToken): Promise<PullRequest | null> {
  const listed = decodeJson(
    ListedPrs,
    "gh pr list",
    await checked(
      deps.run,
      ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number,isDraft,headRefOid,labels"],
      ghOptions(cwd, author),
    ),
  );

  const pr = listed[0];

  return pr === undefined
    ? null
    : { number: pr.number, draft: pr.isDraft, headSha: pr.headRefOid, labels: pr.labels.map((label) => label.name) };
}

/** The Done judge's hold on a PR, and what it puts there; `ready` readies the draft a held PR opened as. */
interface HoldTarget {
  readonly pr: number;
  readonly hold: string | null;
  readonly steps: HoldSteps;
  readonly ready: boolean;
}

/**
 * Puts the hold's label, then posts its comment, with the Author's credential, and logs the hold. The
 * label goes first: a failure after it leaves the PR held, never a hold comment with no hold behind it.
 */
async function putHold(
  deps: Deps,
  options: RunOptions,
  target: HoldTarget,
  log: (record: StopLogRecord) => void,
): Promise<void> {
  const { pr, hold, steps, ready } = target;

  if (hold === null) {
    return;
  }

  if (steps.addLabel) {
    await checked(deps.run, ["gh", "pr", "edit", String(pr), "--add-label", "land:human"], options);
  }

  if (steps.comment !== null) {
    await checked(deps.run, ["gh", "pr", "comment", String(pr), "--body-file", "-"], {
      ...options,
      stdin: steps.comment,
    });
  }

  log({ step: "hold", pr, reason: hold, added: steps.addLabel });

  if (ready) {
    await checked(deps.run, ["gh", "pr", "ready", String(pr)], options);
  }
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

const reviewFileOf = (stateDir: string, head: string): string => join(stateDir, reviewRecordName(head));

const answersFileOf = (stateDir: string, head: string): string => join(stateDir, answersRecordName(head));

function storedAnswers(stateDir: string, head: string): LocalReviewAnswers {
  const file = answersFileOf(stateDir, head);

  return existsSync(file) ? answersOf(file, readFileSync(file, "utf8")) : {};
}

function storedReview(stateDir: string, head: string): LocalReview | null {
  const file = reviewFileOf(stateDir, head);

  return existsSync(file) ? localReviewOf(file, readFileSync(file, "utf8")) : null;
}

function requiredEnv(deps: Deps, name: string): string {
  const value = deps.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset: the local review session needs it`);
  }

  return value;
}

/** The Claude Code credentials a session may take from the environment instead of a login under HOME. */
const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** The whole environment of the review session: PATH and HOME, and the Author's credential when one is set. */
function sessionEnvOf(deps: Deps): ReviewCall["env"] {
  const credentials = CREDENTIALS.flatMap((name) => {
    const value = deps.env[name];

    return value === undefined || value === "" ? [] : [[name, value] as const];
  });

  return {
    PATH: requiredEnv(deps, "PATH"),
    HOME: requiredEnv(deps, "HOME"),
    ...Object.fromEntries(credentials),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
}

/** The branch's heads in commit order, each with its local review when it has one. */
async function branchReviews(deps: Deps, cwd: string, stateDir: string): Promise<ReviewedHead[]> {
  const heads = (await gitOut(deps, cwd, ["rev-list", "--reverse", `origin/${TRUNK}..HEAD`]))
    .split("\n")
    .filter((sha) => sha !== "");

  return heads.flatMap((sha, index): ReviewedHead[] => {
    const review = storedReview(stateDir, sha);

    return review === null
      ? []
      : [{ head: sha, review, answers: storedAnswers(stateDir, sha), nextHead: heads[index + 1] ?? null }];
  });
}

/** What the local review of a head runs on: the checkout, the head, and the risky paths it counts in its log. */
interface ReviewScope {
  readonly cwd: string;
  /** The repository root, as git prints it. */
  readonly root: string;
  readonly stateDir: string;
  readonly head: string;
  readonly riskyPaths: number;
}

/** Runs the local deep review of the head and writes its record, unless the session failed; logs the session. */
async function runLocalReview(
  deps: Deps,
  scope: ReviewScope,
  log: (record: StopLogRecord) => void,
): Promise<LocalReview> {
  const { cwd, stateDir, head } = scope;
  const root = realpathSync(scope.root);
  const base = await gitOut(deps, cwd, ["merge-base", `origin/${TRUNK}`, "HEAD"]);

  const trunkFile = (path: string): Promise<string> =>
    checked(deps.run, ["git", "show", `origin/${TRUNK}:${path}`], { cwd });

  const guides = { review: await trunkFile("REVIEW.md"), project: await trunkFile("AGENTS.md") };
  const { model, effort } = REVIEW_SETTINGS.deep;
  const request: ReviewRequest = { pr: 0, head, base, patch: "local", round: 1, model, effort };
  // The head has no review yet, so every review of the branch is an earlier head's: its answers carry forward.
  const earlier = answeredImportantsOf(await branchReviews(deps, cwd, stateDir));
  const started = deps.now();

  const answer = await deps.reviewSession({
    prompt: promptOf(request, guides, earlier),
    cwd: root,
    model,
    effort,
    outputSchema: OUTPUT_SCHEMA,
    guard: guardOf({ root, resolve: resolverOf(root) }),
    timeoutMs: LOCAL_REVIEW_TIMEOUT_MS,
    env: sessionEnvOf(deps),
  });

  const result = resultOf(request, answer, "local");
  const facts = { head, paths: scope.riskyPaths, ms: deps.now() - started, model: result.model, tokens: result.tokens };

  if (result.kind === "failed") {
    log({ step: "local-review", ...facts, error: result.cause });

    return { failed: result.cause };
  }

  const review: LocalReview = {
    findings: result.report.findings.map(({ file, line, severity, summary, failureScenario }) => ({
      file,
      line,
      severity,
      summary,
      failureScenario,
    })),
    model: result.model,
    tokens: result.tokens,
  };

  writeFileSync(reviewFileOf(stateDir, head), `${JSON.stringify(review, null, 2)}\n`);

  const count = (severity: string): number => review.findings.filter((found) => found.severity === severity).length;
  const answers = storedAnswers(stateDir, head);

  log({
    step: "local-review",
    ...facts,
    important: count("important"),
    nit: count("nit"),
    preExisting: count("pre_existing"),
    unanswered: review.findings
      .filter((found) => found.severity === "important")
      .filter((_, index) => answers[String(index + 1)] === undefined).length,
    nits: nitLinesOf(review),
  });

  return review;
}

/**
 * What the local review stops the publication with, or null when it lets it go on: on a branch with no
 * risky path, or a head whose Importants all have an answer. The head's review runs once.
 */
async function localReviewHold(
  deps: Deps,
  scope: Omit<ReviewScope, "riskyPaths">,
  stopHookActive: boolean,
  log: (record: StopLogRecord) => void,
): Promise<Outcome | null> {
  const { cwd, stateDir, head } = scope;
  const diff = await gitOut(deps, cwd, ["diff", "--name-only", "--no-renames", `origin/${TRUNK}...HEAD`]);
  const paths = diff.split("\n").filter((path) => path !== "");
  const config = await gitOut(deps, cwd, ["show", `origin/${TRUNK}:${FACTORY_CONFIG_PATH}`]);
  const policy = factoryConfigOf(config).land.routing;

  if (!localReviewNeeded(paths, policy)) {
    return null;
  }

  const stored = storedReview(stateDir, head);
  const riskyPaths = riskyPathsOf(paths, policy).length;
  const review = stored ?? (await runLocalReview(deps, { ...scope, riskyPaths }, log));

  return outcomeOf(
    afterLocalReview(review, storedAnswers(stateDir, head), {
      stopHookActive,
      reviewedNow: stored === null,
      rejectCommand: `bun ${join(scope.root, "scripts", "land-loop", "local-review.ts")}`,
    }),
  );
}

/** What Claude Code is told on a `Next` that ends the stop; null on one that lets the hook go on. */
function outcomeOf(next: Next): Outcome | null {
  if (next.kind === "none") {
    return { kind: "allow" };
  }

  return next.kind === "block" ? { kind: "block", reason: next.reason } : null;
}

/** The PR body's local review block, over every reviewed head of the branch; null when none has a review. */
async function localReviewBlock(deps: Deps, cwd: string, stateDir: string): Promise<string | null> {
  return localReviewBlockOf(await branchReviews(deps, cwd, stateDir));
}

export const PrBody = Schema.Struct({ body: Schema.String });

/** The body of a PR the hook opens: the fork's body, the local review's block, then the closing line. */
function openBodyOf(branch: string, forkBody: string, block: string | null): string {
  const closing = closingLineOf(branch, forkBody);
  const closed = [forkBody, closing].filter((part) => part !== null && part !== "").join("\n\n");

  return block === null ? closed : bodyWithBlock(closed, block);
}

/** Writes `block` in the body of PR `pr`, in place of the one there; no block leaves the body as it is. */
async function editBody(deps: Deps, options: RunOptions, pr: number, block: string | null): Promise<void> {
  if (block === null) {
    return;
  }

  const { body } = decodeJson(
    PrBody,
    "gh pr view",
    await checked(deps.run, ["gh", "pr", "view", String(pr), "--json", "body"], options),
  );

  await checked(deps.run, ["gh", "pr", "edit", String(pr), "--body-file", "-"], {
    ...options,
    stdin: bodyWithBlock(body, block),
  });
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

  // Read before the PR list, which the Author's credential reads too; only publishing needs the token.
  const author = authorTokenOf(deps.env);

  const snapshot: Snapshot = {
    ...early,
    stopHookActive: input.stop_hook_active === true,
    head,
    treeClean: (await gitOut(deps, cwd, ["status", "--porcelain"])) === "",
    ahead: Number(await gitOut(deps, cwd, ["rev-list", "--count", `origin/${TRUNK}..HEAD`])),
    pr: IGNORED_BRANCH.test(branch) ? null : await prOf(deps, cwd, branch, author),
    armed: false,
  };

  const armedFile = (pr: number): string => join(stateDir, `armed-${pr}-${head}`);
  const withArmed = { ...snapshot, armed: snapshot.pr !== null && existsSync(armedFile(snapshot.pr.number)) };
  const prWatch = `bun ${join(root, "scripts", "land-loop", "pr-watch.ts")}`;
  const thread = `bun ${join(root, "scripts", "land-loop", "thread.ts")}`;
  const comment = `bun ${join(root, "scripts", "land-loop", "comment.ts")}`;

  const admission = admit(withArmed);
  log({ step: "admit", branch, head, pr: withArmed.pr?.number ?? null, ...admission });

  if (admission.kind === "none") {
    return { kind: "allow" };
  }

  if (admission.kind === "arm") {
    writeFileSync(armedFile(admission.pr), "asked\n");

    return {
      kind: "block",
      reason: armReason(admission.pr, {
        prWatch: `${prWatch} ${admission.pr}`,
        thread,
        comment: `${comment} ${admission.pr}`,
      }),
    };
  }

  const noToken = afterAuthorToken(author.kind === "found", author.path, withArmed.stopHookActive);
  log({ step: "author-token", found: author.kind === "found", path: author.path });

  if (author.kind === "missing") {
    return noToken?.kind === "block" ? { kind: "block", reason: noToken.reason } : { kind: "allow" };
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
    answer: answer.kind,
    ms: doneJudge.ms,
    tokens: doneJudge.tokens,
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

  const held = await localReviewHold(deps, { cwd, root, stateDir, head }, withArmed.stopHookActive, log);

  if (held !== null) {
    return held;
  }

  // A PR the hook opens carries no label yet.
  const hold = holdStepsOf(action.hold, action.kind === "push" ? (withArmed.pr?.labels ?? []) : []);

  const block = await localReviewBlock(deps, cwd, stateDir);

  // The hold and the body's block go on before the push, so neither the Merge bot nor a review its push starts reads the new head without them.
  if (action.kind === "push") {
    await putHold(deps, ghOptions(cwd, author), { pr: action.pr, hold: action.hold, steps: hold, ready: false }, log);
    await editBody(deps, ghOptions(cwd, author), action.pr, block);
  }

  await checked(deps.run, pushArgs(branch), { cwd, env: { LAB_AUTHOR_TOKEN: author.token }, timeoutMs: 120_000 });

  let number: number;

  if (action.kind === "open") {
    const bodyFork = await askFork(deps, input, model, BODY_REQUEST);
    const subject = await gitOut(deps, cwd, ["log", "-1", "--format=%s"]);
    const text = prTextOf(bodyFork.text) ?? { title: subject, body: "" };
    log({
      step: "body-fork",
      ms: bodyFork.ms,
      tokens: bodyFork.tokens,
      unreadable: bodyFork.unreadable,
      title: text.title,
    });

    const body = openBodyOf(branch, text.body, block);

    const url = await checked(
      deps.run,
      [
        "gh",
        "pr",
        "create",
        "--base",
        TRUNK,
        "--head",
        branch,
        "--title",
        text.title,
        "--body-file",
        "-",
        // A held PR opens as a draft and is readied once held: a failure in between leaves a draft, which the next stop asks about again.
        ...(hold.addLabel ? ["--draft"] : []),
      ],
      { ...ghOptions(cwd, author), stdin: body === "" ? "(no body)" : body },
    );

    number = Number(/\/pull\/(\d+)/u.exec(url)?.[1]);
    await putHold(deps, ghOptions(cwd, author), { pr: number, hold: action.hold, steps: hold, ready: true }, log);
  } else {
    number = action.pr;

    if (action.ready) {
      await checked(deps.run, ["gh", "pr", "ready", String(number)], ghOptions(cwd, author));
    }
  }

  log({ step: "published", action: action.kind, pr: number, head });
  writeFileSync(armedFile(number), "asked\n");

  return {
    kind: "block",
    reason: armReason(
      number,
      { prWatch: `${prWatch} ${number}`, thread, comment: `${comment} ${number}` },
      action.hold,
    ),
  };
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
    const outcome = await stop(input, { run: runCli, env: process.env, now: Date.now, reviewSession }, log);

    if (outcome.kind === "block") {
      console.log(JSON.stringify({ decision: "block", reason: outcome.reason }));
    }
  } catch (error) {
    log({ step: "error", message: error instanceof Error ? error.message : String(error) });
    console.error(`stop hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}
