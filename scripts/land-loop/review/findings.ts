/**
 * The App's findings as GitHub holds them. Each posted finding carries a marker that names its
 * severity, read back to count the open Important threads and by the author's PR watch. A pull
 * request's review threads come from one GraphQL query: the Merge bot counts them, and the review job
 * gives Review round 2 the earlier findings with the author's answers.
 */

import { Option, Schema } from "effect";

import { Severity } from "./review-report.ts";

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
  path: Schema.String,
  line: Schema.NullOr(Schema.Finite),
  comments: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        author: Schema.NullOr(Login),
        body: Schema.String,
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
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{author{login} body pullRequestReview{body}}}}}}}}`;
}

/** The App's login as GraphQL prints it, without REST's `[bot]` suffix. */
export function graphqlLogin(login: string): string {
  return login.replace(/\[bot\]$/u, "");
}

/** The App's unresolved threads whose finding is Important. `appLogin` is the App's login as GraphQL prints it. */
export function openImportantOf(appLogin: string, threads: readonly ReviewThread[]): number {
  return threads.filter((thread) => {
    const [finding] = thread.comments.nodes;

    return !thread.isResolved && finding?.author?.login === appLogin && severityOfBody(finding.body) === "important";
  }).length;
}

/** The marker a posted review ends with, as `post-plan.ts` `reviewMarkerOf` writes it: it names the review's round. */
const REVIEW_MARKER_PATTERN = /<!-- lab-review patch=\S+ round=(\d+) -->/u;

/** The Review round a posted review's body names; null for a body with no marker, such as a human's. */
export function roundOfReviewBody(body: string): number | null {
  const round = REVIEW_MARKER_PATTERN.exec(body)?.[1];

  return round === undefined ? null : Number(round);
}

/**
 * The files of the Nit threads the App posted in Review round `round`, open or resolved, sorted, once
 * each. `appLogin` is the App's login as GraphQL prints it.
 */
export function nitPathsOf(appLogin: string, round: number, threads: readonly ReviewThread[]): string[] {
  const paths = threads.flatMap((thread) => {
    const [finding] = thread.comments.nodes;
    const posted = roundOfReviewBody(finding?.pullRequestReview?.body ?? "") === round;

    return posted && finding?.author?.login === appLogin && severityOfBody(finding.body) === "nit" ? [thread.path] : [];
  });

  return [...new Set(paths)].toSorted();
}

const EarlierThread = Schema.Struct({ where: Schema.String, finding: Schema.String, reply: Schema.String });

/** A thread of an earlier round: where its finding sits, the finding's first line, and the author's answers with the thread's state. */
export type EarlierThread = typeof EarlierThread.Type;

/** `review-threads.json`, which the review job's thread step writes and its runner reads. */
export const EarlierThreads = Schema.Array(EarlierThread);

/**
 * The App's findings, open or resolved, each with the author's answers and whether its thread is
 * resolved: Review round 2 reports again neither a finding the author resolved with a valid reason
 * nor one still open. `appLogin` is the App's login as GraphQL prints it.
 */
export function earlierThreadsOf(appLogin: string, threads: readonly ReviewThread[]): EarlierThread[] {
  return threads.flatMap((thread) => {
    const [finding, ...replies] = thread.comments.nodes;

    if (finding?.author?.login !== appLogin) {
      return [];
    }

    const answers = replies.filter((reply) => reply.author?.login !== appLogin).map((reply) => reply.body);

    return [
      {
        where: `${thread.path}:${thread.line ?? "?"}`,
        finding: finding.body.split("\n")[0] ?? "",
        reply: `${answers.length === 0 ? "no answer" : answers.join(" / ")} (thread ${thread.isResolved ? "resolved" : "open"})`,
      },
    ];
  });
}
