/**
 * The Publication of an Author's stop, and what it asks on the way: a fork of the session, GitHub as the
 * Author's machine account, and git. The rejections first, each a reply and a resolved thread, and the
 * findings the Author fixed, then the push, the PR opened or readied, the Nit threads resolved and the
 * relay left. A stop that leaves a question puts it to the Owner on a draft PR instead.
 */

import { resolve } from "node:path";

import { Schema } from "effect";

import { TRUNK } from "../../install/host.ts";
import { APP_LOGIN } from "../../install/logins.ts";
import { decodeJson } from "../../lib/json.ts";
import { checked } from "../../lib/run.port.ts";
import type { Run, RunOptions } from "../../lib/run.port.ts";
import { ghEnv, pushArgs } from "../shared/author.live.ts";
import type { AuthorToken } from "../shared/author.live.ts";
import { openFindingsOf, ReviewThreads, threadsQueryOf } from "../shared/findings.ts";
import type { OpenFinding } from "../shared/findings.ts";
import type { StartRelay } from "../shared/relay.port.ts";
import { replyInThread, resolveThread } from "../shared/threads.ts";
import {
  closingLineOf,
  decide,
  fixedOf,
  fixedRecordBodyOf,
  questionCommentOf,
  rejectionReplyOf,
  rejectionsOf,
} from "./decide.ts";
import type { Action, ClosedPullRequest, DoneAnswer, FixedRecord, Outcome, PullRequest, Rejection } from "./decide.ts";
import { DONE_JUDGE } from "./done-judge.actor.ts";
import { BODY_REQUEST } from "./done-judge.prompt.ts";
import { apiForkOf, forkArgvOf, forkResultOf, forkSettingsOf, prTextOf } from "./fork.ts";
import type { ForkAsk, ForkResult } from "./fork.ts";

export const FORK_FLAG = "LAB_STOP_FORK";

/** The repository of the hook's own files, where the fork guard lives; the Author's cwd may be another checkout. */
export const REPO = resolve(import.meta.dir, "..", "..", "..");

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
  /** The checkout that holds the hook's own files: the main checkout, for a session that runs its hooks. */
  readonly checkout: string;
  /** Appends `line` to `.lab/outcomes.log` of the main checkout `checkout`. */
  readonly recordOutcome: (checkout: string, line: string) => void;
}

export async function askFork(deps: Deps, input: StopInput, ask: ForkAsk): Promise<ForkResult> {
  const started = deps.now();

  const api = apiForkOf(deps.env, REPO);
  const settings = forkSettingsOf(REPO, api);

  const ran = await deps.run(forkArgvOf(input.session_id, ask, settings, api !== null), {
    cwd: input.cwd,
    env: { [FORK_FLAG]: "1" },
    timeoutMs: DONE_JUDGE.timeoutMs,
  });

  return forkResultOf(ran.stdout, ran.code, deps.now() - started);
}

/** What `git` prints for `args`, run where and how `at` says. */
export async function gitOut(deps: Deps, at: RunOptions, args: readonly string[]): Promise<string> {
  return (await checked(deps.run, ["git", ...args], at)).trim();
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
export function ghOptions(cwd: string, author: AuthorToken): RunOptions {
  return author.kind === "found" ? { cwd, env: ghEnv(author.token) } : { cwd };
}

/** The branch's open PR; `--head` also matches a fork's branch of the same name, which is not the Author's. */
export async function prOf(deps: Deps, gh: RunOptions, branch: string): Promise<PullRequest | null> {
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
export async function closedPrsOf(deps: Deps, gh: RunOptions, branch: string): Promise<readonly ClosedPullRequest[]> {
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
export async function openFindings(deps: Deps, gh: RunOptions, pr: number): Promise<readonly OpenFinding[]> {
  const answer = await checked(
    deps.run,
    ["gh", "api", "graphql", "-f", `query=${threadsQueryOf(pr)}`, "-F", "owner={owner}", "-F", "name={repo}"],
    gh,
  );

  const threads = decodeJson(ReviewThreads, "the review threads query", answer).data.repository.pullRequest
    .reviewThreads.nodes;

  return openFindingsOf(APP_LOGIN, threads);
}

/** The body of a PR the hook opens: the fork's body, then the closing line. */
function openBodyOf(branch: string, forkBody: string): string {
  return [forkBody, closingLineOf(branch, forkBody)].filter((part) => part !== null && part !== "").join("\n\n");
}

/** What Claude Code is told: let the session stop, or block the stop with a reason the Author reads. */
export type Answer = { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string };

export const ALLOW: Answer = { kind: "allow" };

/** One `.lab/stop.log` record: the step it logs, and that step's fields. */
export interface StopLogRecord {
  readonly step: string;
  readonly [field: string]: Schema.Json;
}

export type Log = (record: StopLogRecord) => void;

/** What one stop of an Author gave: the hook's answer, and the outcome it leaves. */
export interface Stopped {
  readonly answer: Answer;
  readonly outcome: Outcome;
}

export const notPublished = (reason: string, answer: Answer = ALLOW): Stopped => ({
  answer,
  outcome: { kind: "not-published", reason },
});

/** The Author's stop, as its steps read it. */
export interface AuthorStop {
  readonly deps: Deps;
  readonly input: StopInput;
  readonly log: Log;
  readonly branch: string;
  readonly head: string;
  /** The main checkout, where the relay runs. */
  readonly checkout: string;
  /** The tree the stop comes from: a worktree of the main checkout, or the clone of an API Worker. */
  readonly worktree: string;
  /**
   * Where and how the hook runs git for this stop: in the session's directory, or, for an API Worker, in
   * the main checkout with the clone handed over through git's environment (`clone-git.ts`).
   */
  readonly git: RunOptions;
  /** The directory the hook runs gh in: the session's, or the main checkout for an API Worker. */
  readonly ghCwd: string;
  readonly model: string | null;
  /** The session is an API Worker's: the relay resumes it headless. */
  readonly api: boolean;
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
export async function closeNits(stopping: AuthorStop, gh: RunOptions, findings: readonly OpenFinding[]): Promise<void> {
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
    const { input, checkout, worktree, model, api } = stopping;
    const headless = api ? { model, worktree } : null;
    const started = stopping.deps.startRelay({ pr, session: input.session_id, headless, checkout });
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

  const subject = await gitOut(deps, stopping.git, ["log", "-1", "--format=%s"]);
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
    cwd: stopping.git.cwd,
    env: { ...stopping.git.env, LAB_AUTHOR_TOKEN: author.token },
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
export async function publish(stopping: AuthorStop, author: Credential, judged: Judged): Promise<Stopped> {
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
