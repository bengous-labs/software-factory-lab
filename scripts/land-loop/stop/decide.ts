/**
 * The Stop decision of the Author's session, as pure functions over what the hook read. `admit` settles
 * what git and the transcript alone settle; `afterGates` what the gates' result adds; `decide` what
 * the Done judge's answer adds. Each returns the next thing the hook does.
 */

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
  | { readonly kind: "gates" };

export type Gates = { readonly kind: "green" } | { readonly kind: "red"; readonly report: string };

export type Next =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "ask-done-judge" };

export type Answer = "yes" | "no";

export type Action =
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "open" }
  | { readonly kind: "push"; readonly pr: number; readonly ready: boolean };

const none = (reason: string): { kind: "none"; reason: string } => ({ kind: "none", reason });

export function admit(snapshot: Snapshot): Admission {
  if (snapshot.forkFlag) return none("this session is a fork the hook launched");

  if (snapshot.forkMarker) return none("this session is a fork, resumed");

  if (snapshot.branch === null) return none("HEAD is detached");

  if (IGNORED_BRANCH.test(snapshot.branch)) return none(`${snapshot.branch} is never published`);

  if (snapshot.ahead === 0) return none(`${snapshot.branch} has no commit that dev lacks`);

  if (!snapshot.treeClean) return none("the tree has uncommitted changes");

  const { pr } = snapshot;

  if (pr !== null && !pr.draft && pr.headSha === snapshot.head) {
    return snapshot.armed ? none(`#${pr.number} is ready at ${snapshot.head} already`) : { kind: "arm", pr: pr.number };
  }

  return { kind: "gates" };
}

/** Red gates block once, with their report; a second stop on the same failure lets the session end. */
export function afterGates(gates: Gates, stopHookActive: boolean): Next {
  if (gates.kind === "green") return { kind: "ask-done-judge" };

  if (stopHookActive) return none("the gates are still red after a block: nothing is published");

  return {
    kind: "block",
    reason: `The gates are red on this head, so nothing was published:\n\n${gates.report}\n\nFix them and commit, then stop.`,
  };
}

/** The Done judge's text answer: YES first, as a word, is yes; anything else, an empty answer included, is no. */
export function answerOf(text: string): Answer {
  return /^\s*\**YES\b/u.test(text) ? "yes" : "no";
}

export function decide(pr: PullRequest | null, answer: Answer): Action {
  if (answer === "no") return none("the Done judge says the task is not finished");

  if (pr === null) return { kind: "open" };

  return { kind: "push", pr: pr.number, ready: pr.draft };
}

/** What the hook tells the author once its PR is ready: arm the PR watch, then stop. */
export function armReason(pr: number, watchCommand: string, threadCommand: string): string {
  return [
    `PR #${pr} is ready for review. The Stop hook pushed your branch; you do not push, open or ready anything yourself.`,
    "",
    "Arm the PR watch on it now with Monitor, with the longest timeout:",
    "",
    `    ${watchCommand}`,
    "",
    "Each line it prints is a failing check, an Important finding or a human comment, or a change of state of the PR. Nit and Pre-existing findings never block: leave them.",
    "",
    "- A failing check: fix it with a commit, then stop.",
    `- A finding you accept: fix it with a commit, then reply and resolve its thread: \`${threadCommand} <thread-id> "Fixed in <sha>: <what changed>"\`. Then stop.`,
    `- A finding you reject: reply with your reason and resolve: \`${threadCommand} <thread-id> "<your reason>"\`. Then stop.`,
    "",
    "Never ask the Owner a question about the PR: the Land loop and the Owner handle the rest. When the PR watch expires, arm it again, until it reports the PR landed or closed. Then stop.",
  ].join("\n");
}
