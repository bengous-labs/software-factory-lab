/**
 * The Stop decision of the Author's session, as pure functions over what the hook read. `admit`
 * settles what git and the transcript alone settle; `afterAuthorToken` whether the Author's token
 * lets it publish; `afterStopChecks` what the Stop checks' result
 * adds; `decide` what the Done judge's answer adds; `afterLocalReview` what the local review of a
 * risky branch adds. Each returns the next thing the hook does.
 */

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { TokenCounts } from "../../lib/tokens.ts";
import { AUTHOR_MARK } from "../author-mark.ts";
import { FACTORY_CONFIG_PATH } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import type { EarlierThread } from "../review/findings.ts";
import type { Severity } from "../review/review-report.ts";
import { matching } from "../routing/routing-rules.ts";

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
  | { readonly kind: "ask-done-judge" }
  | { readonly kind: "publish" };

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
  const hold = HOLD_WORD.exec(first);

  if (hold === null) {
    return { kind: "yes" };
  }

  const rest = hold[1] ?? "";
  // The emphasis that opened the line closes at its end, as in `**YES, HOLD: reason**`.
  const reason = (yes[1] === "" ? rest : rest.replace(/[*_]+\s*$/u, "")).trim();

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

/** The risky paths of `paths`: the factory config and the paths the policy names. */
export function riskyPathsOf(paths: readonly string[], policy: RoutingPolicy): readonly string[] {
  return matching(
    [FACTORY_CONFIG_PATH, ...policy.ownerPaths, ...policy.factoryPaths, ...policy.deepReviewPaths],
    paths,
  );
}

/** Whether a branch that changes `paths` gets a local deep review: one of them is risky. */
export function localReviewNeeded(paths: readonly string[], policy: RoutingPolicy): boolean {
  return riskyPathsOf(paths, policy).length > 0;
}

const LocalFinding = Schema.Struct({
  file: Schema.String,
  line: Schema.NullOr(Schema.Int),
  severity: Schema.Literals(["important", "nit", "pre_existing"] satisfies readonly Severity[]),
  summary: Schema.String,
  failureScenario: Schema.String,
});

export type LocalFinding = typeof LocalFinding.Type;

/** `.lab/state/review-<head>.json`: what the local review session found on that head. */
const LocalReviewRecord = Schema.Struct({
  findings: Schema.Array(LocalFinding),
  model: Schema.NullOr(Schema.String),
  tokens: Schema.NullOr(TokenCounts),
});

export type LocalReviewRecord = typeof LocalReviewRecord.Type;

/** A head's local review: its stored result, or why the session gave none. */
export type LocalReview = LocalReviewRecord | { readonly failed: string };

/** `.lab/state/review-<head>-answers.json`: the Author's answer to each Important, by its 1-based number. */
const LocalReviewAnswers = Schema.Record(Schema.String, Schema.String);

export type LocalReviewAnswers = typeof LocalReviewAnswers.Type;

// On-disk names under `.lab/state/`: existing records carry them, so they stay.
export const reviewRecordName = (head: string): string => `review-${head}.json`;

export const answersRecordName = (head: string): string => `review-${head}-answers.json`;

/** The numbers of the Importants the last block on that head showed open, which the hook writes when it blocks. */
export const shownRecordName = (head: string): string => `review-${head}-shown.json`;

const ShownNumbers = Schema.Array(Schema.Int);

export function localReviewOf(source: string, json: string): LocalReviewRecord {
  return decodeJson(LocalReviewRecord, source, json);
}

export function answersOf(source: string, json: string): LocalReviewAnswers {
  return decodeJson(LocalReviewAnswers, source, json);
}

export function shownOf(source: string, json: string): readonly number[] {
  return decodeJson(ShownNumbers, source, json);
}

/** The Importants of `review`, each with its 1-based number, the one the block text and `local-review.ts` name. */
function importantsOf(review: LocalReviewRecord): Array<{ readonly n: number; readonly finding: LocalFinding }> {
  return review.findings
    .filter((found) => found.severity === "important")
    .map((found, index) => ({ n: index + 1, finding: found }));
}

const placeOf = (found: LocalFinding): string => (found.line === null ? found.file : `${found.file}:${found.line}`);

const unanswered = (review: LocalReviewRecord, answers: LocalReviewAnswers): ReturnType<typeof importantsOf> =>
  importantsOf(review).filter(({ n }) => answers[String(n)] === undefined);

/** The numbers of the Importants of `review` without an answer, in order: what a block shows. */
export function unansweredNumbersOf(review: LocalReviewRecord, answers: LocalReviewAnswers): number[] {
  return unanswered(review, answers).map(({ n }) => n);
}

/** The Nits of `review`, one line each, as the hook logs them. */
export function nitLinesOf(review: LocalReviewRecord): string[] {
  return review.findings
    .filter((found) => found.severity === "nit")
    .map((found) => `${placeOf(found)}: ${found.summary}`);
}

/** What the hook tells the Author when the local review left an Important without an answer; `rejectCommand` runs `local-review.ts`. */
export function localReviewReason(
  review: LocalReviewRecord,
  answers: LocalReviewAnswers,
  rejectCommand: string,
): string {
  const open = unanswered(review, answers);
  const nits = nitLinesOf(review).length;

  return [
    `The local review found ${open.length} Important finding(s) on this head without an answer, so nothing was published:`,
    "",
    ...open.flatMap(({ n, finding: found }) => [
      `${n}. ${placeOf(found)}: ${found.summary}`,
      `   ${found.failureScenario}`,
    ]),
    "",
    `Fix a finding with a commit, or reject it: ${rejectCommand} reject <n> "<reason>". Then stop. A Nit never blocks: ${nits === 1 ? "1 Nit is" : `${nits} Nits are`} in .lab/stop.log.`,
  ].join("\n");
}

const LOCAL_REVIEW_ERROR_MAX = 200;

/** What the stop knows around a head's local review. */
export interface LocalReviewContext {
  /** Claude Code's `stop_hook_active`: this stop follows a block of this hook. */
  readonly stopHookActive: boolean;
  /** The numbers of the Importants the last block on this head showed open; null when no block showed this head's review. */
  readonly shown: readonly number[] | null;
  /** The command that runs `local-review.ts`. */
  readonly rejectCommand: string;
}

/**
 * A local review with every Important answered publishes. An open one blocks; a stop right after a
 * block lets the session end only when the Author answered none of what that block showed, so a fresh
 * review, or a new answer, always blocks again with what is left. A failed session blocks once, then
 * lets the session end.
 */
export function afterLocalReview(review: LocalReview, answers: LocalReviewAnswers, context: LocalReviewContext): Next {
  if ("failed" in review) {
    return context.stopHookActive
      ? none("the local review is still red after a block: nothing is published")
      : {
          kind: "block",
          reason: `The local review could not run (${review.failed.slice(0, LOCAL_REVIEW_ERROR_MAX)}), so nothing was published. Stop again to retry; ask no question.`,
        };
  }

  const open = unansweredNumbersOf(review, answers);

  if (open.length === 0) {
    return { kind: "publish" };
  }

  const unchanged = context.shown !== null && open.join(",") === context.shown.join(",");

  if (context.stopHookActive && unchanged) {
    return none("the local review is still red after a block: nothing is published");
  }

  return { kind: "block", reason: localReviewReason(review, answers, context.rejectCommand) };
}

/** The arguments of `local-review.ts reject <n> "<reason>"`, or null unless `<n>` names an Important of `review` and the reason is not blank. */
export function rejectArgsOf(
  argv: readonly string[],
  review: LocalReviewRecord,
): { readonly n: number; readonly reason: string } | null {
  const [verb, number, reason] = argv;

  if (verb !== "reject" || !/^\d+$/u.test(number ?? "") || reason === undefined || reason.trim() === "") {
    return null;
  }

  const n = Number(number);

  return n >= 1 && n <= importantsOf(review).length ? { n, reason } : null;
}

/** One reviewed head of the branch, in commit order; `nextHead` is the commit after it on the branch, null for the last. */
export interface ReviewedHead {
  readonly head: string;
  readonly review: LocalReview;
  readonly answers: LocalReviewAnswers;
  readonly nextHead: string | null;
}

/** The block's markers. An external format: PR bodies carry them, and the review job reads them back. */
export const LOCAL_REVIEW_OPEN = "<!-- lab-local-review -->";

export const LOCAL_REVIEW_CLOSE = "<!-- /lab-local-review -->";

const reviewedOf = (reviews: readonly ReviewedHead[]): Array<ReviewedHead & { readonly review: LocalReviewRecord }> =>
  reviews.flatMap((entry) => ("failed" in entry.review ? [] : [{ ...entry, review: entry.review }]));

/** `text` on one line with no comment delimiter, so an entry can never open or close the block. */
const oneLine = (text: string): string =>
  text.replaceAll("<!--", "").replaceAll("-->", "").replaceAll(/\s+/gu, " ").trim();

/** An answered Important of a reviewed head, as an earlier finding; `rejected` tells a rejection from a fix. */
export type AnsweredImportant = EarlierThread & { readonly rejected: boolean };

/**
 * The Importants of the reviewed heads that have an answer, each on one line: the Author's rejection,
 * or a fix by the commit after its head. An Important of the last head with no rejection has none.
 */
export function answeredImportantsOf(reviews: readonly ReviewedHead[]): AnsweredImportant[] {
  return reviewedOf(reviews).flatMap(({ review, answers, nextHead }) =>
    importantsOf(review).flatMap(({ n, finding: found }) => {
      const rejection = answers[String(n)];
      const answer = rejection ?? (nextHead === null ? null : `Fixed in ${nextHead.slice(0, 7)}`);

      return answer === null
        ? []
        : [
            {
              where: oneLine(placeOf(found)),
              finding: oneLine(found.summary),
              reply: oneLine(answer),
              rejected: rejection !== undefined,
            },
          ];
    }),
  );
}

/** The PR body's block of the local reviews of the branch's heads, with the Author's answers; null when no head has one. */
export function localReviewBlockOf(reviews: readonly ReviewedHead[]): string | null {
  const latest = reviewedOf(reviews).at(-1);

  if (latest === undefined) {
    return null;
  }

  const entries = answeredImportantsOf(reviews);
  const rejected = entries.filter((entry) => entry.rejected).length;

  return [
    LOCAL_REVIEW_OPEN,
    `Local review (deep, ${latest.head.slice(0, 7)}): ${entries.length - rejected} Important fixed, ${rejected} rejected, ${nitLinesOf(latest.review).length} Nit.`,
    "<details><summary>Findings</summary>",
    "",
    ...entries.map((entry) => `- ${entry.where}: ${entry.finding} | Author: ${entry.reply}`),
    "</details>",
    LOCAL_REVIEW_CLOSE,
  ].join("\n");
}

/** The closing line `closingLineOf` writes. */
const CLOSING_LINE = /^Closes #\d+$/u;

/** `body` with `block` in place of its block, or before its closing line, or at its end. */
export function bodyWithBlock(body: string, block: string): string {
  const open = body.indexOf(LOCAL_REVIEW_OPEN);
  const close = body.indexOf(LOCAL_REVIEW_CLOSE, open);

  if (open !== -1 && close !== -1) {
    return `${body.slice(0, open)}${block}${body.slice(close + LOCAL_REVIEW_CLOSE.length)}`;
  }

  const lines = body.trimEnd().split("\n");
  const last = lines.at(-1) ?? "";

  const [before, after] = CLOSING_LINE.test(last)
    ? [lines.slice(0, -1).join("\n").trimEnd(), last]
    : [body.trimEnd(), ""];

  return [before, block, after].filter((part) => part !== "").join("\n\n");
}
