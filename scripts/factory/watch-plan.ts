/**
 * What the watch of an orchestrating session decides, as pure functions over one reading of the
 * factory: the PRs it watches, the sessions `claude agents --json` lists, and the stops
 * `.lab/outcomes.log` holds. It tells five events: a PR holds a Worker's question to the Owner; a PR
 * waits for the Owner's Land approval; a PR has not moved for `STALL_MS` while nothing says why; a
 * Worker is idle while its change is the Author's turn, its PR in draft or no PR after a stop that
 * published nothing; a PR landed or closed, an issue closed. Each event has a key, so it is printed
 * once. The clock and the memory of what earlier readings saw are inputs.
 */

import { Schema } from "effect";

import { CI_CHECKS, gateWaitOf, LAND_GATE, REVIEW_CHECK } from "../land-loop/merge-bot/decide.ts";
import { openQuestionOf } from "../land-loop/stop/decide.ts";
import { decodeJson } from "../lib/json.ts";
import { unescapeHtml } from "../lib/markdown.ts";
import { branchMadeFor } from "./dispatch-plan.ts";

const USAGE = "usage: bun scripts/factory/watch.ts [<issue>...]";

/** The issues `argv` names, in order and once each; none watches the repository's open PRs. Throws the usage on anything else. */
export function watchArgsOf(argv: readonly string[]): readonly number[] {
  if (!argv.every((arg) => /^[1-9]\d*$/u.test(arg))) {
    throw new Error(USAGE);
  }

  return [...new Set(argv.map(Number))].toSorted((left, right) => left - right);
}

/** How long a PR stays still, with nothing that says why, before the watch tells it. */
export const STALL_MS = 20 * 60_000;

/**
 * How long a draft stays still with its Worker idle before the watch tells it: the relay delivers a Wake
 * within 30 s, so a Worker still idle after this missed it or stopped on it.
 */
export const IDLE_MS = 3 * 60_000;

/** The checks a PR moves by: CI, the Review check and the Land gate. The Merge bot's own job runs on every Sweep. */
const READ_CHECKS: readonly string[] = [...CI_CHECKS, REVIEW_CHECK, LAND_GATE];

/** The latest run of a check on a PR's head. */
export interface Check {
  readonly name: string;
  /** GitHub's status: `QUEUED`, `IN_PROGRESS`, `COMPLETED`… */
  readonly status: string;
  readonly conclusion: string | null;
  /** The check's summary line; the Land gate's says what the PR waits for. */
  readonly title: string | null;
}

export interface Comment {
  readonly id: string;
  readonly url: string;
  readonly author: string;
  readonly body: string;
}

export interface Pr {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly draft: boolean;
  readonly branch: string;
  readonly head: string;
  readonly conflicting: boolean;
  /** The issues the PR closes when it lands. */
  readonly issues: readonly number[];
  readonly labels: readonly string[];
  /** The conversation's comments, in their order. */
  readonly comments: readonly Comment[];
  readonly openThreads: number;
  /** The latest run of each of `READ_CHECKS` on the head, by name. */
  readonly checks: readonly Check[];
}

interface Issue {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  /** The PRs that close it, open or not. */
  readonly prs: readonly number[];
}

/** A session `claude agents --json` lists: a running one has a pid, and a status that reads `busy` during a turn. */
export interface Session {
  readonly id: string;
  readonly running: boolean;
  readonly status: string | null;
}

/** One stop of an Author, as the Stop hook logs it to `.lab/outcomes.log`. */
export interface Stop {
  readonly at: string;
  readonly session: string;
  readonly branch: string | null;
  readonly outcome: "published" | "asked" | "not-published";
  readonly reason: string | null;
}

/** One reading of the factory. */
export interface Reading {
  /** The PRs the watch reads: the open ones or the watched issues', and those it watched before. */
  readonly prs: readonly Pr[];
  /** The watched issues. */
  readonly issues: readonly Issue[];
  readonly sessions: readonly Session[];
  /** The stops, oldest first. */
  readonly stops: readonly Stop[];
}

const Still = Schema.Struct({ mark: Schema.String, since: Schema.String });

/**
 * What the watch keeps between readings: the keys of the events it printed, and for each PR open at the
 * last reading the mark of its state and when that mark was first read.
 */
export const Memory = Schema.Struct({
  printed: Schema.Array(Schema.String),
  still: Schema.Record(Schema.String, Still),
});

export type Memory = typeof Memory.Type;

export const EMPTY_MEMORY: Memory = { printed: [], still: {} };

/** The file under the main checkout `checkout` where the watch of `issues` keeps its memory. */
export function memoryFileOf(checkout: string, issues: readonly number[]): string {
  return `${checkout}/.lab/state/factory-watch-${issues.length === 0 ? "open" : issues.join("-")}.json`;
}

interface WatchEvent {
  readonly key: string;
  readonly line: string;
}

/** What one reading prints, the memory it leaves, and whether the watch ends. */
export interface WatchStep {
  readonly lines: readonly string[];
  readonly memory: Memory;
  readonly ends: boolean;
}

/**
 * What a PR's state is made of, for telling whether it moved: its head, draft, conflict, labels,
 * comments, open threads, and the state of each check it moves by. A check's re-post with the same
 * result, which each Merge bot Sweep makes, is no move.
 */
export function markOf(pr: Pr): string {
  return JSON.stringify([
    pr.head,
    pr.draft,
    pr.conflicting,
    pr.labels.toSorted(),
    pr.comments.map((comment) => comment.id),
    pr.openThreads,
    pr.checks.map((check) => [check.name, check.status, check.conclusion, check.title]),
  ]);
}

type WorkerState = "busy" | "idle" | "gone";

/** The Worker of a branch: the session of its last stop, that stop, and how the session stands. */
interface Worker {
  readonly session: string;
  readonly state: WorkerState;
  readonly lastStop: Stop;
}

function workerOf(reading: Reading, lastStop: Stop | undefined): Worker | null {
  if (lastStop === undefined) {
    return null;
  }

  const session = reading.sessions.find((found) => found.id === lastStop.session);
  const busy = session?.status === "busy" ? "busy" : "idle";

  return { session: lastStop.session, state: session?.running === true ? busy : "gone", lastStop };
}

const idleWorker = (worker: Worker | null): worker is Worker => worker !== null && worker.state !== "busy";

/** `text` on one line, cut at `max` characters. */
const flatTo = (text: string, max: number): string => text.replaceAll(/\s+/gu, " ").trim().slice(0, max);

const whereOf = (pr: Pr): string =>
  pr.issues.length === 0 ? `PR #${pr.number}` : `PR #${pr.number} (issue #${pr.issues.join(", #")})`;

const workerTextOf = (worker: Worker): string =>
  `its Worker (session ${worker.session}) ${worker.state === "gone" ? "is not running" : "is idle"}`;

const lastStopTextOf = ({ lastStop }: Worker): string => {
  const why = lastStop.reason === null ? "" : `: ${flatTo(lastStop.reason, 300)}`;

  return `its last stop at ${lastStop.at} ${lastStop.outcome === "not-published" ? "published nothing" : lastStop.outcome}${why}`;
};

/** The question the Stop hook's comment quotes, on one line: what `questionCommentOf` quoted, read back. */
export function questionOf(body: string): string {
  const quoted = body
    .split("\n")
    .filter((line) => line.startsWith(">"))
    .map((line) => line.replace(/^> ?/u, ""));

  return flatTo(unescapeHtml(quoted.join("\n")), 1000);
}

const minutesOf = (ms: number): number => Math.floor(ms / 60_000);

/** What a still PR shows: its Land gate, the checks that have not completed, and its Worker. */
function stillFactsOf(pr: Pr, gate: Check | undefined, worker: Worker | null): string {
  const gateText =
    gate === undefined
      ? `no ${LAND_GATE} on its head`
      : `${LAND_GATE} ${gate.status === "COMPLETED" ? (gate.conclusion ?? "completed").toLowerCase() : "pending"} (${gate.title ?? "no summary"})`;

  const running = pr.checks.filter((check) => check.name !== LAND_GATE && check.status !== "COMPLETED");
  const runningText = running.length === 0 ? [] : [`${running.map((check) => check.name).join(", ")} not completed`];
  const workerText = worker === null ? "no stop of a Worker is logged for its branch" : workerTextOf(worker);

  return [gateText, ...runningText, workerText].join("; ");
}

/** The event of a PR that landed or closed since an earlier reading saw it open. */
const endEventOf = (pr: Pr): WatchEvent => ({
  key: `end:${pr.number}`,
  line:
    pr.state === "MERGED" ? `${whereOf(pr)} landed: ${pr.url}` : `${whereOf(pr)} was closed without landing: ${pr.url}`,
});

/** How long an open PR has been still, and since when. */
interface Stillness {
  readonly since: string;
  readonly ms: number;
}

/**
 * The event of an open PR, the first that applies: its Worker's question to the Owner; its wait for the
 * Owner's Land approval; its Worker idle while it is in draft, the Author's turn; its stillness for
 * `STALL_MS` while no running review and no busy Worker says why.
 */
function openEventOf(pr: Pr, worker: Worker | null, still: Stillness): WatchEvent | null {
  const where = whereOf(pr);
  const question = openQuestionOf(pr.comments);

  if (question !== null) {
    return {
      key: `question:${question.id}`,
      line: `${where} holds its Worker's question to the Owner: "${questionOf(question.body)}" The Worker waits; the Owner answers in a comment of the PR's conversation: ${question.url}`,
    };
  }

  const gate = pr.checks.find((check) => check.name === LAND_GATE);
  const pending = gate === undefined || gate.status === "COMPLETED" ? null : (gate.title ?? "");
  const wait = pending === null ? null : gateWaitOf(pending);

  if (wait === "owner") {
    return { key: `owner:${pr.number}:${pr.head}`, line: `${where}, its Land gate: ${pending} ${pr.url}` };
  }

  if (pr.draft && idleWorker(worker)) {
    return still.ms < IDLE_MS
      ? null
      : {
          key: `idle:${pr.number}:${still.since}:${worker.lastStop.at}`,
          line: `${where} is in draft, the Author's turn, and ${workerTextOf(worker)}; ${lastStopTextOf(worker)}. Give the Worker its turn, or look at the PR: ${pr.url}`,
        };
  }

  if (still.ms < STALL_MS || wait === "review" || worker?.state === "busy") {
    return null;
  }

  return {
    key: `stalled:${pr.number}:${still.since}`,
    line: `${where} has not moved for ${minutesOf(still.ms)} min, and nothing says why: ${stillFactsOf(pr, gate, worker)}. A check may be stuck on GitHub, or the relay dead: ${pr.url}/checks`,
  };
}

/**
 * The event of a watched issue: closed; or open with no open PR while the Worker of a branch made for it
 * is idle after a stop that published nothing.
 */
function issueEventOf(issue: Issue, reading: Reading): WatchEvent | null {
  if (issue.state === "CLOSED") {
    return { key: `closed:${issue.number}`, line: `Issue #${issue.number} is closed.` };
  }

  if (reading.prs.some((pr) => pr.state === "OPEN" && pr.issues.includes(issue.number))) {
    return null;
  }

  const lastStop = reading.stops.findLast((stop) => stop.branch !== null && branchMadeFor(stop.branch, issue.number));
  const worker = workerOf(reading, lastStop);

  if (!idleWorker(worker) || worker.lastStop.outcome !== "not-published") {
    return null;
  }

  return {
    key: `idle:issue:${issue.number}:${worker.lastStop.at}`,
    line: `Issue #${issue.number} has no open PR, and ${workerTextOf(worker)}; ${lastStopTextOf(worker)}. Give the Worker its turn, or look at its worktree.`,
  };
}

/** How `pr` stands still, from the memory of the last reading: a new mark is still since `now`. */
function stillnessOf(memory: Memory, pr: Pr, now: string): Stillness & { readonly mark: string } {
  const mark = markOf(pr);
  const before = memory.still[String(pr.number)];
  const since = before?.mark === mark ? before.since : now;

  return { mark, since, ms: Date.parse(now) - Date.parse(since) };
}

/** Whether the watch of `issues` ends after `reading`: every issue closed, or with none, no PR it watches open. */
function endsAfter(issues: readonly number[], reading: Reading): boolean {
  if (issues.length === 0) {
    return reading.prs.every((pr) => pr.state !== "OPEN");
  }

  return issues.every((number) => reading.issues.some((issue) => issue.number === number && issue.state === "CLOSED"));
}

/**
 * One step of the watch of `issues`, none for the repository's open PRs: the lines of the events of
 * `reading` that `memory` has not printed, the memory after them, and whether the watch ends. A PR's end
 * is told only when an earlier reading saw it open.
 */
export function stepOf(issues: readonly number[], reading: Reading, memory: Memory, now: string): WatchStep {
  const events: Array<WatchEvent | null> = [];
  const still: Record<string, typeof Still.Type> = {};

  for (const pr of reading.prs.toSorted((left, right) => left.number - right.number)) {
    if (pr.state === "OPEN") {
      const { mark, since, ms } = stillnessOf(memory, pr, now);

      const worker = workerOf(
        reading,
        reading.stops.findLast((stop) => stop.branch === pr.branch),
      );

      still[String(pr.number)] = { mark, since };
      events.push(openEventOf(pr, worker, { since, ms }));
    } else if (memory.still[String(pr.number)] !== undefined) {
      events.push(endEventOf(pr));
    }
  }

  events.push(...reading.issues.map((issue) => issueEventOf(issue, reading)));

  const printed = new Set(memory.printed);
  const fresh = events.filter((event): event is WatchEvent => event !== null && !printed.has(event.key));

  return {
    lines: fresh.map((event) => event.line),
    memory: { printed: [...memory.printed, ...fresh.map((event) => event.key)], still },
    ends: endsAfter(issues, reading),
  };
}

/** The fields of a PR the watch reads, for the fragment `P` of `watchQueryOf`. */
const PR_FIELDS = [
  "number url state isDraft headRefName headRefOid mergeable",
  "closingIssuesReferences(first:10){nodes{number}}",
  "labels(first:50){nodes{name}}",
  "comments(last:100){nodes{id url author{login} body}}",
  "reviewThreads(first:100){nodes{isResolved}}",
  "commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{kind:__typename ... on CheckRun{name status conclusion title startedAt}}}}}}}",
].join(" ");

/**
 * The GraphQL query of one reading, over the variables `owner` and `name`: the open PRs when `issues` is
 * empty, else each issue with the PRs that close it; and each PR of `prs` by its number.
 */
export function watchQueryOf(issues: readonly number[], prs: readonly number[]): string {
  const fields = [
    ...(issues.length === 0 ? ["open:pullRequests(states:OPEN,first:100){nodes{...P}}"] : []),
    ...issues.map(
      (issue) =>
        `i${issue}:issue(number:${issue}){number state closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{...P}}}`,
    ),
    ...prs.map((pr) => `p${pr}:pullRequest(number:${pr}){...P}`),
  ];

  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${fields.join(" ")}}} fragment P on PullRequest{${PR_FIELDS}}`;
}

const Nodes = <S extends Schema.Top>(node: S) => Schema.Struct({ nodes: Schema.Array(node) });

const CheckRunNode = Schema.Struct({
  kind: Schema.Literal("CheckRun"),
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
});

/** A commit status, which the Land loop does not post: read for its kind alone. */
const StatusContextNode = Schema.Struct({ kind: Schema.Literal("StatusContext") });

const PrNode = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  /** `CONFLICTING`, `MERGEABLE`, or `UNKNOWN` while GitHub computes it. */
  mergeable: Schema.String,
  closingIssuesReferences: Nodes(Schema.Struct({ number: Schema.Finite })),
  labels: Nodes(Schema.Struct({ name: Schema.String })),
  comments: Nodes(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
      body: Schema.String,
    }),
  ),
  reviewThreads: Nodes(Schema.Struct({ isResolved: Schema.Boolean })),
  commits: Nodes(
    Schema.Struct({
      commit: Schema.Struct({
        statusCheckRollup: Schema.NullOr(
          Schema.Struct({ contexts: Nodes(Schema.Union([CheckRunNode, StatusContextNode])) }),
        ),
      }),
    }),
  ),
});

const IssueNode = Schema.Struct({
  number: Schema.Finite,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  closedByPullRequestsReferences: Nodes(PrNode),
});

/** The answer to `watchQueryOf`: each alias holds the open PRs, an issue, or a PR. */
const WatchAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Record(Schema.String, Schema.Union([Nodes(PrNode), IssueNode, PrNode])),
  }),
});

type CheckRunNode = typeof CheckRunNode.Type;

/** The latest run of each of `READ_CHECKS` among a head's check runs, by name: each Merge bot run posts its checks again. */
function latestChecksOf(runs: readonly CheckRunNode[]): readonly Check[] {
  const latest = new Map<string, CheckRunNode>();

  for (const run of runs.filter((found) => READ_CHECKS.includes(found.name))) {
    const kept = latest.get(run.name);

    if (kept === undefined || (run.startedAt ?? "") > (kept.startedAt ?? "")) {
      latest.set(run.name, run);
    }
  }

  return READ_CHECKS.flatMap((name) => {
    const run = latest.get(name);

    return run === undefined ? [] : [{ name, status: run.status, conclusion: run.conclusion, title: run.title }];
  });
}

function prOf(node: typeof PrNode.Type): Pr {
  const contexts = node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];

  return {
    number: node.number,
    url: node.url,
    state: node.state,
    draft: node.isDraft,
    branch: node.headRefName,
    head: node.headRefOid,
    conflicting: node.mergeable === "CONFLICTING",
    issues: node.closingIssuesReferences.nodes.map((issue) => issue.number),
    labels: node.labels.nodes.map((label) => label.name),
    comments: node.comments.nodes.map((comment) => ({
      id: comment.id,
      url: comment.url,
      author: comment.author?.login ?? "unknown",
      body: comment.body,
    })),
    openThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    checks: latestChecksOf(contexts.flatMap((context) => (context.kind === "CheckRun" ? [context] : []))),
  };
}

/** The PRs and the issues of the answer `gh api graphql` printed to `watchQueryOf`, each PR once. */
export function githubOf(answer: string): Pick<Reading, "prs" | "issues"> {
  const prs = new Map<number, Pr>();
  const issues: Issue[] = [];

  const add = (nodes: ReadonlyArray<typeof PrNode.Type>): void => {
    for (const node of nodes) {
      prs.set(node.number, prOf(node));
    }
  };

  for (const value of Object.values(decodeJson(WatchAnswer, "the watch query", answer).data.repository)) {
    if ("nodes" in value) {
      add(value.nodes);
    } else if ("closedByPullRequestsReferences" in value) {
      add(value.closedByPullRequestsReferences.nodes);
      issues.push({
        number: value.number,
        state: value.state,
        prs: value.closedByPullRequestsReferences.nodes.map((pr) => pr.number),
      });
    } else {
      add([value]);
    }
  }

  return { prs: [...prs.values()], issues: issues.toSorted((left, right) => left.number - right.number) };
}

const Agent = Schema.Struct({
  sessionId: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Finite),
  status: Schema.optionalKey(Schema.String),
});

/** The sessions of what `claude agents --json` printed. */
export function sessionsOf(agents: string): readonly Session[] {
  return decodeJson(Schema.Array(Agent), "claude agents --json", agents).flatMap((agent) =>
    agent.sessionId === undefined
      ? []
      : [{ id: agent.sessionId, running: agent.pid !== undefined, status: agent.status ?? null }],
  );
}

const StopLine = Schema.Struct({
  at: Schema.String,
  session: Schema.String,
  branch: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["published", "asked", "not-published"]),
  reason: Schema.optionalKey(Schema.String),
});

/** The relay's start or end, which `.lab/outcomes.log` holds among the stops. */
const RelayLine = Schema.Struct({ at: Schema.String, relay: Schema.Literals(["started", "ended"]) });

/** The stops of `.lab/outcomes.log`, in its order; a line that is neither a stop nor the relay's throws. */
export function stopsOf(log: string): readonly Stop[] {
  return log
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const read = decodeJson(Schema.Union([StopLine, RelayLine]), ".lab/outcomes.log", line);

      return "session" in read
        ? [
            {
              at: read.at,
              session: read.session,
              branch: read.branch,
              outcome: read.outcome,
              reason: read.reason ?? null,
            },
          ]
        : [];
    });
}
