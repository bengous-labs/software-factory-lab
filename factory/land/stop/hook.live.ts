/**
 * The Stop hook. It does nothing for a session that is not an Author, whose environment holds no
 * `LAB_AUTHOR=1`, nor for a fork it launched. For an Author it reads git and the branch's PR, decides with
 * `decide.ts`, and acts: asks the Worker for the Stop checks, runs the Done judge, which asks a fork of the session whether
 * the change is finished and which findings the Author rejects or fixed, then publishes (`publish.live.ts`):
 * posts the rejections, records the fixed findings on the PR, pushes the branch, opens or readies the PR,
 * resolves the App's open Nit threads, and leaves the PR's relay. A stop that leaves a question to the Owner
 * pushes the branch to a PR in draft, posts the question there once, and leaves the relay that brings the
 * answer back. Every step is appended to `.lab/stop.log` as one JSON line, with the fork's latency and
 * tokens, and every stop of an Author leaves one line in `.lab/outcomes.log` of the main checkout.
 *
 * Reads the Stop input on stdin; `LAB_STOP_FORK=1` marks a fork this hook launched.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { OUTCOMES_LOG } from "../../contract.ts";
import { TRUNK } from "../../install/host.ts";
import { isApiWorker, isAuthor } from "../../lib/author-session.ts";
import { requiredOf } from "../../lib/env.ts";
import { decodeJson } from "../../lib/json.ts";
import { checked } from "../../lib/run.port.ts";
import { apiClonesDirOf } from "../shared/api-worker.ts";
import { questionOpen } from "../shared/author-mark.ts";
import { authorTokenOf } from "../shared/author.live.ts";
import { conversationArgsOf, conversationOf } from "../shared/conversation.ts";
import type { OpenFinding } from "../shared/findings.ts";
import { cloneRootOf, pinnedGitEnvOf } from "./clone-git.ts";
import {
  admit,
  afterClosed,
  afterStopChecks,
  bystanderOf,
  chainOf,
  checkoutOf,
  DONE_SCHEMA,
  doneAnswerOf,
  fixedRecordIn,
  noAuthorToken,
  noDoneAnswer,
  outcomeLineOf,
  quotedQuestionOf,
  stopChecksOutcomeOf,
} from "./decide.ts";
import type { Refusal, Snapshot, StopChecks, StopFacts } from "./decide.ts";
import { doneQuestionOf } from "./done-judge.prompt.ts";
import { hasForkMarker, modelOf, transcriptLinesOf } from "./fork.ts";
import type { ForkResult, TranscriptLine } from "./fork.ts";
import {
  ALLOW,
  askFork,
  closedPrsOf,
  closeNits,
  FORK_FLAG,
  ghOptions,
  gitOut,
  notPublished,
  openFindings,
  prOf,
  publish,
  REPO,
  StopInput,
} from "./publish.live.ts";
import type { Answer, AuthorStop, Deps, Log, StopLogRecord, Stopped } from "./publish.live.ts";

/** The lines of the transcript at `path`; a missing transcript has none. */
export function linesOf(path: string): TranscriptLine[] {
  return existsSync(path) ? transcriptLinesOf(readFileSync(path, "utf8"), path) : [];
}

/**
 * The Stop checks on the head whose record is the file `record`: green when the record is there, a stop
 * having asked the Worker for them on this head; else left to the Worker. The hook starts no `bun check`
 * for any Author: that is the Worker's code, and the hook is outside the sandbox that holds it.
 */
function stopChecks(record: string): StopChecks {
  return existsSync(record) ? { kind: "green" } : { kind: "left" };
}

/** The stop of a decision that publishes nothing: blocked with its reason, or let go. */
const stoppedOf = (next: Refusal, why: string): Stopped =>
  next.kind === "block" ? notPublished(why, next) : notPublished(next.reason);

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

  return askFork(stopping, {
    model: stopping.model,
    prompt: question,
    schema: DONE_SCHEMA,
  });
}

/** The stop of an Author whose branch may be published: admission, the Stop checks it asks for, the Done judge, the Publication. */
async function authorStop(stopping: AuthorStop, stateDir: string): Promise<Stopped> {
  const { deps, input, log, branch, head, git } = stopping;
  // Left by the stop that asked for the commit, and read once by the next one.
  const commitAsked = join(stateDir, `commit-asked-${input.session_id}`);
  const chain = chainOf(input.stop_hook_active === true, existsSync(commitAsked));
  rmSync(commitAsked, { force: true });

  // No fetch in a submodule: it would be git run in a directory of the worktree, under the config found there.
  await deps.run(["git", "fetch", "--quiet", "--no-recurse-submodules", "origin", TRUNK], {
    ...git,
    timeoutMs: 60_000,
  });

  // Read before the PR list, which the Author's credential reads too; only publishing needs the token.
  const token = authorTokenOf(deps.env);
  const gh = ghOptions(stopping.ghCwd, token);

  const snapshot: Snapshot = {
    branch,
    head,
    // A submodule's status is git run in a directory of the worktree, under the config found there.
    treeClean: (await gitOut(deps, git, ["status", "--porcelain", "--ignore-submodules=all"])) === "",
    ahead: Number(await gitOut(deps, git, ["rev-list", "--count", `origin/${TRUNK}..HEAD`])),
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

  // An on-disk name: existing state files carry it, so it stays.
  const record = join(stateDir, `gates-${head}`);
  const checks = stopChecks(record);
  const next = afterStopChecks(checks, chain.reported);
  log({ step: "stop-checks", checks: checks.kind, next: next.kind });

  if (next.kind !== "ask-done-judge") {
    return stoppedOf(next, stopChecksOutcomeOf(head));
  }

  if (checks.kind === "left") {
    // The Worker was asked on this head: a later stop on it is not asked again.
    writeFileSync(record, "left\n");
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

/**
 * Where a session stops: its worktree, the repository's main checkout, whether they are the same, and
 * where the hook runs git and gh and keeps its state for this stop.
 */
interface Place extends Pick<AuthorStop, "worktree" | "checkout" | "git" | "ghCwd"> {
  readonly mainCheckout: boolean;
  readonly stateDir: string;
}

async function placeOf(deps: Deps, cwd: string): Promise<Place> {
  const git = { cwd };
  const worktree = await gitOut(deps, git, ["rev-parse", "--show-toplevel"]);
  const gitDir = await gitOut(deps, git, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = await gitOut(deps, git, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  return {
    worktree,
    checkout: dirname(commonDir),
    mainCheckout: gitDir === commonDir,
    git,
    ghCwd: cwd,
    stateDir: join(worktree, ".lab", "state"),
  };
}

/** `path` with every link in it resolved; null when it names nothing, or cannot be resolved. */
function realPathOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Where an API Worker's session stops: the clone its directory `cwd` lies in, among those `clones`
 * holds, with git handed that clone through its environment and run, as gh is, in the main checkout,
 * where the hook's state lies too. The hook is outside the Worker's sandbox, so it lets git find nothing
 * from the clone and writes nothing there (`clone-git.ts`). Both paths are compared with their links
 * resolved: a home reached through a link names the same clones. Null when `cwd` lies in no clone.
 */
function apiPlaceOf({ checkout, realpath }: Deps, clones: string, cwd: string): Place | null {
  const realClones = realpath(clones);
  const realCwd = realpath(cwd);
  const worktree = realClones === null || realCwd === null ? null : cloneRootOf(realClones, realCwd);

  if (worktree === null) {
    return null;
  }

  return {
    worktree,
    checkout,
    mainCheckout: false,
    git: { cwd: checkout, env: pinnedGitEnvOf(worktree) },
    ghCwd: checkout,
    stateDir: join(checkout, ".lab", "state"),
  };
}

/** The stop of an Author in `place`, on `branch` at `head`: what git alone refuses, then `authorStop`. */
function stopIn(
  place: Place,
  { branch, head }: { readonly branch: string | null; readonly head: string },
  stopping: Pick<AuthorStop, "deps" | "input" | "log" | "model" | "api">,
): Promise<Stopped> {
  const checkout = checkoutOf({ mainCheckout: place.mainCheckout, branch });

  if (checkout.kind === "refused") {
    stopping.log({ step: "admit", kind: "none", reason: checkout.reason });

    return Promise.resolve(notPublished(checkout.reason));
  }

  mkdirSync(place.stateDir, { recursive: true });

  const { worktree, git, ghCwd } = place;

  return authorStop(
    { ...stopping, branch: checkout.branch, head, checkout: place.checkout, worktree, git, ghCwd },
    place.stateDir,
  );
}

/** Appends `line` to `.lab/outcomes.log` of the main checkout `checkout`. */
function appendOutcome(checkout: string, line: string): void {
  mkdirSync(join(checkout, ".lab"), { recursive: true });
  appendFileSync(join(checkout, OUTCOMES_LOG), `${line}\n`);
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

  const api = isApiWorker(deps.env);
  const clones = api ? apiClonesDirOf(requiredOf(deps.env, "HOME")) : null;
  const place = clones === null ? await placeOf(deps, cwd) : apiPlaceOf(deps, clones, cwd);
  const at = new Date(deps.now()).toISOString();

  if (place === null) {
    const reason = `the stop of an API Worker comes from ${cwd}, which lies in no clone of ${clones}`;
    log({ step: "admit", kind: "none", reason });
    deps.recordOutcome(
      deps.checkout,
      outcomeLineOf(
        { at, session: input.session_id, api, worktree: cwd, branch: null, head: null },
        { kind: "not-published", reason },
      ),
    );

    return ALLOW;
  }

  let facts: StopFacts = { at, session: input.session_id, api, worktree: place.worktree, branch: null, head: null };

  let stopped: Stopped;
  let failure: { readonly error: unknown } | null = null;

  try {
    const branch = (await deps.run(["git", "symbolic-ref", "--short", "-q", "HEAD"], place.git)).stdout.trim() || null;
    const head = await gitOut(deps, place.git, ["rev-parse", "HEAD"]);
    facts = { ...facts, branch, head };
    stopped = await stopIn(place, { branch, head }, { deps, input, log, model: modelOf(transcript), api });
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

/**
 * One stop, over the `ports` its door gives it: reads the Stop input on stdin, and prints the block when
 * the hook blocks the stop.
 */
export async function main(ports: Pick<Deps, "run" | "startRelay">): Promise<void> {
  const input = decodeJson(StopInput, "the Stop input", await Bun.stdin.text());
  // An API Worker's log lies in the main checkout: the hook writes nothing in a directory the Worker
  // prepares, where a file it appends to can be a link to any file of the Owner's.
  const logDir = join(isApiWorker(process.env) ? REPO : input.cwd, ".lab");
  const logFile = join(logDir, "stop.log");
  mkdirSync(logDir, { recursive: true });

  const log = (record: StopLogRecord): void => {
    appendFileSync(
      logFile,
      `${JSON.stringify({ at: new Date().toISOString(), session: input.session_id, ...record })}\n`,
    );
  };

  try {
    const deps = {
      ...ports,
      env: process.env,
      now: Date.now,
      checkout: REPO,
      recordOutcome: appendOutcome,
      realpath: realPathOf,
    };

    const answer = await stop(input, deps, log);

    if (answer.kind === "block") {
      console.log(JSON.stringify({ decision: "block", reason: answer.reason }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log({ step: "error", message });
    console.error(`stop hook: ${message}`);
  }
}
