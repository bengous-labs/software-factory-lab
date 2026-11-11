#!/usr/bin/env bun

/**
 * The Merge bot's adapter, run by `.github/workflows/merge-bot.yml` from the default branch with the
 * App's token. Each start makes one Merge bot run for the PR the event names, or, on a Sweep, one for
 * every open PR. A Merge bot run reads a snapshot of its PR, asks `decide.ts`, performs the steps, and
 * decides again after a model step, until no model step is left.
 *
 * Reads GITHUB_REPOSITORY, OWNER (the only GitHub login whose PRs are served), APP_LOGIN, EVENT_NAME, PR_NUMBER,
 * RUN_HEAD_SHA, RUN_EVENT, EJECTION_REASON; calls gh and git, and the models through the Agent SDK. The Code review runs
 * in its own job, `.github/workflows/code-review.yml`, which the Merge bot dispatches and whose artifact it reads.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { escapeHtml } from "../../lib/markdown.ts";
import { tokensText } from "../../lib/tokens.ts";
import { FACTORY_CONFIG_PATH, factoryConfigOf } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import { ask } from "../lib/ask.ts";
import { resolverOf } from "../lib/resolve.ts";
import { checked, run } from "../lib/run.ts";
import { replyInThread, resolveThread } from "../lib/threads.ts";
import type { Reader } from "../ports/ask.ts";
import type { Ran, Run, RunOptions } from "../ports/run.ts";
import {
  graphqlLogin,
  nitPathsOf,
  openImportantOf,
  rejectedImportantOf,
  ReviewThreads,
  threadsQueryOf,
} from "../review/findings.ts";
import type { ReviewThread } from "../review/findings.ts";
import { againRepliesOf, diffArgsOf, diffLinesOf, postPlanOf, reviewMarkerOf, reviewOf } from "../review/post-plan.ts";
import type { AgainReply } from "../review/post-plan.ts";
import { inputsOf, resultOfJson, summaryOf } from "../review/review-report.ts";
import { REVIEW_SETTINGS } from "../review/review-settings.ts";
import { readGuardOf } from "../review/tool-guard.ts";
import { judgeFailed, ROUTING_JUDGE_MODEL, routingJudge } from "../routing/routing-judge.ts";
import type { RoutingVerdict } from "../routing/routing-judge.ts";
import { judgeAskOf, patchDeltaRulesOf, routingOf, routingRulesOf, withNitAnswers } from "../routing/routing-rules.ts";
import type { FileLines, JudgeAsk } from "../routing/routing-rules.ts";
import {
  CI_CHECKS,
  ciOf,
  conflictingOf,
  decide,
  EMPTY_RECORD,
  LAND_APPROVAL_LABEL,
  LAND_GATE,
  landApprovalCounts,
  patchDeltaStart,
  postedFindingsOf,
  recordOfJson,
  REVIEW_CHECK,
  storedLandRouteOf,
  storedOfRecord,
} from "./decide.ts";
import type {
  CheckState,
  LandRoute,
  ReviewDepth,
  ReviewJob,
  ReviewRound,
  ReviewState,
  RoutingAnswer,
  Snapshot,
  StateRecord,
  Step,
} from "./decide.ts";

/** The state record's marker. An external name: existing PR records carry it, so the string stays. */
const MERGE_BOT_STATE_MARKER = "<!-- lab-conductor-state";

const MERGE_BOT_STATE_PATTERN = new RegExp(`${MERGE_BOT_STATE_MARKER} (.*) -->`, "su");

/** Decisions per Merge bot run. */
const MAX_DECISIONS = 4;

/** The review job's workflow file. An external name: the Merge bot dispatches it by this name. */
const REVIEW_WORKFLOW = "code-review.yml";

/** The ref the review job runs from, so its runner, REVIEW.md and AGENTS.md come from the Trunk, never from the PR. */
const TRUNK = "dev";

interface Env {
  readonly repo: string;
  readonly owner: string;
  readonly authorLogin: string;
  readonly appLogin: string;
  readonly cwd: string;
  readonly runUrl: string;
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset`);
  }

  return value;
}

const gh = (env: Env, args: readonly string[], stdin?: string): Promise<string> =>
  checked(run, ["gh", ...args], stdin === undefined ? { cwd: env.cwd } : { cwd: env.cwd, stdin });

const git = async (env: Env, args: readonly string[]): Promise<string> =>
  (await checked(run, ["git", ...args], { cwd: env.cwd })).trim();

const call = (env: Env, method: string, path: string, body?: Schema.JsonObject): Promise<string> =>
  gh(
    env,
    ["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])],
    body === undefined ? undefined : JSON.stringify(body),
  );

/** The endpoint at `path`, read through `runner` and decoded by `schema`. */
const apiWith = async <S extends Schema.ConstraintDecoder<unknown>>(
  runner: Run,
  where: Pick<Env, "cwd">,
  schema: S,
  path: string,
): Promise<S["Type"]> =>
  decodeJson(schema, `gh api ${path}`, await checked(runner, ["gh", "api", "-X", "GET", path], { cwd: where.cwd }));

/** The endpoint at `path`, decoded by `schema`. */
const api = <S extends Schema.ConstraintDecoder<unknown>>(env: Env, schema: S, path: string): Promise<S["Type"]> =>
  apiWith(run, env, schema, path);

/** Sends `body` to the endpoint at `path`; what it answers is not read. */
const send = async (env: Env, method: string, path: string, body?: Schema.JsonObject): Promise<void> => {
  await call(env, method, path, body);
};

const graphql = async <S extends Schema.ConstraintDecoder<unknown>>(
  env: Env,
  schema: S,
  query: string,
  variables: Readonly<Record<string, string>>,
): Promise<S["Type"]> => decodeJson(schema, "gh api graphql", await call(env, "POST", "graphql", { query, variables }));

/** Runs a GraphQL mutation; what it answers is not read. */
const mutate = (env: Env, query: string, variables: Readonly<Record<string, string>>): Promise<void> =>
  send(env, "POST", "graphql", { query, variables });

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

type Pull = typeof Pull.Type;

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

/** Whether the last Land approval label put on the PR was put by `owner` after its head was pushed. */
export function landApprovalByOwnerOf(
  events: typeof IssueEvents.Type,
  owner: string,
  headPushedAt: string | null,
): boolean {
  const last = lastLandApprovalOf(events);

  return landApprovalCounts(landApprovalPutByOwnerOf(events, owner), last?.created_at ?? null, headPushedAt);
}

/** Who set the PR's `land:human`, by its latest `labeled` event; see `Snapshot["humanLabelBy"]`. */
export function humanLabelByOf(
  events: typeof IssueEvents.Type,
  labels: readonly string[],
  { appLogin, authorLogin }: { readonly appLogin: string; readonly authorLogin: string },
): Snapshot["humanLabelBy"] {
  const humanLabel = `land:${storedLandRouteOf("owner")}`;

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

/** Every page of `repos/<repo>/issues/<n>/events`: past 100 events, the latest `labeled` is on a later page. */
export function labelEventsReader(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number) => Promise<typeof IssueEvents.Type> {
  return async (where, pr) => {
    const path = `repos/${where.repo}/issues/${pr}/events?per_page=100`;
    const out = await checked(runner, ["gh", "api", "-X", "GET", "--paginate", "--slurp", path], { cwd: where.cwd });

    return decodeJson(Schema.Array(IssueEvents), `gh api ${path}`, out).flat();
  };
}

const labelEventsOf = labelEventsReader(run);

/** Posts `body` as a new comment on the PR: GitHub notifies a new comment, never an edit. */
export function ownerCommenter(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">, pr: number, body: string) => Promise<void> {
  return async (where, pr, body) => {
    const path = `repos/${where.repo}/issues/${pr}/comments`;

    await checked(runner, ["gh", "api", "-X", "POST", path, "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify({ body }),
    });
  };
}

const postOwnerComment = ownerCommenter(run);

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

/** `repos/<repo>/pulls/<n>/reviews`, as far as the Merge bot reads it. */
export const PullReviews = Schema.Array(Schema.Struct({ user: Schema.NullOr(Login), body: Schema.String }));

async function threadsOf(env: Env, pr: number): Promise<readonly ReviewThread[]> {
  const [owner, name] = env.repo.split("/");
  const out = await graphql(env, ReviewThreads, threadsQueryOf(pr), { owner: owner ?? "", name: name ?? "" });

  return out.data.repository.pullRequest.reviewThreads.nodes;
}

/** The PR from the single-PR endpoint, read again up to three times while GitHub has not computed its mergeability yet. */
async function pullOf(env: Env, number: number): Promise<Pull> {
  let pr = await api(env, Pull, `repos/${env.repo}/pulls/${number}`);

  for (let tries = 0; tries < 3 && pr.state === "open" && pr.mergeable === null; tries += 1) {
    await Bun.sleep(5000);
    pr = await api(env, Pull, `repos/${env.repo}/pulls/${number}`);
  }

  return pr;
}

async function recordOf(env: Env, pr: number): Promise<{ id: number | null; record: StateRecord }> {
  const comments = await api(env, IssueComments, `repos/${env.repo}/issues/${pr}/comments?per_page=100`);

  const mine = comments.find(
    (comment) => comment.user?.login === env.appLogin && comment.body.includes(MERGE_BOT_STATE_MARKER),
  );

  if (mine === undefined) {
    return { id: null, record: EMPTY_RECORD };
  }

  const json = MERGE_BOT_STATE_PATTERN.exec(mine.body)?.[1];

  return { id: mine.id, record: json === undefined ? EMPTY_RECORD : recordOfJson(json) };
}

async function writeRecord(env: Env, pr: number, id: number | null, record: StateRecord): Promise<void> {
  const body = `Merge bot state for this PR. Do not edit.\n\n${MERGE_BOT_STATE_MARKER} ${JSON.stringify(storedOfRecord(record))} -->`;

  if (id === null) {
    await send(env, "POST", `repos/${env.repo}/issues/${pr}/comments`, { body });
  } else {
    await send(env, "PATCH", `repos/${env.repo}/issues/comments/${id}`, { body });
  }
}

interface Range {
  readonly base: string;
  readonly head: string;
}

/** The refspecs `rangeOf` fetches: the PR's head, its base and the Trunk, whose head `devRunsReader` reads. */
export function rangeRefspecsOf(pr: Pick<Pull, "number" | "base">): readonly string[] {
  const branches = pr.base.ref === TRUNK ? [TRUNK] : [pr.base.ref, TRUNK];

  return [
    `+refs/pull/${pr.number}/head:refs/lab/pr-${pr.number}`,
    ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
  ];
}

async function rangeOf(env: Env, pr: Pull): Promise<Range> {
  await git(env, ["fetch", "--quiet", "origin", ...rangeRefspecsOf(pr)]);

  return { base: await git(env, ["merge-base", `origin/${pr.base.ref}`, pr.head.sha]), head: pr.head.sha };
}

async function patchOf(env: Env, range: Range): Promise<string> {
  const diff = await git(env, ["diff", `${range.base}..${range.head}`]);

  if (diff === "") {
    return "empty";
  }

  const ran = await run(["git", "patch-id", "--stable"], { cwd: env.cwd, stdin: `${diff}\n` });

  return ran.stdout.split(" ")[0] ?? "empty";
}

/** A `gh api` read GitHub answered 404: the resource is gone. A rate limit, a 5xx or a network error is not. */
export function notFound(read: Ran): boolean {
  return read.code !== 0 && read.stderr.includes("(HTTP 404)");
}

/** The output of `gh api <path>`, or null when GitHub answers 404; any other failure throws. */
async function readOrGone(runner: Run, where: Pick<Env, "repo" | "cwd">, path: string): Promise<string | null> {
  const read = await runner(["gh", "api", path], { cwd: where.cwd });

  if (notFound(read)) {
    return null;
  }

  if (read.code !== 0) {
    throw new Error(`gh api ${path} exited ${read.code}: ${(read.stderr || read.stdout).trim()}`);
  }

  return read.stdout;
}

/** The result in the artifact `name` of run `runId`, or null when there is none or it does not read. */
async function artifactOf(runner: Run, where: Pick<Env, "repo" | "cwd">, runId: number, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "review-result-"));

  const downloaded = await runner(
    ["gh", "run", "download", String(runId), "--repo", where.repo, "--name", name, "--dir", dir],
    { cwd: where.cwd },
  );

  const file = join(dir, "review-result.json");

  return downloaded.code === 0 && existsSync(file) ? resultOfJson(readFileSync(file, "utf8")) : null;
}

/**
 * The run of the review the record asked, and, once it completed, the result of its artifact. Read on
 * every decision for the PR: the run's `workflow_run` event only wakes the Merge bot, and a wake can be
 * lost. A request for another patch is cleared without its run. A run GitHub answers 404 for
 * is `missing`, and the decision asks the review again; any other failed read throws, as every read of
 * the decision does. A run with no artifact, or one that does not read, has a null result.
 */
export function reviewJobReader(
  runner: Run,
): (
  where: Pick<Env, "repo" | "cwd">,
  pr: number,
  review: ReviewState | undefined,
  patch: string,
) => Promise<ReviewJob | null> {
  return async (where, pr, review, patch) => {
    if (review === undefined || review.patch !== patch) {
      return null;
    }

    const path = `repos/${where.repo}/actions/runs/${review.runId}`;
    const named = await readOrGone(runner, where, path);

    if (named === null) {
      return { kind: "missing" };
    }

    const reviewRun = decodeJson(ActionsRun, `gh api ${path}`, named);

    if (reviewRun.status !== "completed") {
      return { kind: "running" };
    }

    return {
      kind: "completed",
      conclusion: reviewRun.conclusion ?? "no conclusion",
      result: await artifactOf(runner, where, review.runId, `review-${pr}-${review.round}`),
    };
  };
}

const reviewJobOf = reviewJobReader(run);

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

/** The push runs of each of CI_CHECKS on the Trunk's head, as `rangeOf` fetched it. */
export function devRunsReader(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd">) => Promise<ReadonlyArray<typeof CheckRuns.Type>> {
  return async (where) => {
    const devHead = (await checked(runner, ["git", "rev-parse", `origin/${TRUNK}`], { cwd: where.cwd })).trim();

    const [suites, runs] = await Promise.all([
      apiWith(runner, where, CheckSuites, `repos/${where.repo}/commits/${devHead}/check-suites?per_page=100`),
      Promise.all(ciRunsPathsOf(where.repo, devHead).map((path) => apiWith(runner, where, CheckRuns, path))),
    ]);

    return pushRunsOf(suites, runs, TRUNK);
  };
}

const devRunsOf = devRunsReader(run);

async function snapshotOf(
  env: Env,
  pr: Pull,
  range: Range,
  record: StateRecord,
  threads: readonly ReviewThread[],
): Promise<Snapshot> {
  const [ciRuns, devRuns] = await Promise.all([
    Promise.all(ciRunsPathsOf(env.repo, pr.head.sha).map((path) => api(env, CheckRuns, path))),
    devRunsOf(env),
  ]);

  const patch = await patchOf(env, range);
  const empty = (await pathsListed(env, changedPathsArgs(range.base, range.head))).length === 0;
  const labels = pr.labels.map((label) => label.name);
  const humanLabel = `land:${storedLandRouteOf("owner")}`;

  const events =
    labels.includes(LAND_APPROVAL_LABEL) || labels.includes(humanLabel) ? await labelEventsOf(env, pr.number) : [];

  let landApprovalByOwner = false;
  let landApprovalPutByOwner = false;

  if (labels.includes(LAND_APPROVAL_LABEL)) {
    // The head's first check suite is created when it is pushed: a Land approval put before that was given for another head.
    const suites = await api(env, CheckSuites, `repos/${env.repo}/commits/${pr.head.sha}/check-suites?per_page=100`);

    const pushedAt = suites.check_suites.map((suite) => suite.created_at).toSorted()[0] ?? null;
    landApprovalByOwner = landApprovalByOwnerOf(events, env.owner, pushedAt);
    landApprovalPutByOwner = landApprovalPutByOwnerOf(events, env.owner);
  }

  return {
    number: pr.number,
    state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
    sameRepository: pr.head.repo?.full_name === env.repo,
    openedByFactory: openedByFactoryOf(pr.user?.login, env),
    openedByAuthor: pr.user?.login === env.authorLogin,
    draft: pr.draft,
    head: pr.head.sha,
    patch,
    empty,
    ci: ciOfRuns(ciRuns),
    labels,
    humanLabelBy: humanLabelByOf(events, labels, env),
    landApprovalByOwner,
    landApprovalPutByOwner,
    openImportant: openImportantOf(graphqlLogin(env.appLogin), threads),
    rejectedImportant: rejectedImportantOf(
      { app: graphqlLogin(env.appLogin), author: env.authorLogin, owner: env.owner },
      threads,
    ),
    devRed: devRedOf(devRuns),
    conflicting: conflictingOf(pr.mergeable_state),
    record,
    now: new Date().toISOString(),
    reviewJob: await reviewJobOf(env, pr.number, record.review, patch),
  };
}

/** The POST body of `repos/<repo>/check-runs`: its Details link opens `runUrl`, the run that posts it. */
export function checkRunBodyOf(name: string, head: string, check: CheckState, runUrl: string): Schema.JsonObject {
  const output = { title: check.summary, summary: escapeHtml(check.summary) };

  return check.kind === "pending"
    ? { name, head_sha: head, status: "in_progress", output, details_url: runUrl }
    : { name, head_sha: head, status: "completed", conclusion: check.kind, output, details_url: runUrl };
}

export function checkSetter(
  runner: Run,
): (where: Pick<Env, "repo" | "cwd" | "runUrl">, name: string, head: string, check: CheckState) => Promise<void> {
  return async (where, name, head, check) => {
    await checked(runner, ["gh", "api", "-X", "POST", `repos/${where.repo}/check-runs`, "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify(checkRunBodyOf(name, head, check, where.runUrl)),
    });
  };
}

const setCheck = checkSetter(run);

const TO_DRAFT = "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}";

/** Sends the PR whose node id is `nodeId` back to draft. */
export function draftConverter(runner: Run): (where: Pick<Env, "cwd">, nodeId: string) => Promise<void> {
  return async (where, nodeId) => {
    await checked(runner, ["gh", "api", "-X", "POST", "graphql", "--input", "-"], {
      cwd: where.cwd,
      stdin: JSON.stringify({ query: TO_DRAFT, variables: { id: nodeId } }),
    });
  };
}

const convertToDraft = draftConverter(run);

/** Resolves each review thread of `threads`, as the App. */
export function threadsResolver(runner: Run): (where: Pick<Env, "cwd">, threads: readonly string[]) => Promise<void> {
  return async (where, threads) => {
    for (const thread of threads) {
      await resolveThread(runner, { cwd: where.cwd }, thread);
    }
  };
}

const resolveThreads = threadsResolver(run);

/** Posts each reply in its review thread, as the App. */
export function againPoster(runner: Run): (where: Pick<Env, "cwd">, replies: readonly AgainReply[]) => Promise<void> {
  return async (where, replies) => {
    for (const reply of replies) {
      await replyInThread(runner, { cwd: where.cwd }, reply.thread, reply.body);
    }
  };
}

const postAgain = againPoster(run);

/** Sets the `land:*` and `review:*` labels. Their names are external: open PRs carry them, so the strings stay. */
async function setLabels(env: Env, pr: Pull, landRoute: LandRoute, depth: ReviewDepth): Promise<void> {
  const wanted = [`land:${storedLandRouteOf(landRoute)}`, `review:${depth}`];
  const current = pr.labels.map((label) => label.name);
  const stale = current.filter((name) => /^(land|review):/u.test(name) && !wanted.includes(name));
  const missing = wanted.filter((name) => !current.includes(name));

  for (const name of stale) {
    await send(env, "DELETE", `repos/${env.repo}/issues/${pr.number}/labels/${encodeURIComponent(name)}`);
  }

  if (missing.length > 0) {
    await send(env, "POST", `repos/${env.repo}/issues/${pr.number}/labels`, { labels: missing });
  }
}

/**
 * Where the range read starts: for a Patch delta, the head the last review read, while it is still an
 * ancestor of this head; else the merge base. A rebase leaves that head out of the PR's history, and
 * the Patch delta is then the whole PR again.
 */
async function rangeStart(env: Env, range: Range, record: StateRecord, patchDelta: boolean): Promise<string> {
  if (!patchDelta || record.reviewedHead === null) {
    return range.base;
  }

  const ancestor = await run(["git", "merge-base", "--is-ancestor", record.reviewedHead, range.head], { cwd: env.cwd });

  return patchDeltaStart(range.base, record.reviewedHead, ancestor.code);
}

/** The arguments of a `git diff` that lists every path a range touches: renames split, so a moved file lists both its paths. */
export const changedPathsArgs = (from: string, to: string): readonly string[] => [
  "diff",
  "--name-only",
  "--no-renames",
  `${from}..${to}`,
];

/** The arguments of a `git diff` that lists the paths a range deletes, renames split as in `changedPathsArgs`. */
export const deletedPathsArgs = (from: string, to: string): readonly string[] => [
  "diff",
  "--name-only",
  "--no-renames",
  "--diff-filter=D",
  `${from}..${to}`,
];

/** The arguments of the `git diff` the Routing judge reads, its `--stat` or its patch, over the whole range. */
export const judgeDiffArgs = (from: string, to: string, stat: boolean): readonly string[] => [
  "diff",
  ...(stat ? ["--stat"] : []),
  `${from}..${to}`,
];

/** The routing policy of the factory config in `checkout`: the Merge bot's own checkout of the Trunk, never a PR's head. */
export function routingPolicyAt(checkout: string): RoutingPolicy {
  return factoryConfigOf(readFileSync(join(checkout, FACTORY_CONFIG_PATH), "utf8")).land.routing;
}

const pathsListed = async (env: Env, args: readonly string[]): Promise<readonly string[]> =>
  (await git(env, args)).split("\n").filter((path) => path !== "");

/** The arguments of the `git diff --numstat` that counts the lines a range changes. */
export const numstatArgs = (from: string, to: string): readonly string[] => ["diff", "--numstat", `${from}..${to}`];

/** The lines a `git diff --numstat` output counts, added and deleted; a binary file's `-` counts none. */
export const linesOfNumstat = (numstat: string): number =>
  numstat.split("\n").reduce(
    (sum, row) =>
      sum +
      row
        .split("\t")
        .slice(0, 2)
        .reduce((acc, n) => acc + (Number(n) || 0), 0),
    0,
  );

const linesChanged = async (env: Env, from: string, to: string): Promise<number> =>
  linesOfNumstat(await git(env, numstatArgs(from, to)));

/** The arguments of the `git diff --numstat` that counts each file's lines, renames split as in `changedPathsArgs`. */
export const fileLinesArgs = (from: string, to: string): readonly string[] => [
  "diff",
  "--numstat",
  "--no-renames",
  "-z",
  `${from}..${to}`,
];

const countOf = (n: string): number | null => (n === "-" ? null : Number(n));

/** The lines each file of a `fileLinesArgs` output adds and removes; a binary file's `-` counts null. */
export const fileLinesOfNumstat = (numstat: string): readonly FileLines[] =>
  numstat
    .split("\0")
    .filter((row) => row !== "")
    .map((row) => {
      const [added = "", removed = "", ...path] = row.split("\t");

      return { path: path.join("\t"), added: countOf(added), removed: countOf(removed) };
    });

/** Whether a Review round reads the Patch delta, from the head the last round read: every round after the first. */
export const readsPatchDelta = (round: ReviewRound): boolean => round >= 2;

type JobEnv = Readonly<Partial<Record<string, string>>>;

/** The Routing judge's whole environment, from the job's: its PATH, HOME and model token, and no GitHub token. */
export function judgeEnvOf(job: JobEnv, configDir: string) {
  const of = (name: string): string => {
    const value = job[name];

    if (value === undefined || value === "") {
      throw new Error(`${name} is unset`);
    }

    return value;
  };

  return {
    PATH: of("PATH"),
    HOME: of("HOME"),
    CLAUDE_CODE_OAUTH_TOKEN: of("CLAUDE_CODE_OAUTH_TOKEN"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: configDir,
  };
}

interface Checkout {
  readonly run: Run;
  /** The Merge bot's checkout, which holds the PR's head. */
  readonly cwd: string;
  readonly head: string;
}

/**
 * The git of the worktree's checkout, in a job that holds the App's token: no system or global config,
 * so no filter driver a PR's `.gitattributes` names runs, the LFS one the runner installs included, and
 * no hook.
 */
const CHECKOUT_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

const worktreeAt = (checkout: Checkout): RunOptions => ({ cwd: checkout.cwd, env: CHECKOUT_GIT_ENV });

/**
 * `read` over a worktree of the PR's head at `tree`, removed after it. A failed removal neither hides
 * `read`'s error nor drops its answer: `judgeAt` deletes the tree's files and prunes its registration.
 */
async function inWorktree<T>(checkout: Checkout, tree: string, read: (root: string) => Promise<T>): Promise<T> {
  await checked(checkout.run, ["git", "worktree", "add", "--detach", tree, checkout.head], worktreeAt(checkout));

  try {
    return await read(realpathSync(tree));
  } finally {
    await checkout.run(["git", "worktree", "remove", "--force", tree], worktreeAt(checkout));
  }
}

/**
 * The Routing judge's answer when `question` asks it, else null. The judge reads a worktree of the PR's
 * head, made for the call and removed after it, under the read guard. A worktree or an environment that
 * cannot be made, or a call that throws, answers the safe side, so one PR never stops a Sweep.
 */
export async function judgeAt(
  question: JudgeAsk,
  checkout: Checkout,
  job: JobEnv,
  judge: (reader: Reader) => Promise<RoutingVerdict>,
): Promise<RoutingVerdict | null> {
  if (question.kind === "none") {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), "routing-judge-"));
  const configDir = join(dir, "config");

  try {
    return await inWorktree(checkout, join(dir, "pr"), (root) => {
      mkdirSync(configDir);

      return judge({
        cwd: root,
        guard: readGuardOf({ root, resolve: resolverOf(root) }),
        env: judgeEnvOf(job, configDir),
      });
    });
  } catch (error) {
    return {
      routing: judgeFailed(error instanceof Error ? error.message : String(error), ROUTING_JUDGE_MODEL),
      tokens: null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await checkout.run(["git", "worktree", "prune"], worktreeAt(checkout));
  }
}

async function route(
  env: Env,
  range: Range,
  record: StateRecord,
  { patchDelta, pr }: { readonly patchDelta: boolean; readonly pr: number },
): Promise<{ readonly answer: RoutingAnswer; readonly judge: RoutingVerdict | null }> {
  const policy = routingPolicyAt(env.cwd);
  const from = await rangeStart(env, range, record, patchDelta);
  const paths = await pathsListed(env, changedPathsArgs(range.base, range.head));
  const deletedPaths = await pathsListed(env, deletedPathsArgs(range.base, range.head));
  const lines = await linesChanged(env, range.base, range.head);

  const messages = (await git(env, ["log", "--format=%B%x00", `${range.base}..${range.head}`]))
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");

  const rules = routingRulesOf(policy, { paths, lines, deletedPaths, messages });

  // The Routing rules hold the labels of the whole PR; whether this Patch delta is read again is its own
  // question, on its own paths and lines. A breaking commit is judged on the whole PR.
  const delta = patchDelta
    ? {
        paths: await pathsListed(env, changedPathsArgs(from, range.head)),
        lines: await linesChanged(env, from, range.head),
        fileLines: fileLinesOfNumstat(await git(env, fileLinesArgs(from, range.head))),
        deletedPaths: await pathsListed(env, deletedPathsArgs(from, range.head)),
        messages: [],
      }
    : null;

  const patchDeltaRules = delta === null ? null : patchDeltaRulesOf(policy, delta);

  const question = judgeAskOf(rules, patchDeltaRules);

  const judge = await judgeAt(question, { run, cwd: env.cwd, head: range.head }, process.env, async (reader) =>
    routingJudge(
      ask,
      reader,
      await git(env, judgeDiffArgs(from, range.head, true)),
      await git(env, judgeDiffArgs(from, range.head, false)),
      patchDelta,
    ),
  );

  const answer = routingOf(rules, patchDeltaRules, judge?.routing ?? null);

  if (delta === null) {
    return { answer, judge };
  }

  const nitPaths = nitPathsOf(
    graphqlLogin(env.appLogin),
    { patch: record.reviewedPatch, round: record.reviewRounds },
    await threadsOf(env, pr),
  );

  return { answer: withNitAnswers(policy, answer, delta, { record, deltaFrom: from, nitPaths }), judge };
}

/** The log line of a route; the Routing judge's tokens close it when the judge was asked. */
export function routingLineOf(pr: number, patch: string, answer: RoutingAnswer, judge: RoutingVerdict | null): string {
  const line = `#${pr} routing ${patch.slice(0, 8)}: route:${answer.land} review:${answer.review} second:${answer.secondRound} by ${answer.model ?? "the Routing rules"} (${answer.reason})`;

  return judge === null ? line : `${line} ${tokensText(judge.tokens)}`;
}

// oxlint-disable-next-line typescript/consistent-return -- the switch covers every Step kind, so no path reaches the end.
async function perform(
  env: Env,
  pr: Pull,
  range: Range,
  recordId: number | null,
  record: StateRecord,
  step: Step,
  log: (line: string) => void,
): Promise<StateRecord | null> {
  switch (step.kind) {
    case "route": {
      const { answer, judge } = await route(env, range, record, { patchDelta: step.patchDelta, pr: pr.number });
      log(routingLineOf(pr.number, step.patch, answer, judge));
      const next = { ...record, triage: { ...record.triage, [step.patch]: answer } };
      await writeRecord(env, pr.number, recordId, next);

      return next;
    }

    case "request-review": {
      const patch = await patchOf(env, range);
      const base = await rangeStart(env, range, record, readsPatchDelta(step.reviewRound));

      const request = {
        pr: pr.number,
        head: range.head,
        base,
        patch,
        round: step.reviewRound,
        ...REVIEW_SETTINGS[step.depth],
        security: step.security,
      };

      const path = `repos/${env.repo}/actions/workflows/${REVIEW_WORKFLOW}/dispatches`;
      const body = { ref: TRUNK, inputs: inputsOf(request), return_run_details: true };
      const { workflow_run_id: runId } = decodeJson(Dispatched, `gh api ${path}`, await call(env, "POST", path, body));

      log(
        `#${pr.number} review round ${step.reviewRound} at ${step.depth} (${request.model}, ${request.effort}): run ${runId}`,
      );

      // The record after the dispatch: a dispatch that fails leaves no request behind.
      const next: StateRecord = {
        ...record,
        review: { kind: "requested", patch, round: step.reviewRound, runId, at: new Date().toISOString() },
      };

      await writeRecord(env, pr.number, recordId, next);

      return next;
    }

    case "post-review": {
      const { result } = step;
      const reviews = await api(env, PullReviews, `repos/${env.repo}/pulls/${pr.number}/reviews?per_page=100`);
      const marker = reviewMarkerOf(result.request);
      const posted = reviews.some((review) => review.user?.login === env.appLogin && review.body.includes(marker));

      if (!posted) {
        try {
          const diff = await git(env, diffArgsOf(range.base, range.head));
          const plan = postPlanOf(postedFindingsOf(result, step.heldOpen), diffLinesOf(diff));

          await send(env, "POST", `repos/${env.repo}/pulls/${pr.number}/reviews`, reviewOf(plan, result, range.head));
        } catch (error) {
          // No fallback to the body: a finding posted with no thread would block nothing.
          const summary = `The review could not be posted: ${String(error).slice(0, 300)}`;
          await setCheck(env, REVIEW_CHECK, pr.head.sha, { kind: "failure", summary });
          log(`#${pr.number} ${summary}`);

          return null;
        }
      }

      if (step.heldOpen.length > 0) {
        const threads = await threadsOf(env, pr.number);

        await postAgain(env, againRepliesOf(result, step.heldOpen, threads, graphqlLogin(env.appLogin)));
      }

      log(`#${pr.number} ${summaryOf(result)}${posted ? ", posted before" : ""}`);

      return record;
    }

    case "resolve-threads": {
      await resolveThreads(env, step.threads);
      log(`#${pr.number} resolved ${step.threads.length} Important thread(s)`);

      return record;
    }

    case "to-draft": {
      await convertToDraft(env, pr.node_id);

      return record;
    }

    case "labels": {
      await setLabels(env, pr, step.route, step.depth);

      return record;
    }

    case "review-check": {
      await setCheck(env, REVIEW_CHECK, pr.head.sha, step.check);

      return record;
    }

    case "land-gate": {
      await setCheck(env, LAND_GATE, pr.head.sha, step.check);

      return record;
    }

    case "record": {
      await writeRecord(env, pr.number, recordId, step.record);

      return step.record;
    }

    case "remove-land-approval": {
      await send(env, "DELETE", `repos/${env.repo}/issues/${pr.number}/labels/${LAND_APPROVAL_LABEL}`);

      return record;
    }

    case "owner-comment": {
      await postOwnerComment(env, pr.number, step.body);

      return record;
    }

    case "auto-merge": {
      try {
        await mutate(
          env,
          "mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){clientMutationId}}",
          { id: pr.node_id },
        );
      } catch (error) {
        log(`#${pr.number} auto-merge: ${String(error).slice(0, 200)}`);
      }

      return record;
    }
  }
}

async function advance(
  env: Env,
  number: number,
  ejectionReason: string | null,
  log: (line: string) => void,
): Promise<void> {
  for (let decisions = 0; decisions < MAX_DECISIONS; decisions += 1) {
    const pr = await pullOf(env, number);

    if (pr.state !== "open") {
      log(`#${number} is ${pr.merged ? "merged" : "closed"}`);

      return;
    }

    const range = await rangeOf(env, pr);
    const { id, record: stored } = await recordOf(env, number);

    const record =
      ejectionReason !== null && decisions === 0
        ? { ...stored, dequeued: { head: pr.head.sha, reason: ejectionReason } }
        : stored;

    const decision = decide(await snapshotOf(env, pr, range, record, await threadsOf(env, number)));

    if (decision.kind === "ignore") {
      log(decision.reason);

      return;
    }

    log(`#${number} steps: ${decision.steps.map((step) => step.kind).join(", ")}`);
    let current: StateRecord | null = record;
    let decideAgain = false;

    if (record !== stored) {
      await writeRecord(env, number, id, record);
    }

    for (const step of decision.steps) {
      current = await perform(env, pr, range, (await recordOf(env, number)).id, current, step, log);

      if (current === null) {
        return;
      }

      if (step.kind === "route" || step.kind === "post-review") {
        decideAgain = true;
      }
    }

    if (!decideAgain) {
      return;
    }
  }
}

export type Start =
  { readonly kind: "pr"; readonly number: number } | { readonly kind: "commit-pulls" } | { readonly kind: "sweep" };

/**
 * Which PRs a start serves: the one it names, else on a completed run the open PRs of its commit, else
 * every open PR. CI's completion on a push to dev is a Sweep: the PR that landed is closed, and the others
 * need dev's red, which that run sets.
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

async function numbersOf(env: Env): Promise<number[]> {
  const start = startOf({
    event: required("EVENT_NAME"),
    pr: process.env["PR_NUMBER"],
    runEvent: process.env["RUN_EVENT"],
  });

  if (start.kind === "pr") {
    return [start.number];
  }

  if (start.kind === "commit-pulls") {
    const sha = required("RUN_HEAD_SHA");
    const listed = await api(env, CommitPulls, `repos/${env.repo}/commits/${sha}/pulls`);

    return listed.filter((found) => found.state === "open").map((found) => found.number);
  }

  const open = decodeJson(
    ListedPrs,
    "gh pr list",
    await gh(env, ["pr", "list", "--repo", env.repo, "--state", "open", "--json", "number"]),
  );

  return open.map((found) => found.number);
}

if (import.meta.main) {
  const env: Env = {
    repo: required("GITHUB_REPOSITORY"),
    owner: required("OWNER"),
    authorLogin: required("AUTHOR_LOGIN"),
    appLogin: required("APP_LOGIN"),
    cwd: process.cwd(),
    runUrl: `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`,
  };

  const reason = process.env["EJECTION_REASON"];

  for (const number of await numbersOf(env)) {
    await advance(env, number, reason === undefined || reason === "" ? null : reason, (line) => {
      console.log(`merge-bot: ${line}`);
    });
  }
}
