/**
 * GitHub's answers as far as the Merge bot reads them, and what a snapshot takes from each: who opened the
 * PR, who put a label and when, when the App last reviewed, what CI says of a head. Pure readings: the
 * calls that fetch the answers are in `github.ts`.
 */

import { Schema } from "effect";

import { CI_CHECKS, LAND_APPROVAL_LABEL, landLabelOf, MERGE_BOT_STATE_MARKER } from "../../contract.ts";
import { escapeHtml } from "../../lib/markdown.ts";
import type { Ran } from "../../lib/run.port.ts";
import { fixedListOf } from "../shared/author-mark.ts";
import { reviewOfBody } from "../shared/findings.ts";
import type { Env } from "./github.ts";
import type { StateRead } from "./ledger.ts";
import { EMPTY_RECORD, recordOfComment } from "./record.ts";
import { ciOf, landApprovalCounts } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";
import type { CheckState } from "./steps.ts";

/** `repos/<repo>/pulls/<n>`, as far as the Merge bot reads it. */
export const Pull = Schema.Struct({
  number: Schema.Finite,
  node_id: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeable_state: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
});

export type Pull = typeof Pull.Type;

const Login = Schema.Struct({ login: Schema.String });

/** `repos/<repo>/issues/<n>/comments`, as far as the Merge bot reads it. */
export const IssueComments = Schema.Array(
  Schema.Struct({ id: Schema.Finite, user: Schema.NullOr(Login), body: Schema.String }),
);

/** `repos/<repo>/commits/<sha>/check-runs`, as far as the Merge bot reads it. */
export const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      app: Schema.NullOr(Schema.Struct({ slug: Schema.String })),
      check_suite: Schema.Struct({ id: Schema.Finite }),
    }),
  ),
});

/** `repos/<repo>/issues/<n>/events`, as far as the Merge bot reads it. */
export const IssueEvents = Schema.Array(
  Schema.Struct({
    event: Schema.String,
    label: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
    actor: Schema.NullOr(Login),
    created_at: Schema.String,
  }),
);

/** Whether the PR's opener, as REST gives it, is the Owner or the Author's machine account; see `Snapshot["openedByFactory"]`. */
export function openedByFactoryOf(
  login: string | undefined,
  { owner, authorLogin }: { readonly owner: string; readonly authorLogin: string },
): boolean {
  return login === owner || login === authorLogin;
}

const lastLandApprovalOf = (events: typeof IssueEvents.Type) =>
  events.filter((event) => event.event === "labeled" && event.label?.name === LAND_APPROVAL_LABEL).at(-1);

/** Whether the last Land approval label put on the PR was put by `owner`, whenever it was put. */
export function landApprovalPutByOwnerOf(events: typeof IssueEvents.Type, owner: string): boolean {
  return lastLandApprovalOf(events)?.actor?.login === owner;
}

/**
 * Whether the last Land approval label put on the PR was put by `owner` after its head was pushed and
 * after the App's latest review was posted (`landApprovalCounts`).
 */
export function landApprovalByOwnerOf(
  events: typeof IssueEvents.Type,
  owner: string,
  times: { readonly headPushedAt: string | null; readonly reviewedAt: string | null },
): boolean {
  const last = lastLandApprovalOf(events);

  return landApprovalCounts(landApprovalPutByOwnerOf(events, owner), last?.created_at ?? null, times);
}

/**
 * When the App posted its latest review of a round or a Delta read on the PR, the one whose body carries
 * the review's marker, as `reviews` give them; null when it posted none. GitHub lists each reply the App
 * posts in a thread as a review of its own, with no marker: one is no new read, and counts none.
 */
export function latestReviewAtOf(reviews: typeof PullReviews.Type, appLogin: string): string | null {
  const posted = reviews.flatMap((review) =>
    review.user?.login === appLogin && review.submitted_at !== null && reviewOfBody(review.body) !== null
      ? [review.submitted_at]
      : [],
  );

  return posted.toSorted((one, other) => Date.parse(one) - Date.parse(other)).at(-1) ?? null;
}

/** Who set the PR's `land:human`, by its latest `labeled` event; see `Snapshot["humanLabelBy"]`. */
export function humanLabelByOf(
  events: typeof IssueEvents.Type,
  labels: readonly string[],
  { appLogin, authorLogin }: { readonly appLogin: string; readonly authorLogin: string },
): Snapshot["humanLabelBy"] {
  const humanLabel = landLabelOf("owner");

  if (!labels.includes(humanLabel)) {
    return null;
  }

  // A latest event that removed the label, while the PR carries it, is a read that lags its re-add.
  const last = events
    .filter((event) => (event.event === "labeled" || event.event === "unlabeled") && event.label?.name === humanLabel)
    .at(-1);

  if (last?.event !== "labeled") {
    return "other";
  }

  if (last.actor?.login === appLogin) {
    return "merge-bot";
  }

  // The Author's label is an agent's: it sends no PR to the Owner.
  return last.actor?.login === authorLogin ? "author" : "other";
}

/** The answer of `POST repos/<repo>/issues`, as far as the Merge bot reads it. */
export const OpenedIssue = Schema.Struct({ number: Schema.Int });

/** `repos/<repo>/commits/<sha>/check-suites`, as far as the Merge bot reads it. */
export const CheckSuites = Schema.Struct({
  check_suites: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      head_branch: Schema.NullOr(Schema.String),
      created_at: Schema.String,
    }),
  ),
});

/** `repos/<repo>/commits/<sha>/pulls`, as far as the Merge bot reads it. */
export const CommitPulls = Schema.Array(Schema.Struct({ number: Schema.Finite, state: Schema.String }));

/** `gh pr list --json number`. */
export const ListedPrs = Schema.Array(Schema.Struct({ number: Schema.Finite }));

/** `repos/<repo>/actions/runs/<id>`, as far as the Merge bot reads it. */
export const ActionsRun = Schema.Struct({ status: Schema.String, conclusion: Schema.NullOr(Schema.String) });

/** The answer of a workflow dispatch asked with `return_run_details`. */
export const Dispatched = Schema.Struct({ workflow_run_id: Schema.Int });

/** `repos/<repo>/pulls/<n>/reviews`, as far as the Merge bot reads it: `submitted_at` is null while a review is pending. */
export const PullReviews = Schema.Array(
  Schema.Struct({ user: Schema.NullOr(Login), body: Schema.String, submitted_at: Schema.NullOr(Schema.String) }),
);

/**
 * What the PR's conversation holds for the Merge bot: its state comment as a decision reads it, and the
 * threads the Author says it fixed, from the Stop hook's comment.
 */
export interface StateComment extends StateRead {
  readonly fixed: ReadonlySet<string>;
}

/** The state comment of the PR's conversation `comments`; a comment of any other login is not read, since any login can write a mark. */
export function stateCommentIn(
  comments: typeof IssueComments.Type,
  { appLogin, authorLogin }: Pick<Env, "appLogin" | "authorLogin">,
): StateComment {
  const mine = comments.find(
    (comment) => comment.user?.login === appLogin && comment.body.includes(MERGE_BOT_STATE_MARKER),
  );

  const fixed = comments.flatMap((comment) => {
    const listed = comment.user?.login === authorLogin ? fixedListOf(comment.body) : null;

    return listed === null ? [] : [listed];
  })[0];

  return {
    id: mine?.id ?? null,
    body: mine?.body ?? null,
    record: mine === undefined ? EMPTY_RECORD : recordOfComment(mine.body),
    fixed: new Set(fixed),
  };
}

/** The answer of `POST repos/<repo>/issues/<n>/comments`, as far as the Merge bot reads it. */
export const PostedComment = Schema.Struct({ id: Schema.Finite });

/** A `gh api` read GitHub answered 404: the resource is gone. A rate limit, a 5xx or a network error is not. */
export function notFound(read: Ran): boolean {
  return read.code !== 0 && read.stderr.includes("(HTTP 404)");
}

/** The `check-runs` endpoint of each of CI_CHECKS on `sha`. */
export const ciRunsPathsOf = (repo: string, sha: string): readonly string[] =>
  CI_CHECKS.map((name) => `repos/${repo}/commits/${sha}/check-runs?check_name=${name}`);

/** The CI of a head from the check runs of each of CI_CHECKS: GitHub Actions' run of each, as `ciOf` reads them. */
export const ciOfRuns = (runs: ReadonlyArray<typeof CheckRuns.Type>): Snapshot["ci"] =>
  ciOf(runs.map((found) => found.check_runs.find((check) => check.app?.slug === "github-actions")));

/** See `Snapshot["devRed"]`. */
export const devRedOf = (runs: ReadonlyArray<typeof CheckRuns.Type>): boolean => ciOfRuns(runs) === "failure";

/**
 * The runs of `runs` that ran in a suite of a push to `branch`. The merge queue's commit becomes the
 * Trunk's head, so it also carries the queue's suites, whose `mutation` is skipped.
 */
export function pushRunsOf(
  suites: typeof CheckSuites.Type,
  runs: ReadonlyArray<typeof CheckRuns.Type>,
  branch: string,
): ReadonlyArray<typeof CheckRuns.Type> {
  const pushSuites = new Set(
    suites.check_suites.filter((suite) => suite.head_branch === branch).map((suite) => suite.id),
  );

  return runs.map((found) => ({
    check_runs: found.check_runs.filter((check) => pushSuites.has(check.check_suite.id)),
  }));
}

/** The POST body of `repos/<repo>/check-runs`: its Details link opens `runUrl`, the run that posts it. */
export function checkRunBodyOf(name: string, head: string, check: CheckState, runUrl: string): Schema.JsonObject {
  const output = { title: check.summary, summary: escapeHtml(check.summary) };

  return check.kind === "pending"
    ? { name, head_sha: head, status: "in_progress", output, details_url: runUrl }
    : { name, head_sha: head, status: "completed", conclusion: check.kind, output, details_url: runUrl };
}

export type Start =
  { readonly kind: "pr"; readonly number: number } | { readonly kind: "commit-pulls" } | { readonly kind: "sweep" };

/**
 * Which PRs a start serves: the one it names, else on a completed run the open PRs of its commit, else
 * every open PR. CI's completion on a push to the Trunk is a Sweep: the PR that landed is closed, and the others
 * need the Trunk's red, which that run sets.
 */
export function startOf(given: {
  readonly event: string;
  readonly pr?: string | undefined;
  readonly runEvent?: string | undefined;
}): Start {
  const { event, pr, runEvent } = given;

  if (pr !== undefined && pr !== "") {
    return { kind: "pr", number: Number(pr) };
  }

  return event === "workflow_run" && runEvent !== "push" ? { kind: "commit-pulls" } : { kind: "sweep" };
}
