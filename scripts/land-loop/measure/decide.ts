/**
 * The Land loop's measure, as pure functions over what `gh api --paginate --slurp` read: each column
 * of a merged PR's row, and the weekly report the Owner reads to tighten or loosen a rule.
 */

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { DELTA_READ, LAND_APPROVAL_LABEL, reviewNameOf } from "../merge-bot/decide.ts";

export const REPO = "bengous-labs/software-factory-lab";

const APP = "bengous-labs-agents[bot]";

const OWNER = "bengous";

/** The marker `review/findings.ts` puts on an Important finding; posted comments keep its spelling. */
const IMPORTANT_MARKER = "<!-- lab-finding severity=important -->";

const Login = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const Pull = Schema.Struct({
  number: Schema.Int,
  created_at: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
  merge_commit_sha: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
});

export type Pull = typeof Pull.Type;

const IssueEvent = Schema.Struct({
  event: Schema.String,
  created_at: Schema.String,
  actor: Login,
  label: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
});

type IssueEvent = typeof IssueEvent.Type;

const Commit = Schema.Struct({ sha: Schema.String });

const CheckRun = Schema.Struct({
  started_at: Schema.NullOr(Schema.String),
  output: Schema.Struct({ title: Schema.NullOr(Schema.String) }),
});

type CheckRun = typeof CheckRun.Type;

const CheckRunsPage = Schema.Struct({ check_runs: Schema.Array(CheckRun) });

/** A pending review comes without `submitted_at`. */
const Review = Schema.Struct({
  user: Login,
  body: Schema.String,
  submitted_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

type Review = typeof Review.Type;

const ReviewComment = Schema.Struct({
  id: Schema.Int,
  in_reply_to_id: Schema.optionalKey(Schema.Int),
  user: Login,
  body: Schema.String,
});

type ReviewComment = typeof ReviewComment.Type;

const DevCommit = Schema.Struct({ sha: Schema.String, commit: Schema.Struct({ message: Schema.String }) });

export type DevCommit = typeof DevCommit.Type;

export const decodePullsPages = (text: string): readonly Pull[] =>
  decodeJson(Schema.Array(Schema.Array(Pull)), "pulls", text).flat();

export const decodeEventsPages = (text: string): PrData["events"] =>
  decodeJson(Schema.Array(Schema.Array(IssueEvent)), "issue events", text).flat();

/** The shas of the PR's commits. */
export const decodeCommitsPages = (text: string): readonly string[] =>
  decodeJson(Schema.Array(Schema.Array(Commit)), "pull commits", text)
    .flat()
    .map((commit) => commit.sha);

export const decodeReviewsPages = (text: string): PrData["reviews"] =>
  decodeJson(Schema.Array(Schema.Array(Review)), "pull reviews", text).flat();

export const decodeCommentsPages = (text: string): PrData["comments"] =>
  decodeJson(Schema.Array(Schema.Array(ReviewComment)), "pull review comments", text).flat();

export const decodeDevCommitsPages = (text: string): readonly DevCommit[] =>
  decodeJson(Schema.Array(Schema.Array(DevCommit)), "dev commits", text).flat();

export const decodeCheckRunsPages = (text: string): readonly CheckRun[] =>
  decodeJson(Schema.Array(CheckRunsPage), "land-gate check runs", text).flatMap((page) => page.check_runs);

/** What the measure reads of one merged PR; `checkRuns` holds the `land-gate` runs of every commit of the PR. */
export interface PrData {
  readonly pull: Pull;
  readonly events: readonly IssueEvent[];
  readonly commits: readonly string[];
  readonly checkRuns: readonly CheckRun[];
  readonly reviews: readonly Review[];
  readonly comments: readonly ReviewComment[];
}

export type Route = "owner" | "auto";

export interface Row {
  readonly number: number;
  readonly mergedAt: string;
  readonly route: Route | null;
  /** Milliseconds; null on an `auto` PR. */
  readonly ownerWait: number | null;
  readonly rounds: number;
  readonly found: number;
  readonly fixed: number;
  readonly rejected: number;
  readonly landOkGiven: number;
  /** The short sha of the commit on dev that reverts the PR. */
  readonly revertedBy: string | null;
}

export function routeOf(pull: Pull): Route | null {
  const names = new Set(pull.labels.map((label) => label.name));

  if (names.has("land:human")) {
    return "owner";
  }

  return names.has("land:auto") ? "auto" : null;
}

const landOkTimes = (events: PrData["events"]): readonly number[] =>
  events
    .filter(
      (event) => event.event === "labeled" && event.label?.name === LAND_APPROVAL_LABEL && event.actor?.login === OWNER,
    )
    .map((event) => Date.parse(event.created_at))
    .toSorted((a, b) => a - b);

export const landOkGivenOf = (events: PrData["events"]): number => landOkTimes(events).length;

const WAITING_ON_OWNER = /waiting for the owner's land approval/iu;

/** For each land-ok, from the earliest waiting run since the previous one (or the PR's creation) to it; 0 with no such run. */
export function ownerWaitOf(pr: PrData): number {
  const waiting = pr.checkRuns
    .flatMap((run) =>
      run.started_at !== null && WAITING_ON_OWNER.test(run.output.title ?? "") ? [Date.parse(run.started_at)] : [],
    )
    .toSorted((a, b) => a - b);

  const { total } = landOkTimes(pr.events).reduce(
    (acc, given) => {
      const first = waiting.find((started) => started > acc.since && started < given);

      return { since: given, total: acc.total + (first === undefined ? 0 : given - first) };
    },
    { since: Date.parse(pr.pull.created_at), total: 0 },
  );

  return total;
}

const ROUND = /^Review round (\d+) /u;

/** A Delta read's body as `post-plan.ts` writes it, opening with its name, with the patch its marker names. */
const DELTA_READ_BODY = new RegExp(
  `^${reviewNameOf(DELTA_READ)} [\\s\\S]*<!-- lab-review patch=(\\S+) round=${DELTA_READ} -->`,
  "u",
);

/** A round's counts as `post-plan.ts` writes them: the Code review's, then the security pass's when it ran. */
const IMPORTANT_COUNT = /: (\d+) important, \d+ nit(?:; security: (\d+) important, \d+ nit)?\./u;

/** The latest body the App posted under each key `keyOf` reads from it: a review posted again counts once. */
function latestBy(reviews: PrData["reviews"], keyOf: (body: string) => string | undefined): readonly string[] {
  const latest = new Map<string, string>();

  for (const review of reviews.toSorted((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""))) {
    const key = review.user?.login === APP ? keyOf(review.body) : undefined;

    if (key !== undefined) {
      latest.set(key, review.body);
    }
  }

  return [...latest.values()];
}

/** The latest review of each round the App posted. */
const latestRounds = (reviews: PrData["reviews"]): readonly string[] =>
  latestBy(reviews, (body) => ROUND.exec(body)?.[1]);

/** The latest review of each patch's Delta read the App posted. */
const latestDeltaReads = (reviews: PrData["reviews"]): readonly string[] =>
  latestBy(reviews, (body) => DELTA_READ_BODY.exec(body)?.[1]);

export const roundsOf = (reviews: PrData["reviews"]): number => latestRounds(reviews).length;

/** The Importants of each round and each Delta read, from the latest posting of each. */
export const importantFoundOf = (reviews: PrData["reviews"]): number =>
  [...latestRounds(reviews), ...latestDeltaReads(reviews)].reduce((sum, body) => {
    const [, code = "0", security = "0"] = IMPORTANT_COUNT.exec(body) ?? [];

    return sum + Number(code) + Number(security);
  }, 0);

export interface FindingAnswers {
  readonly fixed: number;
  readonly rejected: number;
}

/** The App's Important findings with a reply starting "Fixed in ", and those another login answered otherwise. */
export function findingAnswersOf(comments: PrData["comments"]): FindingAnswers {
  const importants = comments.filter(
    (comment) => comment.user?.login === APP && comment.body.includes(IMPORTANT_MARKER),
  );

  let fixed = 0;
  let rejected = 0;

  for (const finding of importants) {
    const replies = comments.filter((comment) => comment.in_reply_to_id === finding.id);

    if (replies.some((reply) => reply.body.startsWith("Fixed in "))) {
      fixed += 1;
    } else if (replies.some((reply) => reply.user?.login !== APP)) {
      rejected += 1;
    }
  }

  return { fixed, rejected };
}

/** The commit `git revert` names ends its sentence there, or, for a merge commit, goes on with the changes it reverses. */
const REVERTED_SHA = /This reverts commit ([0-9a-f]{40})[.,]/gu;

export function revertedByOf(pr: PrData, devCommits: readonly DevCommit[]): string | null {
  const shas = new Set([pr.pull.merge_commit_sha, ...pr.commits]);

  const revert = devCommits.find((commit) =>
    [...commit.commit.message.matchAll(REVERTED_SHA)].some(([, sha]) => shas.has(sha ?? null)),
  );

  return revert === undefined ? null : revert.sha.slice(0, 7);
}

export function rowOf(pr: PrData, devCommits: readonly DevCommit[]): Row {
  const route = routeOf(pr.pull);

  return {
    number: pr.pull.number,
    mergedAt: pr.pull.merged_at ?? "",
    route,
    ownerWait: route === "auto" ? null : ownerWaitOf(pr),
    rounds: roundsOf(pr.reviews),
    found: importantFoundOf(pr.reviews),
    ...findingAnswersOf(pr.comments),
    landOkGiven: landOkGivenOf(pr.events),
    revertedBy: revertedByOf(pr, devCommits),
  };
}

const DASH = "–";

/** `<h>h<mm>`, rounded to the minute. */
export function durationOf(ms: number): string {
  const minutes = Math.round(ms / 60_000);

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

const DAY = 86_400_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const dayOf = (ms: number): string => `${MONTHS[new Date(ms).getUTCMonth()]} ${new Date(ms).getUTCDate()}`;

interface Week {
  readonly key: string;
  readonly title: string;
}

/** The ISO week (Monday to Sunday, UTC) holding `iso`. */
function weekOf(iso: string): Week {
  const day = new Date(iso.slice(0, 10)).getTime();
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  const thursday = new Date(monday + 3 * DAY);
  const year = thursday.getUTCFullYear();
  const number = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  const key = `${year}-W${String(number).padStart(2, "0")}`;

  return { key, title: `## Week ${key} (${dayOf(monday)} ${DASH} ${dayOf(monday + 6 * DAY)})` };
}

const prs = (count: number): string => `${count} ${count === 1 ? "PR" : "PRs"}`;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function medianOf(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const lineOf = (row: Row): string =>
  `| ${[
    `#${row.number}`,
    row.route ?? DASH,
    row.ownerWait === null ? DASH : durationOf(row.ownerWait),
    row.rounds,
    row.found,
    row.fixed,
    row.rejected,
    row.landOkGiven,
    row.revertedBy ?? DASH,
  ].join(" | ")} |`;

function totalOf(rows: readonly Row[]): string {
  const auto = rows.filter((row) => row.route === "auto");
  const owner = rows.filter((row) => row.route === "owner");
  const unrouted = rows.length - auto.length - owner.length;
  const waits = owner.map((row) => row.ownerWait ?? 0);

  const wait =
    waits.length === 0
      ? `median ${DASH}, sum ${DASH}`
      : `median ${durationOf(medianOf(waits))}, sum ${durationOf(sum(waits))}`;

  const routes = `${auto.length} auto, ${owner.length} owner${unrouted === 0 ? "" : `, ${unrouted} without a Route`}`;

  return [
    `Total: ${prs(rows.length)} landed (${routes}). Owner wait: ${wait}.`,
    `Rounds: ${sum(rows.map((row) => row.rounds))}. Important: ${sum(rows.map((row) => row.found))} found, ${sum(rows.map((row) => row.fixed))} fixed, ${sum(rows.map((row) => row.rejected))} rejected.`,
    `Land approval given more than once: ${prs(rows.filter((row) => row.landOkGiven >= 2).length)}. land:auto PRs reverted: ${auto.filter((row) => row.revertedBy !== null).length}.`,
  ].join("\n");
}

const HEADER = [
  "| PR | Route | Owner wait | Rounds | Important found | fixed | rejected | land-ok given | Reverted by |",
  "|-----|-------|-----------:|-------:|----:|----:|----:|----:|-----|",
].join("\n");

const FOOTNOTE =
  'rejected: an Important thread the Author answered without "Fixed in", read from the threads until #94.';

/** One table per ISO week that holds a row, in order, each followed by its total line, then the footnote. */
export function reportOf(rows: readonly Row[]): string {
  const weeks = new Map<string, { week: Week; rows: Row[] }>();

  for (const row of rows.toSorted((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.number - b.number)) {
    const week = weekOf(row.mergedAt);
    const entry = weeks.get(week.key) ?? { week, rows: [] };

    entry.rows.push(row);
    weeks.set(week.key, entry);
  }

  const tables = [...weeks.values()].map(
    (entry) => `${entry.week.title}\n\n${HEADER}\n${entry.rows.map(lineOf).join("\n")}\n\n${totalOf(entry.rows)}\n\n`,
  );

  return `${tables.join("")}${FOOTNOTE}\n`;
}
