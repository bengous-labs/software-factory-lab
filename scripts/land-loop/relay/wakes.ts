/**
 * The Wakes of a pull request, as pure functions over one reading of it: a failing check on its head, a
 * new open Important or Nit finding of the App, an Important a later round reports again, a new comment
 * of the Owner in an open thread or in the conversation, the PR back in draft, the PR landed or closed.
 * The App's own Pre-existing findings and its conversation comments (state record, verdicts) make no
 * Wake; nor do the replies the Stop hook posts for the Author; nor does any other login's comment: the
 * lab is public, and a Wake starts a turn in a session that holds the Author's token. Each Wake has a
 * key, so the relay delivers it once.
 */

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { unescapeHtml } from "../../lib/markdown.ts";
import { AUTHOR_MARK } from "../author-mark.ts";
import { APP_LOGIN, OWNER_LOGIN } from "../logins.ts";
import { severityOfBody } from "../review/findings.ts";

/** One check as `gh pr checks --json name,bucket,link` prints it. */
const Check = Schema.Struct({ name: Schema.String, bucket: Schema.String, link: Schema.String });

type Check = typeof Check.Type;

interface Comment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

/** One conversation comment as the relay's `--jq` filter prints it; a deleted user's has a null author. */
const ConversationComment = Schema.Struct({
  id: Schema.String,
  author: Schema.NullOr(Schema.String),
  body: Schema.String,
});

interface Thread {
  readonly id: string;
  readonly resolved: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
  /** The comments after the first one. */
  readonly replies: readonly Comment[];
}

export interface PrState {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly draft: boolean;
  readonly head: string;
  readonly checks: readonly Check[];
  readonly threads: readonly Thread[];
  /** The PR's conversation comments. */
  readonly comments: readonly Comment[];
}

export interface Wake {
  readonly key: string;
  readonly line: string;
  /** Set on the Owner's own words alone: they reach a running session as a turn of its user, not as a peer's message. */
  readonly owner?: true;
}

/** The key that keeps the end line from being delivered twice. */
export const END_KEY = "end";

/** `body` on one line, cut at `max` characters. */
const flatTo = (body: string, max: number): string => body.replaceAll(/\s+/gu, " ").slice(0, max);

const flat = (body: string): string => flatTo(body, 400);

/** The most characters of a reply that reports an Important again: it may hold the finding of each pass of its round. */
const AGAIN_MAX = 3000;

/** The end line of a landed or closed PR; null while it is open. */
export function endOf(pr: number, state: PrState): string | null {
  if (state.state === "MERGED") {
    return `PR #${pr} landed.`;
  }

  if (state.state === "CLOSED") {
    return `PR #${pr} closed.`;
  }

  return null;
}

/**
 * Whether the Owner wrote these words by hand. The lab is public and any GitHub login can comment on a
 * pull request: of a person's words, the relay delivers the Owner's alone, never another login's, which
 * would reach the Author's session as a turn to act on.
 */
const byOwner = (found: Pick<Comment, "author" | "body">): boolean =>
  found.author === OWNER_LOGIN && !found.body.includes(AUTHOR_MARK);

/** The Wake of an open thread's first comment: the App's Important or Nit finding, or the Owner's comment. */
function threadWakesOf(thread: Thread, where: string): readonly Wake[] {
  const key = `thread:${thread.id}`;

  if (thread.author === APP_LOGIN) {
    const severity = severityOfBody(thread.body);
    const kind = severity === null ? "Comment" : "Finding";
    const line = `${kind} ${thread.id} on ${where} by ${thread.author}: ${flat(unescapeHtml(thread.body))}`;

    return severity === "pre_existing" ? [] : [{ key, line }];
  }

  return byOwner(thread)
    ? [{ key, line: `Comment ${thread.id} on ${where} by ${thread.author}: ${flat(thread.body)}`, owner: true }]
    : [];
}

/**
 * The Wake of a reply in an open thread: the Owner's reply, or the App's when a later Review round
 * reports the thread's Important again, which it posts there with what is still wrong.
 */
function replyWakesOf(thread: Thread, where: string, reply: Comment): readonly Wake[] {
  const key = `comment:${reply.id}`;

  if (reply.author === APP_LOGIN) {
    const again = thread.author === APP_LOGIN && severityOfBody(reply.body) === "important";
    const line = `Finding ${thread.id} on ${where} by ${reply.author}, still wrong: ${flatTo(unescapeHtml(reply.body), AGAIN_MAX)}`;

    return again ? [{ key, line }] : [];
  }

  return byOwner(reply)
    ? [{ key, line: `Reply in ${thread.id} on ${where} by ${reply.author}: ${flat(reply.body)}`, owner: true }]
    : [];
}

/** The Wakes of one reading of an open PR, each with the key that keeps it from being delivered twice. */
export function wakesOf(pr: number, state: PrState): readonly Wake[] {
  const short = state.head.slice(0, 7);

  if (state.state !== "OPEN") {
    return [];
  }

  const wakes: Wake[] = state.checks
    .filter((check) => check.bucket === "fail")
    .map((check) => ({
      key: `check:${check.name}:${state.head}`,
      line: `Check ${check.name} failed on ${short}: ${check.link}`,
    }));

  for (const thread of state.threads.filter((found) => !found.resolved)) {
    const where = thread.line === null ? thread.path : `${thread.path}:${thread.line}`;

    wakes.push(
      ...threadWakesOf(thread, where),
      ...thread.replies.flatMap((reply) => replyWakesOf(thread, where, reply)),
    );
  }

  for (const comment of state.comments.filter((found) => byOwner(found))) {
    wakes.push({
      key: `comment:${comment.id}`,
      line: `Comment on PR #${pr} by ${comment.author}: ${flat(comment.body)}`,
      owner: true,
    });
  }

  if (state.draft) {
    wakes.push({
      key: `draft:${state.head}`,
      line: `PR #${pr} is back in draft at ${short}: it lands only after your next stop.`,
    });
  }

  return wakes;
}

/**
 * What one reading delivers, each Wake `seen` does not hold yet, and whether the relay ends. A landed
 * or closed PR ends it at once, even when its end line was delivered before.
 */
export interface Reading {
  readonly wakes: readonly Wake[];
  readonly ends: boolean;
}

export function readingOf(pr: number, state: PrState, seen: ReadonlySet<string>): Reading {
  const end = endOf(pr, state);
  const wakes = end === null ? wakesOf(pr, state) : [{ key: END_KEY, line: end }];

  return { wakes: wakes.filter((wake) => !seen.has(wake.key)), ends: end !== null };
}

/** Whether a Wake the reading delivers holds the Owner's words. */
export const ownerWordsIn = (reading: Reading): boolean => reading.wakes.some((wake) => wake.owner === true);

/**
 * The text of the turn a reading's Wakes start in the Author's session: the Wakes' lines, and, while the
 * PR is open, how the Author answers.
 */
export function wakeTextOf(pr: number, reading: Reading): string {
  return [
    `The Land loop, about your pull request #${pr}:`,
    ...reading.wakes.map((wake) => wake.line),
    ...(reading.ends
      ? []
      : ["Fix what you accept with a commit, say in your last message which findings you reject and why, then stop."]),
  ].join("\n");
}

const PrView = Schema.Struct({
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  isDraft: Schema.Boolean,
  headRefOid: Schema.String,
});

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const ReviewThreads = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        reviewThreads: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              isResolved: Schema.Boolean,
              path: Schema.String,
              line: Schema.NullOr(Schema.Finite),
              comments: Schema.Struct({
                nodes: Schema.Array(Schema.Struct({ id: Schema.String, author: Author, body: Schema.String })),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** The GraphQL query of the review threads of PR `pr` with each comment's id, over the variables `owner` and `name`. */
export function wakeThreadsQueryOf(pr: number): string {
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{id author{login} body}}}}}}}`;
}

/** The keys the relay delivered, as it writes them to `.lab/state/watch-<pr>.json`. */
export const SeenKeys = Schema.Array(Schema.String);

/** A PR's state from what gh printed: its view, its checks, its conversation's lines and its review threads. */
export function prStateOf(view: string, checks: string, conversation: string, threads: string): PrState {
  const { state, isDraft, headRefOid } = decodeJson(PrView, "gh pr view", view);

  const nodes = decodeJson(ReviewThreads, "the review threads query", threads).data.repository.pullRequest.reviewThreads
    .nodes;

  return {
    state,
    draft: isDraft,
    head: headRefOid,
    // `gh pr checks` exits 8 while checks are pending and 1 when one fails; its JSON is printed either way.
    checks: checks.trim() === "" ? [] : decodeJson(Schema.Array(Check), "gh pr checks", checks),
    threads: nodes.map((node) => ({
      id: node.id,
      resolved: node.isResolved,
      path: node.path,
      line: node.line,
      author: node.comments.nodes[0]?.author?.login ?? "unknown",
      body: node.comments.nodes[0]?.body ?? "",
      replies: node.comments.nodes
        .slice(1)
        .map((comment) => ({ id: comment.id, author: comment.author?.login ?? "unknown", body: comment.body })),
    })),
    comments: conversation
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const comment = decodeJson(ConversationComment, "a conversation comment", line);

        return { ...comment, author: comment.author?.replace(/\[bot\]$/u, "") ?? "unknown" };
      }),
  };
}

/**
 * A session `claude agents --json` lists, as far as the relay reads it: a running one has a `pid`, a
 * background one the `id` that `claude stop` takes, and a `status` that reads `busy` during a turn. Its
 * `state` is no such signal: it can read `working` while the session waits for an answer.
 */
const Agent = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Finite),
  id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
});

/**
 * How a Wake reaches the Author's session: its messaging socket while it runs, a resume when it no
 * longer does; for the Owner's words, a stop then a resume, or nothing yet.
 */
export type Route =
  | { readonly kind: "socket"; readonly pid: number }
  | { readonly kind: "resume" }
  | { readonly kind: "stop"; readonly id: string; readonly pid: number }
  | { readonly kind: "wait" };

/**
 * The route to `session` from what `claude agents --json` printed. A running session is never resumed:
 * Claude Code would start a copy of it. Claude Code hands a socket message to the session as a peer's,
 * never as its user's approval, so a running background session that the Owner's words must reach is
 * stopped, then resumed with them, when its status reads `idle`; it waits while its status reads `busy`,
 * since a stop would cut its turn. Any other status, or none, is not read as idle: the words go on the
 * socket, as they do to a session Claude Code cannot stop.
 */
export function routeOf(agents: string, session: string, ownerWords: boolean): Route {
  const found = decodeJson(Schema.Array(Agent), "claude agents --json", agents).find(
    (agent) => agent.sessionId === session,
  );

  if (found?.pid === undefined) {
    return { kind: "resume" };
  }

  if (ownerWords && found.id !== undefined && found.status === "idle") {
    return { kind: "stop", id: found.id, pid: found.pid };
  }

  if (ownerWords && found.id !== undefined && found.status === "busy") {
    return { kind: "wait" };
  }

  return { kind: "socket", pid: found.pid };
}

/** The line the relay writes on a session's messaging socket: one user message. An external format: Claude Code reads it. */
export function socketLineOf(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** The command that resumes `session` in the background with `text` as its next turn, and no other flag: it keeps its launch options. */
export function resumeArgsOf(session: string, text: string): readonly string[] {
  return ["claude", "--bg", "--resume", session, text];
}

/** One line of `.lab/outcomes.log` for the relay of PR `pr`, without its newline: its start, or its end and why. */
export function relayLineOf(at: string, pr: number, event: "started" | "ended", reason: string | null): string {
  return JSON.stringify(reason === null ? { at, relay: event, pr } : { at, relay: event, pr, reason });
}
