#!/usr/bin/env bun

/**
 * The Stop hook. It does nothing for a session that is not an Author, whose environment holds no
 * `LAB_AUTHOR=1`, nor for a fork it launched. For an Author it reads git and the branch's PR, decides
 * with `decide.ts`, and acts: runs the Stop checks, runs the Done judge, which asks a fork of the
 * session whether the change is finished and which findings the Author rejects or fixed, then publishes:
 * posts the rejections, records the fixed findings on the PR, pushes the branch, opens or readies the PR,
 * resolves the App's open Nit threads, and leaves the PR's relay. A stop that leaves a question to the Owner pushes the branch to a PR in draft,
 * posts the question there once, and leaves the relay that brings the answer back. Every step is appended to `.lab/stop.log` as one JSON line, with the fork's
 * latency and tokens, and every stop of an Author leaves one line in `.lab/outcomes.log` of the main
 * checkout.
 *
 * Reads the Stop input on stdin; `LAB_STOP_FORK=1` marks a fork this hook launched.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Predicate, Result, Schema } from "effect";

import { isAuthor } from "../../lib/author-session.ts";
import { decodeJson } from "../../lib/json.ts";
import { ModelUsage, tokensOf } from "../../lib/tokens.ts";
import type { TokenCounts } from "../../lib/tokens.ts";
import { authorTokenOf, ghEnv, pushArgs } from "../lib/author.ts";
import type { AuthorToken } from "../lib/author.ts";
import { startRelay } from "../lib/relay-start.ts";
import { checked, run as runCli } from "../lib/run.ts";
import { replyInThread, resolveThread } from "../lib/threads.ts";
import { APP_LOGIN } from "../logins.ts";
import type { StartRelay } from "../ports/relay.ts";
import type { Run, RunOptions } from "../ports/run.ts";
import { conversationArgsOf, conversationOf } from "../relay/wakes.ts";
import { openFindingsOf, ReviewThreads, threadsQueryOf } from "../review/findings.ts";
import type { OpenFinding } from "../review/findings.ts";
import {
  admit,
  afterClosed,
  afterStopChecks,
  bystanderOf,
  chainOf,
  checkoutOf,
  closingLineOf,
  decide,
  DONE_SCHEMA,
  doneAnswerOf,
  fixedOf,
  fixedRecordBodyOf,
  fixedRecordIn,
  FORK_MARKER,
  noAuthorToken,
  noDoneAnswer,
  outcomeLineOf,
  questionCommentOf,
  questionOpen,
  quotedQuestionOf,
  rejectionReplyOf,
  rejectionsOf,
} from "./decide.ts";
import type {
  Action,
  ClosedPullRequest,
  DoneAnswer,
  FixedRecord,
  Outcome,
  PullRequest,
  Refusal,
  Rejection,
  Snapshot,
  StopChecks,
  StopFacts,
} from "./decide.ts";
import { BODY_REQUEST, doneQuestionOf } from "./done-prompt.ts";

export const FORK_FLAG = "LAB_STOP_FORK";

const TRUNK = "dev";

const FORK_TIMEOUT_MS = 180_000;

const STOP_CHECKS_TIMEOUT_MS = 300_000;

/** The repository of the hook's own files, where the fork guard lives; the Author's cwd may be another checkout. */
const REPO = resolve(import.meta.dir, "..", "..", "..");

// No Monitor: a fork that armed a watch waited on it until it was killed (#38, #39).
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
  readonly startRelay: StartRelay;
  /** Appends `line` to `.lab/outcomes.log` of the main checkout `checkout`. */
  readonly recordOutcome: (checkout: string, line: string) => void;
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
interface ForkAsk {
  readonly model: string | null;
  readonly prompt: string;
  readonly schema: Schema.JsonObject | null;
}

async function askFork(deps: Deps, input: StopInput, ask: ForkAsk): Promise<ForkResult> {
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
    ...(ask.schema === null ? [] : ["--json-schema", JSON.stringify(ask.schema)]),
    "--output-format",
    "json",
    ...(ask.model === null ? [] : ["--model", ask.model]),
    ask.prompt,
  ];

  const ran = await deps.run(argv, {
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
    isCrossRepository: Schema.Boolean,
  }),
);

/** The options of a `gh` call: with the Author's credential once its token is found. */
function ghOptions(cwd: string, author: AuthorToken): RunOptions {
  return author.kind === "found" ? { cwd, env: ghEnv(author.token) } : { cwd };
}

/** The branch's open PR; `--head` also matches a fork's branch of the same name, which is not the Author's. */
async function prOf(deps: Deps, gh: RunOptions, branch: string): Promise<PullRequest | null> {
  const listed = decodeJson(
    ListedPrs,
    "gh pr list",
    await checked(
      deps.run,
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,isDraft,headRefOid,isCrossRepository",
      ],
      gh,
    ),
  );

  const pr = listed.find((one) => !one.isCrossRepository);

  return pr === undefined ? null : { number: pr.number, draft: pr.isDraft, headSha: pr.headRefOid };
}

const ListedClosedPrs = Schema.Array(
  Schema.Struct({
    number: Schema.Finite,
    headRefOid: Schema.String,
    state: Schema.String,
    isCrossRepository: Schema.Boolean,
  }),
);

/**
 * The branch's PRs closed without landing: `--state closed` lists the landed ones too, and `--head`
 * matches a fork's branch of the same name, which anyone can open and close.
 */
async function closedPrsOf(deps: Deps, gh: RunOptions, branch: string): Promise<readonly ClosedPullRequest[]> {
  const listed = decodeJson(
    ListedClosedPrs,
    "gh pr list --state closed",
    await checked(
      deps.run,
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "closed",
        "--json",
        "number,headRefOid,state,isCrossRepository",
      ],
      gh,
    ),
  );

  return listed
    .filter((pr) => pr.state === "CLOSED" && !pr.isCrossRepository)
    .map((pr) => ({ number: pr.number, headSha: pr.headRefOid }));
}

/** The App's open Important and Nit findings on PR `pr`, read as the Author. */
async function openFindings(deps: Deps, gh: RunOptions, pr: number): Promise<readonly OpenFinding[]> {
  const answer = await checked(
    deps.run,
    ["gh", "api", "graphql", "-f", `query=${threadsQueryOf(pr)}`, "-F", "owner={owner}", "-F", "name={repo}"],
    gh,
  );

  const threads = decodeJson(ReviewThreads, "the review threads query", answer).data.repository.pullRequest
    .reviewThreads.nodes;

  return openFindingsOf(APP_LOGIN, threads);
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

/** The body of a PR the hook opens: the fork's body, then the closing line. */
function openBodyOf(branch: string, forkBody: string): string {
  return [forkBody, closingLineOf(branch, forkBody)].filter((part) => part !== null && part !== "").join("\n\n");
}

/** What Claude Code is told: let the session stop, or block the stop with a reason the Author reads. */
export type Answer = { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string };

const ALLOW: Answer = { kind: "allow" };

/** One `.lab/stop.log` record: the step it logs, and that step's fields. */
export interface StopLogRecord {
  readonly step: string;
  readonly [field: string]: Schema.Json;
}

type Log = (record: StopLogRecord) => void;

/** What one stop of an Author gave: the hook's answer, and the outcome it leaves. */
interface Stopped {
  readonly answer: Answer;
  readonly outcome: Outcome;
}

const notPublished = (reason: string, answer: Answer = ALLOW): Stopped => ({
  answer,
  outcome: { kind: "not-published", reason },
});

/** The stop of a decision that publishes nothing: blocked with its reason, or let go. */
const stoppedOf = (next: Refusal, why: string): Stopped =>
  next.kind === "block" ? notPublished(why, next) : notPublished(next.reason);

/** The Author's stop, as its steps read it. */
interface AuthorStop {
  readonly deps: Deps;
  readonly input: StopInput;
  readonly log: Log;
  readonly branch: string;
  readonly head: string;
  /** The main checkout, where the relay runs. */
  readonly checkout: string;
  readonly model: string | null;
}

/** The Author's credential, found. */
interface Credential {
  readonly token: string;
  readonly gh: RunOptions;
}

/**
 * Resolves the App's open Nit threads of `findings`: the Author's stop closes them. A failure leaves the
 * rest open and is logged: the next stop of an Author on the PR closes them.
 */
async function closeNits(stopping: AuthorStop, gh: RunOptions, findings: readonly OpenFinding[]): Promise<void> {
  const nits = findings.filter((finding) => finding.severity === "nit");

  try {
    for (const nit of nits) {
      await resolveThread(stopping.deps.run, gh, nit.thread);
    }

    stopping.log({ step: "nits", resolved: nits.length });
  } catch (error) {
    stopping.log({
      step: "nits",
      resolved: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Leaves the PR's relay, when none watches it. A failure is logged: the PR is published either way. */
function leaveRelay(stopping: AuthorStop, pr: number): void {
  try {
    const { input, checkout } = stopping;
    const started = stopping.deps.startRelay({ pr, session: input.session_id, checkout });
    stopping.log({ step: "relay", pr, relay: started });
  } catch (error) {
    stopping.log({
      step: "relay",
      pr,
      relay: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Opens the PR of the pushed branch, in draft when `draft`, with the title and body a fork writes; returns its number. */
async function openPr(stopping: AuthorStop, gh: RunOptions, draft: boolean): Promise<number> {
  const { deps, input, branch } = stopping;

  const bodyFork = await askFork(deps, input, {
    model: stopping.model,
    prompt: BODY_REQUEST,
    schema: null,
  });

  const subject = await gitOut(deps, input.cwd, ["log", "-1", "--format=%s"]);
  const text = prTextOf(bodyFork.text) ?? { title: subject, body: "" };
  stopping.log({
    step: "body-fork",
    ms: bodyFork.ms,
    tokens: bodyFork.tokens,
    unreadable: bodyFork.unreadable,
    title: text.title,
  });

  const body = openBodyOf(branch, text.body);

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
      ...(draft ? ["--draft"] : []),
      "--title",
      text.title,
      "--body-file",
      "-",
    ],
    { ...gh, stdin: body === "" ? "(no body)" : body },
  );

  return Number(/\/pull\/(\d+)/u.exec(url)?.[1]);
}

/** What the Done judge's fork was asked about, and what it answered. */
interface Judged {
  readonly pr: PullRequest | null;
  readonly findings: readonly OpenFinding[];
  readonly answer: DoneAnswer;
  /** The PR's conversation holds a question the hook put to the Owner, still unanswered. */
  readonly asked: boolean;
  /** What the PR records of the findings the Author says it fixed. */
  readonly fixed: FixedRecord;
}

async function push(stopping: AuthorStop, author: Credential): Promise<void> {
  await checked(stopping.deps.run, pushArgs(stopping.branch), {
    cwd: stopping.input.cwd,
    env: { LAB_AUTHOR_TOKEN: author.token },
    timeoutMs: 120_000,
  });
}

/**
 * Puts the Author's question to the Owner on a draft PR, so nothing lands while it is open: a ready PR
 * goes back to draft before the push, a branch with none opens one in draft. The question is posted
 * unless one the Owner has not answered is there already, and the relay is left to bring the answer.
 */
async function askOwner(
  stopping: AuthorStop,
  author: Credential,
  action: Extract<Action, { kind: "ask" }>,
): Promise<Stopped> {
  const { deps, input, log, branch } = stopping;

  if (action.pr !== null && action.toDraft) {
    await checked(deps.run, ["gh", "pr", "ready", String(action.pr), "--undo"], author.gh);
  }

  await push(stopping, author);

  const pr = action.pr ?? (await openPr(stopping, author.gh, true));
  const posted = action.post;

  if (posted) {
    await checked(deps.run, ["gh", "pr", "comment", String(pr), "--body-file", "-"], {
      ...author.gh,
      stdin: questionCommentOf(action.question, branch, input.session_id),
    });
  }

  log({ step: "question", pr, posted });
  leaveRelay(stopping, pr);

  return { answer: ALLOW, outcome: { kind: "asked", pr, reason: action.reason } };
}

/**
 * Records on PR `pr` the findings the Author says it fixed, in the hook's one comment there, posted or
 * edited. It goes before the push, so the Merge bot run the push starts reads it for its ledger. A
 * failure is logged: the ledger only shows it, so the PR is published either way.
 */
async function recordFixed(
  stopping: AuthorStop,
  author: Credential,
  pr: number,
  { judged, posted }: { readonly judged: Judged; readonly posted: readonly Rejection[] },
): Promise<void> {
  const recorded = fixedOf(
    judged.answer.fixed,
    judged.findings.map((finding) => finding.thread),
    posted,
  );

  const body = fixedRecordBodyOf(judged.fixed, recorded);

  if (body === null) {
    return;
  }

  const { comment } = judged.fixed;

  try {
    await (comment === null
      ? checked(stopping.deps.run, ["gh", "pr", "comment", String(pr), "--body-file", "-"], {
          ...author.gh,
          stdin: body,
        })
      : checked(
          stopping.deps.run,
          ["gh", "api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${comment}`, "--input", "-"],
          { ...author.gh, stdin: JSON.stringify({ body }) },
        ));

    stopping.log({ step: "fixed", threads: [...recorded] });
  } catch (error) {
    stopping.log({ step: "fixed", threads: null, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The Publication: the rejections first, each a reply and a resolved thread, and the findings the Author
 * fixed, then the push, the PR opened or readied, the Nit threads resolved and the relay left. A push that
 * fails writes nothing after it.
 */
async function publish(stopping: AuthorStop, author: Credential, judged: Judged): Promise<Stopped> {
  const { deps, log, head } = stopping;
  const action = decide(judged.pr, judged.answer, judged.asked);

  if (action.kind === "none") {
    return notPublished(action.reason);
  }

  const logDropped = (dropped: readonly Rejection[]): void => {
    for (const rejection of dropped) {
      log({ step: "rejection-dropped", thread: rejection.thread, reason: rejection.reason.slice(0, 300) });
    }
  };

  if (action.kind === "ask" || action.kind === "hold") {
    logDropped(judged.answer.rejections);
  }

  if (action.kind === "ask") {
    return askOwner(stopping, author, action);
  }

  if (action.kind === "hold") {
    leaveRelay(stopping, action.pr);

    return notPublished(action.reason);
  }

  const rejections = rejectionsOf(
    judged.answer.rejections,
    judged.findings.map((finding) => finding.thread),
  );

  logDropped(rejections.dropped);

  for (const rejection of rejections.posted) {
    await replyInThread(deps.run, author.gh, rejection.thread, rejectionReplyOf(rejection.reason));
    await resolveThread(deps.run, author.gh, rejection.thread);
    log({ step: "rejection", thread: rejection.thread });
  }

  if (action.kind === "push") {
    await recordFixed(stopping, author, action.pr, { judged, posted: rejections.posted });
  }

  await push(stopping, author);

  let number: number;

  if (action.kind === "open") {
    number = await openPr(stopping, author.gh, false);
  } else {
    number = action.pr;

    if (action.ready) {
      await checked(deps.run, ["gh", "pr", "ready", String(number)], author.gh);
    }
  }

  log({ step: "published", action: action.kind, pr: number, head });

  const rejected = new Set(rejections.posted.map((rejection) => rejection.thread));

  await closeNits(
    stopping,
    author.gh,
    judged.findings.filter((finding) => !rejected.has(finding.thread)),
  );
  leaveRelay(stopping, number);

  return { answer: ALLOW, outcome: { kind: "published", pr: number } };
}

/** The Done judge: a fork of the session answers whether the change is finished and which findings the Author rejects or fixed. */
function askDoneJudge(stopping: AuthorStop, findings: readonly OpenFinding[]): Promise<ForkResult> {
  const question = doneQuestionOf(
    findings.map((finding) => ({
      thread: finding.thread,
      where: finding.line === null ? finding.path : `${finding.path}:${finding.line}`,
      severity: finding.severity,
      summary: finding.summary,
    })),
  );

  return askFork(stopping.deps, stopping.input, {
    model: stopping.model,
    prompt: question,
    schema: DONE_SCHEMA,
  });
}

/** The stop of an Author whose branch may be published: admission, the Stop checks, the Done judge, the Publication. */
async function authorStop(stopping: AuthorStop, stateDir: string): Promise<Stopped> {
  const { deps, input, log, branch, head } = stopping;
  const { cwd } = input;
  // Left by the stop that asked for the commit, and read once by the next one.
  const commitAsked = join(stateDir, `commit-asked-${input.session_id}`);
  const chain = chainOf(input.stop_hook_active === true, existsSync(commitAsked));
  rmSync(commitAsked, { force: true });

  await deps.run(["git", "fetch", "--quiet", "origin", TRUNK], { cwd, timeoutMs: 60_000 });

  // Read before the PR list, which the Author's credential reads too; only publishing needs the token.
  const token = authorTokenOf(deps.env);
  const gh = ghOptions(cwd, token);

  const snapshot: Snapshot = {
    branch,
    head,
    treeClean: (await gitOut(deps, cwd, ["status", "--porcelain"])) === "",
    ahead: Number(await gitOut(deps, cwd, ["rev-list", "--count", `origin/${TRUNK}..HEAD`])),
    pr: await prOf(deps, gh, branch),
  };

  const first = admit(snapshot, chain.blocked);

  const admission = first.kind === "read-closed" ? afterClosed(head, await closedPrsOf(deps, gh, branch)) : first;

  log({ step: "admit", branch, head, pr: snapshot.pr?.number ?? null, ...admission });

  if (admission.kind === "none") {
    return notPublished(admission.reason);
  }

  if (admission.kind === "block") {
    writeFileSync(commitAsked, "asked\n");

    return notPublished(admission.outcome, { kind: "block", reason: admission.reason });
  }

  if (admission.kind === "ready") {
    if (token.kind === "found") {
      await closeNits(stopping, gh, await openFindings(deps, gh, admission.pr));
    }

    return notPublished(admission.reason);
  }

  log({ step: "author-token", found: token.kind === "found", path: token.path });

  if (token.kind === "missing") {
    return stoppedOf(noAuthorToken(token.path, chain.reported), `no Author token at ${token.path}`);
  }

  const next = afterStopChecks(await stopChecks(deps, cwd, stateDir, head), chain.reported);
  log({ step: "stop-checks", next: next.kind });

  if (next.kind !== "ask-done-judge") {
    return stoppedOf(next, `the Stop checks are red on ${head}`);
  }

  const findings = snapshot.pr === null ? [] : await openFindings(deps, gh, snapshot.pr.number);
  const doneJudge = await askDoneJudge(stopping, findings);
  const answer = doneAnswerOf(doneJudge);
  log({
    step: "done-judge",
    model: stopping.model,
    answer: answer === null ? "none" : answer.finished ? "finished" : "not-finished",
    question: answer === null ? null : quotedQuestionOf(answer.question),
    reason: answer?.reason.slice(0, 300) ?? null,
    rejections: answer?.rejections.length ?? null,
    fixed: answer?.fixed.length ?? null,
    ms: doneJudge.ms,
    tokens: doneJudge.tokens,
    code: doneJudge.code,
    unreadable: doneJudge.unreadable,
  });

  if (answer === null) {
    return stoppedOf(noDoneAnswer(doneJudge.code, chain.reported), "the Done judge gave no answer");
  }

  const conversation =
    snapshot.pr === null ? [] : conversationOf(await checked(deps.run, conversationArgsOf(snapshot.pr.number), gh));

  return publish(
    stopping,
    { token: token.token, gh },
    { pr: snapshot.pr, findings, answer, asked: questionOpen(conversation), fixed: fixedRecordIn(conversation) },
  );
}

/** Where a session stops: its worktree, the repository's main checkout, and whether they are the same. */
interface Place {
  readonly worktree: string;
  readonly checkout: string;
  readonly mainCheckout: boolean;
}

async function placeOf(deps: Deps, cwd: string): Promise<Place> {
  const worktree = await gitOut(deps, cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = await gitOut(deps, cwd, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await gitOut(deps, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  return { worktree, checkout: dirname(commonDir), mainCheckout: gitDir === commonDir };
}

/** The stop of an Author in `place`, on `branch` at `head`: what git alone refuses, then `authorStop`. */
function stopIn(
  place: Place,
  { branch, head }: { readonly branch: string | null; readonly head: string },
  stopping: Pick<AuthorStop, "deps" | "input" | "log" | "model">,
): Promise<Stopped> {
  const checkout = checkoutOf({ mainCheckout: place.mainCheckout, branch });

  if (checkout.kind === "refused") {
    stopping.log({ step: "admit", kind: "none", reason: checkout.reason });

    return Promise.resolve(notPublished(checkout.reason));
  }

  const stateDir = join(place.worktree, ".lab", "state");
  mkdirSync(stateDir, { recursive: true });

  return authorStop({ ...stopping, branch: checkout.branch, head, checkout: place.checkout }, stateDir);
}

/** Appends `line` to `.lab/outcomes.log` of the main checkout `checkout`. */
function appendOutcome(checkout: string, line: string): void {
  mkdirSync(join(checkout, ".lab"), { recursive: true });
  appendFileSync(join(checkout, ".lab", "outcomes.log"), `${line}\n`);
}

/** Reads, decides and acts; returns what Claude Code is told. `log` gets one record per step. */
export async function stop(input: StopInput, deps: Deps, log: Log): Promise<Answer> {
  const { cwd } = input;
  const author = isAuthor(deps.env);
  const forkFlag = deps.env[FORK_FLAG] === "1";
  // Only an Author's own session has its transcript read: any other session's stop costs nothing.
  const transcript = author && !forkFlag ? linesOf(input.transcript_path) : [];
  const bystander = bystanderOf({ author, forkFlag, forkMarker: hasForkMarker(transcript) });

  if (bystander !== null) {
    log({ step: "admit", kind: "none", reason: bystander });

    return ALLOW;
  }

  const place = await placeOf(deps, cwd);

  let facts: StopFacts = {
    at: new Date(deps.now()).toISOString(),
    session: input.session_id,
    worktree: place.worktree,
    branch: null,
    head: null,
  };

  let stopped: Stopped;
  let failure: { readonly error: unknown } | null = null;

  try {
    const branch = (await deps.run(["git", "symbolic-ref", "--short", "-q", "HEAD"], { cwd })).stdout.trim() || null;
    const head = await gitOut(deps, cwd, ["rev-parse", "HEAD"]);
    facts = { ...facts, branch, head };
    stopped = await stopIn(place, { branch, head }, { deps, input, log, model: modelOf(transcript) });
  } catch (error) {
    failure = { error };
    stopped = notPublished(`the Stop hook failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  deps.recordOutcome(place.checkout, outcomeLineOf(facts, stopped.outcome));

  if (failure !== null) {
    throw failure.error;
  }

  return stopped.answer;
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
    const answer = await stop(
      input,
      { run: runCli, env: process.env, now: Date.now, startRelay, recordOutcome: appendOutcome },
      log,
    );

    if (answer.kind === "block") {
      console.log(JSON.stringify({ decision: "block", reason: answer.reason }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ step: "error", message });
    console.error(`stop hook: ${message}`);
  }
}
