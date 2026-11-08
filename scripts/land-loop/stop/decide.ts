/**
 * The Stop decision of the Author's session, as pure functions over what the hook read. `admit`
 * settles what git and the transcript alone settle; `afterAuthorToken` whether the Author's token
 * lets it publish; `afterStopChecks` what the Stop checks' result
 * adds; `decide` what the Done judge's answer adds. Each returns the next thing the hook does.
 */

import { AUTHOR_MARK } from "../author-mark.ts";

/**
 * The marker that opens every question the hook puts to a fork, so a fork stays recognisable. The
 * transcripts of earlier forks carry this exact string, so it stays as it is.
 */
export const FORK_MARKER = "[harness:fork-probe]";

/** Branches the hook never publishes: the trunk, the release branch, and the lab's own test branches. */
export const IGNORED_BRANCH = /^(dev|main|lab\/.*)$/u;

export interface PullRequest {
  readonly number: number;
  readonly draft: boolean;
  readonly headSha: string;
  readonly labels: readonly string[];
}

export interface Snapshot {
  /** The hook runs inside a fork it launched: the environment flag is set. */
  readonly forkFlag: boolean;
  /** The session's transcript opens a user turn with the fork marker: a fork, resumed later. */
  readonly forkMarker: boolean;
  /** Claude Code's `stop_hook_active`: this stop follows a block of this hook. */
  readonly stopHookActive: boolean;
  /** Null on a detached HEAD. */
  readonly branch: string | null;
  readonly head: string;
  readonly treeClean: boolean;
  /** Commits on HEAD that `origin/dev` lacks. */
  readonly ahead: number;
  readonly pr: PullRequest | null;
  /** The PR watch was already asked for on this PR at this head. */
  readonly armed: boolean;
}

export type Admission =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "arm"; readonly pr: number }
  | { readonly kind: "stop-checks" };

export type StopChecks = { readonly kind: "green" } | { readonly kind: "red"; readonly report: string };

export type Next =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "ask-done-judge" };

export type Answer =
  { readonly kind: "yes" } | { readonly kind: "hold"; readonly reason: string } | { readonly kind: "no" };

/** `hold` is the reason the Done judge held the PR for the Owner's read, or null. */
export type Action =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "open"; readonly hold: string | null }
  | { readonly kind: "push"; readonly pr: number; readonly ready: boolean; readonly hold: string | null };

const none = (reason: string): Extract<Admission, { kind: "none" }> => ({ kind: "none", reason });

export function admit(snapshot: Snapshot): Admission {
  if (snapshot.forkFlag) {
    return none("this session is a fork the hook launched");
  }

  if (snapshot.forkMarker) {
    return none("this session is a fork, resumed");
  }

  if (snapshot.branch === null) {
    return none("HEAD is detached");
  }

  if (IGNORED_BRANCH.test(snapshot.branch)) {
    return none(`${snapshot.branch} is never published`);
  }

  if (snapshot.ahead === 0) {
    return none(`${snapshot.branch} has no commit that dev lacks`);
  }

  if (!snapshot.treeClean) {
    return none("the tree has uncommitted changes");
  }

  const { pr } = snapshot;

  if (pr !== null && !pr.draft && pr.headSha === snapshot.head) {
    return snapshot.armed ? none(`#${pr.number} is ready at ${snapshot.head} already`) : { kind: "arm", pr: pr.number };
  }

  return { kind: "stop-checks" };
}

/** No Author token blocks once, naming where it was looked for; a second stop without it lets the session end. */
export function afterAuthorToken(found: boolean, path: string, stopHookActive: boolean): Next | null {
  if (found) {
    return null;
  }

  if (stopHookActive) {
    return none("no Author token after a block: nothing is published");
  }

  return {
    kind: "block",
    reason: `The Stop hook found no Author token at ${path}, so nothing was published. The Owner provisions it (AGENTS.md, Identities). Stop, and ask no question.`,
  };
}

/** Red Stop checks block once, with their report; a second stop on the same failure lets the session end. */
export function afterStopChecks(stopChecks: StopChecks, stopHookActive: boolean): Next {
  if (stopChecks.kind === "green") {
    return { kind: "ask-done-judge" };
  }

  if (stopHookActive) {
    return none("the Stop checks are still red after a block: nothing is published");
  }

  return {
    kind: "block",
    reason: `The Stop checks are red on this head, so nothing was published:\n\n${stopChecks.report}\n\nFix them and commit, then stop.`,
  };
}

/** The label that holds a PR for the Owner; open PRs and GitHub's ruleset carry this spelling. */
const HUMAN_LABEL = "land:human";

const HOLD_REASON_MAX = 300;

/** YES first on the line, as a word, after a heading marker or the emphasis it opens. */
const YES_FIRST = /^[#\s]*([*_]*)YES(?![\p{L}\p{N}])/u;

/** HOLD as a word, then its closing emphasis, a separator and the emphasis that closes it, then the reason. */
const HOLD_WORD = /(?<![\p{L}\p{N}])HOLD(?![\p{L}\p{N}])[*_]*\s*[:\-–—]?(?:[*_]+(?=\s|$))?\s*(.*)/u;

/**
 * The Done judge's text answer, read on its first line: YES first, as a word, is yes, and a hold when
 * HOLD follows it, with the rest as its reason; anything else, an empty answer included, is no.
 */
export function answerOf(text: string): Answer {
  const first = text.trimStart().split("\n")[0] ?? "";
  const yes = YES_FIRST.exec(first);

  if (yes === null) {
    return { kind: "no" };
  }

  // Any YES line that names HOLD holds, so an answer worded off the `YES, HOLD:` form fails closed.
  const hold = HOLD_WORD.exec(first.slice(yes[0].length));

  if (hold === null) {
    return { kind: "yes" };
  }

  const rest = (hold[1] ?? "").trim();
  // The emphasis that opened the line closes at its end, as in `**YES, HOLD: reason**`.
  const reason = (yes[1] === "" ? rest : rest.replace(/[*_]+$/u, "")).trim();

  return { kind: "hold", reason: (reason === "" ? "(no reason given)" : reason).slice(0, HOLD_REASON_MAX) };
}

export function decide(pr: PullRequest | null, answer: Answer): Action {
  if (answer.kind === "no") {
    return none("the Done judge says the task is not finished");
  }

  const hold = answer.kind === "hold" ? answer.reason : null;

  if (pr === null) {
    return { kind: "open", hold };
  }

  return { kind: "push", pr: pr.number, ready: pr.draft, hold };
}

/** What a hold puts on the PR: the label and the Author's comment, both only when the PR lacks the label. */
export interface HoldSteps {
  readonly addLabel: boolean;
  readonly comment: string | null;
}

export function holdStepsOf(hold: string | null, labels: readonly string[]): HoldSteps {
  if (hold === null || labels.includes(HUMAN_LABEL)) {
    return { addLabel: false, comment: null };
  }

  return { addLabel: true, comment: `Held for the Owner by the Author: ${hold}\n\n${AUTHOR_MARK}` };
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

/** The commands the Author runs on its PR: the PR watch, a thread reply, a comment on the conversation. */
export interface ArmCommands {
  readonly prWatch: string;
  readonly thread: string;
  readonly comment: string;
}

/** What the hook tells the author once its PR is ready: arm the PR watch, then stop. */
export function armReason(pr: number, commands: ArmCommands, hold: string | null = null): string {
  const { prWatch: prWatchCommand, thread: threadCommand, comment: commentCommand } = commands;

  return [
    `PR #${pr} is ready for review. The Stop hook pushed your branch; you do not push, open or ready anything yourself.`,
    ...(hold === null
      ? []
      : [`The Done judge held this PR for the Owner's read: ${hold.replace(/\.$/u, "")}. Do not remove land:human.`]),
    "",
    "Arm the PR watch on it now with Monitor, with the longest timeout:",
    "",
    `    ${prWatchCommand}`,
    "",
    "Each line it prints is a failing check, an Important or Nit finding, a human comment, or a change of state of the PR. Judge every finding, a Nit as an Important: fix it or reject it. Pre-existing findings never block: leave them.",
    "",
    "- A failing check: fix it with a commit, then stop.",
    `- A finding you accept: fix it with a commit, then reply and resolve its thread: \`${threadCommand} <thread-id> "Fixed in <sha>: <what changed>"\`. Then stop.`,
    `- A finding you reject: reply with your reason and resolve: \`${threadCommand} <thread-id> --reject "<your reason>"\`. Then stop.`,
    '- A finding you fix in part: it is a fix; start with "Fixed in <sha>: " and name what stays as is.',
    `- To explain a decision on the PR, post it with \`${commentCommand} "<what you decided and why>"\`, never with \`gh pr comment\`: the PR watch prints an unmarked comment back to you as a human's.`,
    "",
    "Never ask the Owner a question about the PR: the Land loop and the Owner handle the rest. When the PR watch expires, arm it again, until it reports the PR landed or closed. Then stop.",
  ].join("\n");
}
