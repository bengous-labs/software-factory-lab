/**
 * The App's findings as GitHub holds them. Each posted finding carries a marker that names its
 * severity, read back to count the open Important threads and by the author's PR watch. A pull
 * request's review threads come from one GraphQL query: the Merge bot counts them, and the review job
 * gives every Review round the earlier findings with the author's answers, the local review's included.
 */

import { Option, Schema } from "effect";

import { codeSpan, unescapeHtml } from "../../lib/markdown.ts";
import { AUTHOR_MARK, REJECT_MARK } from "../author-mark.ts";
import { LOCAL_REVIEW_CLOSE, LOCAL_REVIEW_OPEN } from "../stop/decide.ts";
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

/** The replies of `thread` another login than the App's posted, the author's answers. */
function answersOf(appLogin: string, thread: ReviewThread): ReviewThread["comments"]["nodes"] {
  return thread.comments.nodes.slice(1).filter((reply) => reply.author?.login !== appLogin);
}

/** A resolved thread whose latest answer carries `REJECT_MARK`; a thread unresolved again is open, never rejected. */
function rejectedOf(appLogin: string, thread: ReviewThread): boolean {
  return thread.isResolved && answersOf(appLogin, thread).at(-1)?.body.includes(REJECT_MARK) === true;
}

/** The App's Important threads the author rejected. `appLogin` is the App's login as GraphQL prints it. */
export function rejectedImportantOf(appLogin: string, threads: readonly ReviewThread[]): number {
  return threads.filter((thread) => {
    const [finding] = thread.comments.nodes;

    return (
      finding?.author?.login === appLogin &&
      severityOfBody(finding.body) === "important" &&
      rejectedOf(appLogin, thread)
    );
  }).length;
}

/** The marker a posted review ends with, as `post-plan.ts` `reviewMarkerOf` writes it: it names the review's patch and round. */
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

const MOVED_LINE_PATTERN = /^At (?<fence>`+) ?(.+?)(?::\d+)? ?\k<fence>, outside this diff\.$/mu;

/** The file a finding's comment is about: the one its moved line names, else `anchorPath`, the file it sits on. */
export function findingFileOf(anchorPath: string, body: string): string {
  return MOVED_LINE_PATTERN.exec(body)?.[2] ?? anchorPath;
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

const EarlierThread = Schema.Struct({ where: Schema.String, finding: Schema.String, reply: Schema.String });

/** A thread of an earlier round: where its finding sits, the finding's first line, and the author's answers with the thread's state. */
export type EarlierThread = typeof EarlierThread.Type;

/** `review-threads.json`, which the review job's thread step writes and its runner reads. */
export const EarlierThreads = Schema.Array(EarlierThread);

/** An author's answer without the marks `thread.ts` appends. */
function unmarked(body: string): string {
  return body.replaceAll(`\n\n${REJECT_MARK}`, "").replaceAll(`\n\n${AUTHOR_MARK}`, "");
}

/**
 * The App's findings, open or resolved, each with the author's answers and whether its thread is
 * resolved: a later Review round reports again neither a finding the author resolved with a valid reason
 * nor one still open. `appLogin` is the App's login as GraphQL prints it.
 */
export function earlierThreadsOf(appLogin: string, threads: readonly ReviewThread[]): EarlierThread[] {
  return threads.flatMap((thread) => {
    const [finding] = thread.comments.nodes;

    if (finding?.author?.login !== appLogin) {
      return [];
    }

    const answers = answersOf(appLogin, thread).map((reply) =>
      reply.body.includes(AUTHOR_MARK) ? unescapeHtml(unmarked(reply.body)) : unmarked(reply.body),
    );

    const state = rejectedOf(appLogin, thread)
      ? "resolved: rejected by the Author"
      : thread.isResolved
        ? "resolved"
        : "open";

    return [
      {
        where: `${thread.path}:${thread.line ?? "?"}`,
        finding: unescapeHtml(finding.body.split("\n")[0] ?? ""),
        reply: `${answers.length === 0 ? "no answer" : answers.join(" / ")} (thread ${state})`,
      },
    ];
  });
}

/** One entry of the block, `- <file>[:<line>]: <summary> | Author: <answer>`, as the Stop hook writes it. */
const LOCAL_ENTRY = /^- (.+?): (.+?) \| Author: (.*)$/u;

/** The entries of the local review block the Stop hook wrote in the PR body, as earlier findings; none without a block. */
export function localReviewEntriesOf(body: string): EarlierThread[] {
  const open = body.indexOf(LOCAL_REVIEW_OPEN);
  const close = body.indexOf(LOCAL_REVIEW_CLOSE, open);

  if (open === -1 || close === -1) {
    return [];
  }

  return body
    .slice(open, close)
    .split("\n")
    .flatMap((line) => {
      const [, where, finding, reply] = LOCAL_ENTRY.exec(line.trimEnd()) ?? [];

      return where === undefined || finding === undefined || reply === undefined
        ? []
        : [
            {
              where: unescapeHtml(where),
              finding: unescapeHtml(finding),
              reply: `${unescapeHtml(reply)} (local review)`,
            },
          ];
    });
}

/** What the review job's thread step gives the review: the local review's entries of `body`, then the App's threads. */
export function earlierFindingsOf(appLogin: string, threads: readonly ReviewThread[], body: string): EarlierThread[] {
  return [...localReviewEntriesOf(body), ...earlierThreadsOf(appLogin, threads)];
}
