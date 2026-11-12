/**
 * The App's findings as GitHub holds them. Each posted finding carries a marker that names its
 * severity, read back to count the open Important threads and by the relay of the Author's PR. A pull
 * request's review threads come from one GraphQL query: the Merge bot counts them and keeps their
 * ledger, and the review job gives Review rounds 2 and 3 the earlier findings with the author's answers,
 * and the Delta read the open Importants.
 */

import { Option, Schema } from "effect";

import { DELTA_READ, LANDED_OPEN_MARKER } from "../../contract.ts";
import { codeSpan, unescapeHtml } from "../../lib/markdown.ts";
import { AUTHOR_MARK, REJECT_MARK } from "./author-mark.ts";
import type { ImportantThread, LedgerFinding } from "./finding.ts";
import { Severity } from "./finding.ts";

/** The marker a finding's comment carries. An external name: posted findings carry it, so the string stays. */
const FINDING_MARKER = "lab-finding";

const FINDING_MARKER_PATTERN = new RegExp(`<!-- ${FINDING_MARKER} severity=(\\w+) -->`, "u");

/** The hidden marker a finding's comment ends with. */
export function markerOf(severity: Severity): string {
  return `<!-- ${FINDING_MARKER} severity=${severity} -->`;
}

const decodeSeverity = Schema.decodeUnknownOption(Severity);

/** The severity a comment's marker names; null for a comment with no marker, such as a human's. */
export function severityOfBody(body: string): Severity | null {
  return Option.getOrNull(decodeSeverity(FINDING_MARKER_PATTERN.exec(body)?.[1]));
}

const Login = Schema.Struct({ login: Schema.String });

const ReviewThread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  /** GitHub marks the thread outdated once the lines it is anchored on changed. */
  isOutdated: Schema.Boolean,
  /** Who resolved the thread, the App with REST's `[bot]` suffix; null while it is open. */
  resolvedBy: Schema.NullOr(Login),
  path: Schema.String,
  line: Schema.NullOr(Schema.Finite),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        author: Schema.NullOr(Login),
        body: Schema.String,
        url: Schema.String,
        /** The review the comment was posted in: an App finding's carries its round's marker. */
        pullRequestReview: Schema.optionalKey(Schema.NullOr(Schema.Struct({ body: Schema.String }))),
      }),
    ),
  }),
});

/** A review thread: its first comment is the finding, the others its replies. */
export type ReviewThread = typeof ReviewThread.Type;

/** The answer of the query `threadsQueryOf` gives. */
export const ReviewThreads = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({ reviewThreads: Schema.Struct({ nodes: Schema.Array(ReviewThread) }) }),
    }),
  }),
});

/** The GraphQL query of the review threads of PR `pr`, over the variables `owner` and `name`. */
export function threadsQueryOf(pr: number): string {
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved isOutdated resolvedBy{login} path line comments(first:20){nodes{author{login} body url pullRequestReview{body}}}}}}}}`;
}

/** The App's login as GraphQL prints it, without REST's `[bot]` suffix. */
export function graphqlLogin(login: string): string {
  return login.replace(/\[bot\]$/u, "");
}

/**
 * The App's unresolved threads whose finding is Important, each with the patch and round of the review
 * that posted it. `appLogin` is the App's login as GraphQL prints it.
 */
export function openImportantOf(appLogin: string, threads: readonly ReviewThread[]): ImportantThread[] {
  return threads.flatMap((thread) => {
    const [finding] = thread.comments.nodes;

    return !thread.isResolved && finding?.author?.login === appLogin && severityOfBody(finding.body) === "important"
      ? [{ thread: thread.id, review: reviewOfBody(finding.pullRequestReview?.body ?? "") }]
      : [];
  });
}

/** An open finding of the App: its thread, where it sits, its severity and its first line without the severity's label. */
export interface OpenFinding {
  readonly thread: string;
  readonly path: string;
  readonly line: number | null;
  readonly severity: "important" | "nit";
  readonly summary: string;
}

const SEVERITY_LABEL = /^\*\*[^*]+\*\*: /u;

/** The App's unresolved Important and Nit threads. `appLogin` is the App's login as GraphQL prints it. */
export function openFindingsOf(appLogin: string, threads: readonly ReviewThread[]): OpenFinding[] {
  return threads.flatMap((thread) => {
    const [finding] = thread.comments.nodes;
    const severity = finding?.author?.login === appLogin ? severityOfBody(finding.body) : null;

    if (thread.isResolved || finding === undefined || (severity !== "important" && severity !== "nit")) {
      return [];
    }

    const summary = unescapeHtml(finding.body.split("\n")[0] ?? "").replace(SEVERITY_LABEL, "");

    return [{ thread: thread.id, path: thread.path, line: thread.line, severity, summary }];
  });
}

/**
 * The logins whose words the Land loop reads in a review thread: the App's findings, and the answers of
 * the Author's machine account and of the Owner. `app` is the App's login as GraphQL prints it.
 */
export interface ThreadLogins {
  readonly app: string;
  readonly author: string;
  readonly owner: string;
}

/**
 * The answers in `thread`: the replies of the Author's machine account and of the Owner. The lab is
 * public: another login's reply is no answer, and reaches neither a count nor a reviewer's prompt.
 */
function answersOf(logins: ThreadLogins, thread: ReviewThread): ReviewThread["comments"]["nodes"] {
  return thread.comments.nodes
    .slice(1)
    .filter((reply) => reply.author?.login === logins.author || reply.author?.login === logins.owner);
}

/** A resolved thread whose latest answer carries `REJECT_MARK`; a thread unresolved again is open, never rejected. */
function rejectedOf(logins: ThreadLogins, thread: ReviewThread): boolean {
  return thread.isResolved && answersOf(logins, thread).at(-1)?.body.includes(REJECT_MARK) === true;
}

/** The App's Important threads the author rejected. */
export function rejectedImportantOf(logins: ThreadLogins, threads: readonly ReviewThread[]): number {
  return threads.filter((thread) => {
    const [finding] = thread.comments.nodes;

    return (
      finding?.author?.login === logins.app &&
      severityOfBody(finding.body) === "important" &&
      rejectedOf(logins, thread)
    );
  }).length;
}

/**
 * The marker a posted review ends with: it names the review's patch and round. An external name: posted
 * reviews carry it, so the string stays. A pattern that reads it back puts a group in place of a value.
 */
export function reviewMarkerOf(review: { readonly patch: string; readonly round: number }): string {
  return `<!-- lab-review patch=${review.patch} round=${review.round} -->`;
}

const REVIEW_MARKER_PATTERN = /<!-- lab-review patch=(\S+) round=(\d+) -->/u;

/** The patch and Review round a posted review's body names; null for a body with no marker, such as a human's. */
export function reviewOfBody(body: string): { readonly patch: string; readonly round: number } | null {
  const [, patch, round] = REVIEW_MARKER_PATTERN.exec(body) ?? [];

  return patch === undefined || round === undefined ? null : { patch, round: Number(round) };
}

/**
 * The line a finding's comment carries when it anchors away from its own place, `<file>` or
 * `<file>:<line>`. An external format: posted comments carry it, so the words stay.
 */
export function movedLineOf(place: string): string {
  return `At ${codeSpan(place)}, outside this diff.`;
}

/** The moved line, its fence the whole first backtick run, so a long run cannot make the match backtrack. */
const MOVED_LINE_PATTERN = /^At (?<fence>`+)(?!`)(?<rest>.*), outside this diff\.$/mu;

/** The place `movedLineOf` wrote in `body`, without its line number; null when no moved line closes its fence. */
function movedPlaceOf(body: string): string | null {
  const { fence = "", rest = "" } = MOVED_LINE_PATTERN.exec(body)?.groups ?? {};

  if (fence === "" || !rest.endsWith(fence)) {
    return null;
  }

  const place = rest.slice(0, -fence.length);
  const unpadded = place.startsWith(" ") && place.endsWith(" ") && place.length > 1 ? place.slice(1, -1) : place;

  return unpadded.replace(/:\d+$/u, "");
}

/** The file a finding's comment is about: the one its moved line names, else `anchorPath`, the file it sits on. */
export function findingFileOf(anchorPath: string, body: string): string {
  return movedPlaceOf(body) ?? anchorPath;
}

/**
 * The files of the Nit threads the App posted in the review of `review`'s patch and round, open or
 * resolved, sorted, once each. A Nit anchored on another file than its own, outside the diff, names
 * neither. `appLogin` is the App's login as GraphQL prints it.
 */
export function nitPathsOf(
  appLogin: string,
  review: { readonly patch: string | null; readonly round: number },
  threads: readonly ReviewThread[],
): string[] {
  const paths = threads.flatMap((thread) => {
    const [finding] = thread.comments.nodes;
    const posted = reviewOfBody(finding?.pullRequestReview?.body ?? "");

    const ofReview = posted !== null && posted.patch === review.patch && posted.round === review.round;
    const nit = finding?.author?.login === appLogin && severityOfBody(finding.body) === "nit";

    return ofReview && nit && findingFileOf(thread.path, finding.body) === thread.path ? [thread.path] : [];
  });

  return [...new Set(paths)].toSorted();
}

const EarlierThread = Schema.Struct({
  thread: Schema.String,
  where: Schema.String,
  finding: Schema.String,
  reply: Schema.String,
});

/** A thread of an earlier round: its id, where its finding sits, the finding's first line, and the answers of the Author and of the Owner, each under its login, with the thread's state. */
export type EarlierThread = typeof EarlierThread.Type;

/** `review-threads.json`, which the review job's thread step writes and its runner reads. */
export const EarlierThreads = Schema.Array(EarlierThread);

/** An author's answer without the marks the Stop hook appends. */
function unmarked(body: string): string {
  return body.replaceAll(`\n\n${REJECT_MARK}`, "").replaceAll(`\n\n${AUTHOR_MARK}`, "");
}

/**
 * The App's findings, open or resolved, each with the answers of the Author's machine account and of
 * the Owner, each under its login, and whether its thread is resolved: a later Review round reports again
 * each Important that is still wrong, and no finding the author rejected with a valid reason. No other
 * login's reply reaches the round: what it leaves out, the Merge bot closes.
 */
export function earlierThreadsOf(logins: ThreadLogins, threads: readonly ReviewThread[]): EarlierThread[] {
  return threads.flatMap((thread) => {
    const [finding] = thread.comments.nodes;

    if (finding?.author?.login !== logins.app) {
      return [];
    }

    const answers = answersOf(logins, thread).map((reply) => {
      const text = reply.body.includes(AUTHOR_MARK) ? unescapeHtml(unmarked(reply.body)) : unmarked(reply.body);

      // A code span on one line, its fence longer than any backtick run the answer holds: the answer reads as written, and cannot close its span to pass for another login's answer or another finding's line.
      return `${reply.author?.login}: ${codeSpan(text)}`;
    });

    const state = rejectedOf(logins, thread)
      ? "resolved: rejected by the Author"
      : thread.isResolved
        ? "resolved"
        : "open";

    return [
      {
        thread: thread.id,
        where: `${thread.path}:${thread.line ?? "?"}`,
        finding: unescapeHtml(finding.body.split("\n")[0] ?? ""),
        reply: `${answers.length === 0 ? "no answer" : answers.join(" / ")} (thread ${state})`,
      },
    ];
  });
}

/**
 * The earlier findings the review of `round` is shown, as `earlierThreadsOf` writes them: on the Delta
 * read, the App's open Importants alone, whose fix it confirms, since it posts no Nit; on a Review round,
 * every finding of the App.
 */
export function shownThreadsOf(logins: ThreadLogins, round: number, threads: readonly ReviewThread[]): EarlierThread[] {
  if (round !== DELTA_READ) {
    return earlierThreadsOf(logins, threads);
  }

  const open = new Set(openImportantOf(logins.app, threads).map((found) => found.thread));

  return earlierThreadsOf(
    logins,
    threads.filter((thread) => open.has(thread.id)),
  );
}

/** Whether the App replied in `thread` that the Owner's Land approval lands its finding open. */
const landedOpenIn = (appLogin: string, thread: ReviewThread): boolean =>
  thread.comments.nodes
    .slice(1)
    .some((reply) => reply.author?.login === appLogin && reply.body.includes(LANDED_OPEN_MARKER));

/**
 * The threads of `ids` in which the App has not yet replied that the Owner's Land approval lands their
 * finding open, so a run that retries the landing replies once. `appLogin` is the App's login as GraphQL
 * prints it, since any login can write the marker.
 */
export function unnotedOf(appLogin: string, ids: readonly string[], threads: readonly ReviewThread[]): string[] {
  return ids.filter((id) => !threads.some((thread) => thread.id === id && landedOpenIn(appLogin, thread)));
}

const SECURITY_LABEL = /^\*\*[^*]+ \(security\)\*\*: /u;

/**
 * The App's Important and Nit findings of a review that names its round, each as the ledger reads its
 * thread: where its comment is and the file it is about, its severity and pass, its first line without
 * the label, its round, the thread's state, whether the App resolved it and whether it replied there that
 * the Owner's Land approval lands it open, the Author's rejection reply when the thread is resolved with
 * it as its latest answer, the Owner's reply when it is the latest answer, written by hand, and the later
 * reads that report it again there. `logins.app` is the App's login as GraphQL prints it.
 */
export function ledgerFindingsOf(logins: ThreadLogins, threads: readonly ReviewThread[]): LedgerFinding[] {
  return threads.flatMap((thread) => {
    const [finding, ...replies] = thread.comments.nodes;
    const severity = finding?.author?.login === logins.app ? severityOfBody(finding.body) : null;
    const posted = reviewOfBody(finding?.pullRequestReview?.body ?? "");

    if (finding === undefined || (severity !== "important" && severity !== "nit") || posted === null) {
      return [];
    }

    const first = unescapeHtml(finding.body.split("\n")[0] ?? "");

    const again = replies.flatMap((reply) => {
      const review = reply.author?.login === logins.app ? reviewOfBody(reply.body) : null;

      return review === null ? [] : [review.round];
    });

    const latest = answersOf(logins, thread).at(-1);
    const ownerWords = latest?.author?.login === logins.owner && !latest.body.includes(AUTHOR_MARK);

    return [
      {
        thread: thread.id,
        url: finding.url,
        where: thread.line === null ? thread.path : `${thread.path}:${thread.line}`,
        file: findingFileOf(thread.path, finding.body),
        severity,
        security: SECURITY_LABEL.test(first),
        summary: first.replace(SEVERITY_LABEL, ""),
        round: posted.round,
        resolved: thread.isResolved,
        closedByApp:
          thread.isResolved && thread.resolvedBy !== null && graphqlLogin(thread.resolvedBy.login) === logins.app,
        landedOpen: landedOpenIn(logins.app, thread),
        outdated: thread.isOutdated,
        rejection: rejectedOf(logins, thread) ? (latest?.url ?? null) : null,
        ownerAnswer: ownerWords ? latest.url : null,
        again,
      },
    ];
  });
}
