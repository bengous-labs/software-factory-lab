/**
 * The Wakes of a pull request, as pure functions over one reading of it: a failing check on its head, a
 * conflict with the Trunk, a new open Important or Nit finding of the App, an Important a later round reports
 * again, a new comment of the Owner in an open thread or in the conversation, the PR back in draft unless it
 * holds the Author's question the Owner has not answered yet. A failing check another Wake already tells
 * makes none: the Review check, which a finding carries, and the Land gate of a conflicting PR. Nor do the
 * App's own Pre-existing findings and its conversation comments (state record, verdicts); nor the replies the
 * Stop hook posts for the Author; nor any other login's comment: the lab is public, and a Wake starts a turn
 * in a session that holds the Author's token. A PR that lands or closes starts no turn. Each Wake has a key,
 * so the relay delivers it once.
 */

import { Schema } from "effect";

import { LAND_GATE, REVIEW_CHECK } from "../../contract.ts";
import { TRUNK } from "../../install/host.ts";
import { APP_LOGIN } from "../../install/logins.ts";
import { decodeJson } from "../../lib/json.ts";
import { unescapeHtml } from "../../lib/markdown.ts";
import { apiWorkerLogOf, apiWorkerSettingsOf, resumedTurnArgvOf } from "../shared/api-worker.ts";
import { byOwner, questionOpen } from "../shared/author-mark.ts";
import { conversationOf } from "../shared/conversation.ts";
import { severityOfBody } from "../shared/findings.ts";
import type { HeadlessSession } from "../shared/relay.port.ts";

/** One check as `gh pr checks --json name,bucket,link` prints it. */
const Check = Schema.Struct({ name: Schema.String, bucket: Schema.String, link: Schema.String });

type Check = typeof Check.Type;

interface Comment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
}

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
  /** GitHub reads the PR as conflicting with its base. */
  readonly conflicting: boolean;
  readonly checks: readonly Check[];
  readonly threads: readonly Thread[];
  /** The PR's conversation comments. */
  readonly comments: readonly Comment[];
}

/**
 * What a Wake reports, which sets how the Author is told to answer. `owner` is the Owner's own words
 * alone: they reach a running session as a turn of its user, not as a peer's message.
 */
export type WakeKind = "check" | "conflict" | "finding" | "owner" | "draft";

export interface Wake {
  readonly key: string;
  readonly kind: WakeKind;
  readonly line: string;
}

/** `body` on one line, cut at `max` characters. */
const flatTo = (body: string, max: number): string => body.replaceAll(/\s+/gu, " ").slice(0, max);

const flat = (body: string): string => flatTo(body, 400);

/**
 * Whether a failing check tells the Author nothing another Wake does not. The Review check is red on an
 * open Important, which its finding carries. The Land gate is red on a conflict, which the conflict Wake
 * says with what to run; its other reds, an ejection from the merge queue among them, have no other Wake.
 */
const saidElsewhere = (check: Check, conflicting: boolean): boolean =>
  check.name === REVIEW_CHECK || (check.name === LAND_GATE && conflicting);

/** The most characters of a reply that reports an Important again: it may hold the finding of each pass of its round. */
const AGAIN_MAX = 3000;

/** The Wake of an open thread's first comment: the App's Important or Nit finding, or the Owner's comment. */
function threadWakesOf(thread: Thread, where: string): readonly Wake[] {
  const key = `thread:${thread.id}`;

  if (thread.author === APP_LOGIN) {
    const severity = severityOfBody(thread.body);
    const kind = severity === null ? "Comment" : "Finding";
    const line = `${kind} ${thread.id} on ${where} by ${thread.author}: ${flat(unescapeHtml(thread.body))}`;

    return severity === "pre_existing" ? [] : [{ key, kind: "finding", line }];
  }

  return byOwner(thread)
    ? [{ key, kind: "owner", line: `Comment ${thread.id} on ${where} by ${thread.author}: ${flat(thread.body)}` }]
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

    return again ? [{ key, kind: "finding", line }] : [];
  }

  return byOwner(reply)
    ? [{ key, kind: "owner", line: `Reply in ${thread.id} on ${where} by ${reply.author}: ${flat(reply.body)}` }]
    : [];
}

/** The Wakes of one reading of an open PR, each with the key that keeps it from being delivered twice. */
export function wakesOf(pr: number, state: PrState): readonly Wake[] {
  const short = state.head.slice(0, 7);

  if (state.state !== "OPEN") {
    return [];
  }

  const wakes: Wake[] = state.checks
    .filter((check) => check.bucket === "fail" && !saidElsewhere(check, state.conflicting))
    .map((check) => ({
      key: `check:${check.name}:${state.head}`,
      kind: "check",
      line: `Check ${check.name} failed on ${short}: ${check.link}`,
    }));

  if (state.conflicting) {
    wakes.push({
      key: `conflict:${state.head}`,
      kind: "conflict",
      // The Author's copy of the Trunk dates from its last stop: without the fetch the rebase would change nothing.
      line: `PR #${pr} conflicts with ${TRUNK}: run \`git fetch origin ${TRUNK}\`, then rebase onto origin/${TRUNK}.`,
    });
  }

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
      kind: "owner",
      line: `Comment on PR #${pr} by ${comment.author}: ${flat(comment.body)}`,
    });
  }

  // A draft that holds the Author's open question waits for the Owner, whose answer brings this line along.
  if (state.draft && !questionOpen(state.comments)) {
    wakes.push({
      key: `draft:${state.head}`,
      kind: "draft",
      line: `PR #${pr} is back in draft at ${short}: it lands only after your next stop.`,
    });
  }

  return wakes;
}

/**
 * What one reading delivers, each Wake `seen` does not hold yet, and whether the relay ends. A landed
 * or closed PR ends it with no Wake: its Author has nothing left to do, so no turn starts.
 */
export interface Reading {
  readonly wakes: readonly Wake[];
  readonly ends: boolean;
}

export function readingOf(pr: number, state: PrState, seen: ReadonlySet<string>): Reading {
  return { wakes: wakesOf(pr, state).filter((wake) => !seen.has(wake.key)), ends: state.state !== "OPEN" };
}

/** Whether a Wake the reading delivers holds the Owner's words. */
export const ownerWordsIn = (reading: Reading): boolean => reading.wakes.some((wake) => wake.kind === "owner");

/** How the Author answers findings: it names its rejections alone, since nobody declares a fix. */
const FINDINGS_ANSWER =
  "Fix what you accept with a commit, name in your last message each finding you reject and why, then stop.";

const FIX_ANSWER = "Fix it with a commit, then stop.";

/**
 * How the Author answers Wakes of `kinds`; null when their lines say it all, as the Owner's words and a
 * PR back in draft do.
 */
export function answerOf(kinds: readonly WakeKind[]): string | null {
  if (kinds.includes("finding")) {
    return FINDINGS_ANSWER;
  }

  return kinds.includes("check") || kinds.includes("conflict") ? FIX_ANSWER : null;
}

/** The text of the turn a reading's Wakes start in the Author's session: their lines, then how the Author answers them. */
export function wakeTextOf(pr: number, reading: Reading): string {
  const answer = answerOf(reading.wakes.map((wake) => wake.kind));

  return [
    `The Land loop, about your pull request #${pr}:`,
    ...reading.wakes.map((wake) => wake.line),
    ...(answer === null ? [] : [answer]),
  ].join("\n");
}

const PrView = Schema.Struct({
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  isDraft: Schema.Boolean,
  headRefOid: Schema.String,
  /** `CONFLICTING`, `MERGEABLE`, or `UNKNOWN` while GitHub computes it. */
  mergeable: Schema.String,
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
  const { state, isDraft, headRefOid, mergeable } = decodeJson(PrView, "gh pr view", view);

  const nodes = decodeJson(ReviewThreads, "the review threads query", threads).data.repository.pullRequest.reviewThreads
    .nodes;

  return {
    state,
    draft: isDraft,
    head: headRefOid,
    conflicting: mergeable === "CONFLICTING",
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
    comments: conversationOf(conversation),
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
 * longer does; for the Owner's words, a stop then a resume, or nothing yet. An API Worker's session gets
 * a headless resume, left running in its clone with its output appended to `log`.
 */
export type Route =
  | { readonly kind: "socket"; readonly pid: number }
  | { readonly kind: "resume" }
  | { readonly kind: "stop"; readonly id: string }
  | { readonly kind: "headless"; readonly worktree: string; readonly log: string }
  | { readonly kind: "wait" };

/**
 * The route to `session` from what `claude agents --json` printed. A running session is never resumed:
 * Claude Code would start a copy of it. Claude Code hands a socket message to the session as a peer's,
 * never as its user's approval, so a running background session that the Owner's words must reach is
 * stopped, then resumed with them, when its status reads `idle`; it waits while its status reads `busy`,
 * since a stop would cut its turn. Any other status, or none, is not read as idle: the words go on the
 * socket, as they do to a session Claude Code cannot stop. The status is the listing's: a turn that
 * starts between the listing and the stop is cut, since Claude Code offers no stop that holds off a busy
 * session.
 */
export function routeOf(agents: string, session: string, ownerWords: boolean): Route {
  const found = decodeJson(Schema.Array(Agent), "claude agents --json", agents).find(
    (agent) => agent.sessionId === session,
  );

  if (found?.pid === undefined) {
    return { kind: "resume" };
  }

  const socket: Route = { kind: "socket", pid: found.pid };

  if (!ownerWords || found.id === undefined) {
    return socket;
  }

  if (found.status === "idle") {
    return { kind: "stop", id: found.id };
  }

  return found.status === "busy" ? { kind: "wait" } : socket;
}

/** How a text was delivered. */
export type Delivered = "socket" | "resume" | "headless";

/** How many stops in a row may fail to show before the Owner's words take the socket. */
const MAX_FAILED_STOPS = 3;

/**
 * Whether the Owner's words still seek a stop and a resume, after `failedStops` stops in a row that the
 * listing did not show: past the bound they go on the socket, as a peer's message, rather than never.
 */
export const stopWanted = (ownerWords: boolean, failedStops: number): boolean =>
  ownerWords && failedStops < MAX_FAILED_STOPS;

/** Whether what `claude agents --json` printed shows `session` stopped: listed without a pid, or not listed. */
export const stoppedIn = (agents: string, session: string): boolean =>
  routeOf(agents, session, false).kind === "resume";

/**
 * The session a PR's Wakes go to, as `relay-<pr>.session` holds it: the session of the PR's latest
 * Publication, and what a headless resume needs when it is an API Worker's.
 */
export interface Target {
  readonly session: string;
  readonly headless: HeadlessSession | null;
  /** The clone a background Worker's session works in, where its resume runs; null for any other. */
  readonly clone: string | null;
}

const Headless = Schema.Struct({ model: Schema.NullOr(Schema.String), worktree: Schema.String });

const InClone = Schema.Struct({ clone: Schema.String });

const SecondLine = Schema.Union([Headless, InClone]);

/**
 * The text of `relay-<pr>.session`: the session's id on the first line, and a second line of JSON for an
 * API Worker, what its headless resume needs, or for a background Worker in a clone, that clone. An on-disk format: the Stop hook writes it at each Publication and a running relay reads it.
 */
export function targetTextOf({ session, headless, clone }: Target): string {
  if (headless !== null) {
    return `${session}\n${JSON.stringify(headless)}\n`;
  }

  return clone === null ? `${session}\n` : `${session}\n${JSON.stringify({ clone })}\n`;
}

/** The target `relay-<pr>.session` holds, from its text. */
export function targetOf(text: string): Target {
  const [session = "", second = ""] = text.split("\n");

  if (second === "") {
    return { session, headless: null, clone: null };
  }

  const held = decodeJson(SecondLine, "the second line of the relay's session file", second);

  return "clone" in held ? { session, headless: null, clone: held.clone } : { session, headless: held, clone: null };
}

/** What one delivery sends, whichever way it goes: the route, the line for a socket, the command of a resume. */
export interface Sending {
  readonly route: Route;
  readonly socketLine: string;
  readonly resumeArgs: readonly string[];
  /**
   * The directory a background resume runs in: the clone the session works in, where Claude Code keeps
   * its conversation; null for the relay's own checkout.
   */
  readonly resumeIn: string | null;
}

/** What a delivery sends, and what holds it back. */
export interface WakeSending {
  readonly text: string;
  /** The Owner's words still seek a stop of a background session. */
  readonly stop: boolean;
  /** A headless turn failed at its start a moment ago: none is started before `retryDelayOf` has passed. */
  readonly held: boolean;
}

/** The longest the relay waits before it tries a headless turn again. */
const RETRY_MAX_MS = 30 * 60_000;

/**
 * How long the relay waits before it starts a headless turn again, after `failures` turns in a row that
 * failed at their start, its key refused or its credits spent: one minute, then twice as long each
 * time, up to half an hour. No count ends the tries: a key the Owner fixes heals the PR's Wakes.
 */
export function retryDelayOf(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

/** The main checkout the relay runs in, and the home that holds the API Worker settings file. */
export interface RelayPlace {
  readonly checkout: string;
  readonly home: string;
}

/**
 * How `text` reaches `target`, from what `claude agents --json` printed. An API Worker's session has no
 * socket and takes every turn as its user's: it waits while the listing shows its turn running, since a
 * second resume would start a copy of the conversation, and is resumed headless, with the API Worker
 * settings file and its model, once the listing shows it stopped and no failed start holds it back. Any other session takes `routeOf`,
 * where `stop` says whether the Owner's words still seek a stop.
 */
export function sendingOf(
  agents: string,
  target: Target,
  { text, stop, held }: WakeSending,
  { checkout, home }: RelayPlace,
): Sending {
  const { session, headless, clone } = target;
  const socketLine = socketLineOf(text);

  if (headless === null) {
    return {
      route: routeOf(agents, session, stop),
      socketLine,
      resumeArgs: resumeArgsOf(session, text),
      resumeIn: clone,
    };
  }

  return {
    route:
      !held && stoppedIn(agents, session)
        ? { kind: "headless", worktree: headless.worktree, log: apiWorkerLogOf(checkout, session) }
        : { kind: "wait" },
    socketLine,
    resumeIn: null,
    resumeArgs: resumedTurnArgvOf({
      session,
      model: headless.model,
      effort: null,
      settings: apiWorkerSettingsOf(home),
      checkout,
      prompt: text,
    }),
  };
}

/** The line the relay writes on a session's messaging socket: one user message. An external format: Claude Code reads it. */
export function socketLineOf(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/**
 * The command that resumes `session` in the background with `text` as its next turn, and no other flag:
 * it keeps its launch options, and Claude Code starts a copy of a session whose resume names one.
 */
export function resumeArgsOf(session: string, text: string): readonly string[] {
  return ["claude", "--bg", "--resume", session, text];
}

/** One line of `.lab/outcomes.log` for the relay of PR `pr`, without its newline: its start, or its end and why. */
export function relayLineOf(at: string, pr: number, event: "started" | "ended", reason: string | null): string {
  return JSON.stringify(reason === null ? { at, relay: event, pr } : { at, relay: event, pr, reason });
}
