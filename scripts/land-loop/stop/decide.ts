/**
 * The Stop decision of an Author's session, as pure functions over what the hook read. `bystanderOf`
 * says whose stop the hook leaves alone; `admit` settles what git and the PR alone settle;
 * `afterAuthorToken` whether the Author's token lets it publish; `afterStopChecks` what the Stop checks'
 * result adds; `decide` what the Done judge's answer adds. Each returns the next thing the hook does.
 * `questionOpen` says whether a question the hook put to the Owner still waits for the answer.
 */

import { Result, Schema } from "effect";

import { AUTHOR_VARIABLE } from "../../lib/author-session.ts";
import { codeSpan, escapeHtml } from "../../lib/markdown.ts";
import { AUTHOR_MARK, QUESTION_MARK, REJECT_MARK } from "../author-mark.ts";
import { AUTHOR_LOGIN, OWNER_LOGIN } from "../logins.ts";

/**
 * The marker that opens every question the hook puts to a fork, so a fork stays recognisable. The
 * transcripts of earlier forks carry this exact string, so it stays as it is.
 */
export const FORK_MARKER = "[harness:fork-probe]";

/** Branches the hook never publishes: the trunk, the release branch, and the lab's own test branches. */
const IGNORED_BRANCH = /^(dev|main|lab\/.*)$/u;

export interface Session {
  /** The session's environment holds `LAB_AUTHOR=1`. */
  readonly author: boolean;
  /** The hook runs inside a fork it launched: the environment flag is set. */
  readonly forkFlag: boolean;
  /** The session's transcript opens a user turn with the fork marker: a fork, resumed later. */
  readonly forkMarker: boolean;
}

/**
 * Why the hook does nothing for this session, or null for an Author's own session. A fork is read
 * first: it inherits the environment of the Author it forks.
 */
export function bystanderOf(session: Session): string | null {
  if (session.forkFlag) {
    return "this session is a fork the hook launched";
  }

  if (session.forkMarker) {
    return "this session is a fork, resumed";
  }

  return session.author ? null : `this session is not an Author: its environment holds no ${AUTHOR_VARIABLE}=1`;
}

export interface PullRequest {
  readonly number: number;
  readonly draft: boolean;
  readonly headSha: string;
}

/** A PR of the branch that was closed without landing, and the head it had when it was closed. */
export interface ClosedPullRequest {
  readonly number: number;
  readonly headSha: string;
}

/** Where an Author's session stops: its checkout and the branch checked out there. */
export interface Checkout {
  /** The directory is the repository's main checkout, not a worktree of its own. */
  readonly mainCheckout: boolean;
  /** Null on a detached HEAD. */
  readonly branch: string | null;
}

export type CheckoutVerdict =
  { readonly kind: "refused"; readonly reason: string } | { readonly kind: "publishable"; readonly branch: string };

const refused = (reason: string): CheckoutVerdict => ({ kind: "refused", reason });

/** Whether the hook may publish from this checkout: its branch, or why it publishes nothing from there. */
export function checkoutOf({ mainCheckout, branch }: Checkout): CheckoutVerdict {
  if (branch === null) {
    return refused("HEAD is detached");
  }

  if (IGNORED_BRANCH.test(branch)) {
    return refused(`${branch} is never published`);
  }

  return mainCheckout
    ? refused("this session works in the main checkout: an Author publishes from its own worktree")
    : { kind: "publishable", branch };
}

export interface Snapshot {
  readonly branch: string;
  readonly head: string;
  readonly treeClean: boolean;
  /** Commits on HEAD that `origin/dev` lacks. */
  readonly ahead: number;
  readonly pr: PullRequest | null;
}

/**
 * Where a stop stands in a chain of stops: Claude Code marks each stop that follows a block of the hook,
 * and the hook keeps whether that block only asked for the commit.
 */
export interface Chain {
  /** A block came before this stop: a dirty tree is not asked about again. */
  readonly blocked: boolean;
  /** A block that reported a failure came before: the Author token, the Stop checks and the Done judge block no more. */
  readonly reported: boolean;
}

/**
 * The chain of a stop Claude Code marks `stopHookActive`, when the block before it asked for the commit
 * (`commitAsked`) or not. Asking for the commit reports no failure, so it leaves the token, the Stop
 * checks and the Done judge their one block: a chain blocks at most twice.
 */
export function chainOf(stopHookActive: boolean, commitAsked: boolean): Chain {
  return { blocked: stopHookActive, reported: stopHookActive && !commitAsked };
}

export type Admission =
  | { readonly kind: "none"; readonly reason: string }
  /** Blocked once: `reason` is what the Author reads, `outcome` why nothing is published. */
  | { readonly kind: "block"; readonly reason: string; readonly outcome: string }
  /** The stop could open a PR: `afterClosed` decides, once the branch's closed PRs are read. */
  | { readonly kind: "read-closed" }
  /** The PR is ready at this head: nothing to publish; the Nit threads a stop closes are closed. */
  | { readonly kind: "ready"; readonly pr: number; readonly reason: string }
  | { readonly kind: "stop-checks" };

export type StopChecks = { readonly kind: "green" } | { readonly kind: "red"; readonly report: string };

/** A stop that publishes nothing: let go, or blocked once with a reason the Author reads. */
export type Refusal =
  { readonly kind: "none"; readonly reason: string } | { readonly kind: "block"; readonly reason: string };

export type Next = Refusal | { readonly kind: "ask-done-judge" };

/** A finding the Author rejects: the thread it names, and the Author's reason. */
export interface Rejection {
  readonly thread: string;
  readonly reason: string;
}

/**
 * The Done judge's answer: whether the change is finished, the question the Author's last message
 * leaves to its user (empty when it asks none), why, and the findings the Author rejects.
 */
export interface DoneAnswer {
  readonly finished: boolean;
  readonly question: string;
  readonly reason: string;
  readonly rejections: readonly Rejection[];
}

export type Action =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "open" }
  | { readonly kind: "push"; readonly pr: number; readonly ready: boolean }
  /**
   * The Author's question goes to the Owner on a draft PR: the one opened for it when `pr` is null, else
   * `pr`, sent back to draft first when `toDraft`. `question` is posted when `post`, which is false while
   * an earlier question waits for its answer; `reason` says why nothing lands.
   */
  | {
      readonly kind: "ask";
      readonly question: string;
      readonly reason: string;
      readonly pr: number | null;
      readonly toDraft: boolean;
      readonly post: boolean;
    }
  /** PR `pr` waits for the Owner's answer: nothing is pushed or readied, and its relay is left to bring the answer. */
  | { readonly kind: "hold"; readonly pr: number; readonly reason: string };

const none = (reason: string): Extract<Refusal, { kind: "none" }> => ({ kind: "none", reason });

const UNCOMMITTED = "the tree has uncommitted changes";

/**
 * Uncommitted changes block the first stop of a chain, asking for the commit alone; a later stop on a
 * tree still dirty (`blocked`) lets the session end.
 */
export function admit(snapshot: Snapshot, blocked: boolean): Admission {
  if (!snapshot.treeClean) {
    return blocked
      ? none(UNCOMMITTED)
      : { kind: "block", reason: "Commit your changes, then stop.", outcome: UNCOMMITTED };
  }

  if (snapshot.ahead === 0) {
    return none(`${snapshot.branch} has no commit that dev lacks`);
  }

  const { pr } = snapshot;

  if (pr === null) {
    return { kind: "read-closed" };
  }

  if (!pr.draft && pr.headSha === snapshot.head) {
    return { kind: "ready", pr: pr.number, reason: `#${pr.number} is ready at ${snapshot.head} already` };
  }

  return { kind: "stop-checks" };
}

/** What a stop that could open a PR does, given the branch's PRs closed without landing. */
export function afterClosed(
  head: string,
  closed: readonly ClosedPullRequest[],
): Extract<Admission, { kind: "none" | "stop-checks" }> {
  const closedHere = closed.find((one) => one.headSha === head);

  return closedHere === undefined
    ? { kind: "stop-checks" }
    : none(`#${closedHere.number} was closed without landing at ${head}: a stop at the head it had publishes nothing`);
}

/**
 * No Author token blocks once, naming where it was looked for; a stop without it after a block that
 * reported a failure (`Chain.reported`) lets the session end.
 */
export function noAuthorToken(path: string, reported: boolean): Refusal {
  if (reported) {
    return none("no Author token after a block: nothing is published");
  }

  return {
    kind: "block",
    reason: `The Stop hook found no Author token at ${path}, so nothing was published. The Owner provisions it (.claude/rules/identities.md). Stop, and ask no question.`,
  };
}

/**
 * Red Stop checks block once, with their report; red again after a block that reported a failure
 * (`Chain.reported`), they let the session end.
 */
export function afterStopChecks(stopChecks: StopChecks, reported: boolean): Next {
  if (stopChecks.kind === "green") {
    return { kind: "ask-done-judge" };
  }

  if (reported) {
    return none("the Stop checks are still red after a block: nothing is published");
  }

  return {
    kind: "block",
    reason: `The Stop checks are red on this head, so nothing was published:\n\n${stopChecks.report}\n\nFix them and commit, then stop.`,
  };
}

/** The JSON Schema of the Done judge's answer, which the fork's structured output must follow. */
export const DONE_SCHEMA = {
  type: "object",
  properties: {
    finished: { type: "boolean" },
    question: { type: "string" },
    reason: { type: "string" },
    rejections: {
      type: "array",
      items: {
        type: "object",
        properties: { thread: { type: "string" }, reason: { type: "string" } },
        required: ["thread", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["finished", "question", "reason", "rejections"],
  additionalProperties: false,
};

const DoneAnswerSchema = Schema.Struct({
  finished: Schema.Boolean,
  question: Schema.String,
  reason: Schema.String,
  rejections: Schema.Array(Schema.Struct({ thread: Schema.String, reason: Schema.String })),
});

const decodeDoneAnswer = Schema.decodeUnknownResult(DoneAnswerSchema);

/** What the Done judge's fork gave: its exit code, and its structured output, undefined when it gave none. */
export interface ForkAnswer {
  readonly code: number;
  readonly structured: unknown;
}

/**
 * The Done judge's answer a fork gave; null, no answer, for a fork that failed or whose structured
 * output does not fit `DONE_SCHEMA`.
 */
export function doneAnswerOf(fork: ForkAnswer): DoneAnswer | null {
  return fork.code === 0 ? Result.getOrNull(decodeDoneAnswer(fork.structured)) : null;
}

/**
 * A Done judge that gave no answer, its fork failed or its output fits no schema, is not a "not
 * finished": the first such stop blocks so the Author stops again and the hook asks again; one after a
 * block that reported a failure (`Chain.reported`) lets the session end.
 */
export function noDoneAnswer(code: number, reported: boolean): Refusal {
  if (reported) {
    return none("the Done judge gave no answer after a block: nothing is published");
  }

  return {
    kind: "block",
    reason: `The Stop hook could not ask whether your change is finished (the Done judge's fork exited ${code} with no answer that reads), so nothing was published. Stop again to retry; ask no question.`,
  };
}

/** The question of a Done judge's answer as the outcome and the log quote it: trimmed, then cut to 300 characters. */
export function quotedQuestionOf(question: string): string {
  return question.trim().slice(0, 300);
}

/**
 * What the Done judge's answer does to the branch's PR `pr`. `asked`: the PR's conversation holds a
 * question the hook put to the Owner, still unanswered; a PR that holds one is never pushed or readied.
 */
export function decide(pr: PullRequest | null, answer: DoneAnswer, asked: boolean): Action {
  const question = quotedQuestionOf(answer.question);
  const unfinished = `the Done judge says the change is not finished: ${answer.reason}`;

  if (question !== "") {
    const asking = `the Author's last message leaves a question to its user: ${question}`;

    return {
      kind: "ask",
      question: answer.question.trim(),
      reason: answer.finished ? asking : `${asking}; ${unfinished}`,
      pr: pr?.number ?? null,
      toDraft: pr !== null && !pr.draft,
      post: !asked,
    };
  }

  if (!answer.finished) {
    return none(unfinished);
  }

  if (pr !== null && asked) {
    return {
      kind: "hold",
      pr: pr.number,
      reason: `#${pr.number} holds a question to the Owner with no answer: nothing is pushed or readied`,
    };
  }

  return pr === null ? { kind: "open" } : { kind: "push", pr: pr.number, ready: pr.draft };
}

/** The rejections the hook posts, and those it drops. */
export interface SortedRejections {
  readonly posted: readonly Rejection[];
  readonly dropped: readonly Rejection[];
}

/**
 * The rejections of the Done judge's answer, sorted: one is posted when it names an open thread of the
 * App, once per thread, with a reason; any other is dropped.
 */
export function rejectionsOf(rejections: readonly Rejection[], openThreads: readonly string[]): SortedRejections {
  const open = new Set(openThreads);
  const posted: Rejection[] = [];
  const dropped: Rejection[] = [];

  for (const rejection of rejections) {
    const known = open.has(rejection.thread) && !posted.some((earlier) => earlier.thread === rejection.thread);

    (known && rejection.reason.trim() !== "" ? posted : dropped).push(rejection);
  }

  return { posted, dropped };
}

/**
 * The reply the hook posts in the thread of a finding the Author rejects: the Author's reason, the
 * reject mark the Review check counts, and the Author's mark. It cites no commit: nobody declares a fix.
 */
export function rejectionReplyOf(reason: string): string {
  return `Rejected: ${escapeHtml(reason.trim())}\n\n${REJECT_MARK}\n\n${AUTHOR_MARK}`;
}

/** A comment on a PR, by its author's login. */
export interface PrComment {
  readonly author: string;
  readonly body: string;
}

/**
 * Whether the Owner wrote these words by hand. The lab is public and any GitHub login can comment on a
 * pull request: of a person's words, the Land loop reads the Owner's alone, never another login's, which
 * would reach the Author's session as a turn to act on.
 */
export const byOwner = (comment: PrComment): boolean =>
  comment.author === OWNER_LOGIN && !comment.body.includes(AUTHOR_MARK);

/**
 * The question of the Author the Owner has not answered among the PR's conversation `comments`, in
 * their order: the last comment the hook posted with the question mark, when no comment of the Owner
 * follows it; else null.
 */
export function openQuestionOf<C extends PrComment>(comments: readonly C[]): C | null {
  const asked = comments.findLastIndex(
    (comment) => comment.author === AUTHOR_LOGIN && comment.body.includes(QUESTION_MARK),
  );

  const question = comments[asked];

  return question === undefined || comments.slice(asked + 1).some((comment) => byOwner(comment)) ? null : question;
}

/** Whether the PR's conversation `comments`, in their order, hold a question of the Author the Owner has not answered. */
export const questionOpen = (comments: readonly PrComment[]): boolean => openQuestionOf(comments) !== null;

/** The comment that puts the Author's quoted `question` to the Owner, from `branch` and `session`. */
export function questionCommentOf(question: string, branch: string, session: string): string {
  const quoted = escapeHtml(question)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return [
    `The Author of ${codeSpan(branch)} (session ${codeSpan(session)}) asks the Owner, and waits for the answer:`,
    quoted,
    "Answer in a comment in this pull request's conversation: it reaches the Author's session. The pull request stays in draft until the Owner answers there and the Author stops with no question.",
    QUESTION_MARK,
    AUTHOR_MARK,
  ].join("\n\n");
}

/** A Worker's branch is `<type>/<N>-<slug>`, made for issue N. */
const ISSUE_BRANCH = /^[a-z]+\/(\d+)-/u;

/** The line that closes the branch's issue when the PR lands, or null when the branch names none or the body closes it already. */
export function closingLineOf(branch: string, body: string): string | null {
  const issue = ISSUE_BRANCH.exec(branch)?.[1];

  if (issue === undefined) {
    return null;
  }

  const closes = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #${issue}(?!\d)`, "iu");

  return closes.test(body) ? null : `Closes #${issue}`;
}

/**
 * What one stop of an Author left: a Publication with its PR, a question to the Owner with the draft PR
 * it went to and why nothing lands, or nothing published and why.
 */
export type Outcome =
  | { readonly kind: "published"; readonly pr: number }
  | { readonly kind: "asked"; readonly pr: number; readonly reason: string }
  | { readonly kind: "not-published"; readonly reason: string };

/** Where and when an Author stopped. `branch` and `head` are null when the hook could not read them. */
export interface StopFacts {
  readonly at: string;
  readonly session: string;
  readonly worktree: string;
  readonly branch: string | null;
  readonly head: string | null;
}

/**
 * One line of `.lab/outcomes.log`, without its newline: the stop, then `published` with the PR, `asked`
 * with the PR and its reason, or `not-published` with its reason.
 */
export function outcomeLineOf(facts: StopFacts, outcome: Outcome): string {
  const { kind, ...fields } = outcome;

  return JSON.stringify({ ...facts, outcome: kind, ...fields });
}
