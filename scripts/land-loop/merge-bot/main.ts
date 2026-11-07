#!/usr/bin/env bun

/**
 * The Merge bot's adapter, run by `.github/workflows/merge-bot.yml` from the default branch with the
 * App's token. Each start makes one Merge bot run for the PR the event names, or, on a Sweep, one for
 * every open PR. A Merge bot run reads a snapshot of its PR, asks `decide.ts`, performs the steps, and
 * decides again after a model step, until no model step is left.
 *
 * Reads GITHUB_REPOSITORY, OWNER (the only GitHub login whose PRs are served), APP_LOGIN, EVENT_NAME, PR_NUMBER,
 * RUN_HEAD_SHA, EJECTION_REASON; calls gh and git, and the models through the Agent SDK. The Code review runs
 * in its own job, `.github/workflows/code-review.yml`, which the Merge bot dispatches and whose artifact it reads.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { FACTORY_CONFIG_PATH, factoryConfigOf } from "../factory-config.ts";
import type { RoutingPolicy } from "../factory-config.ts";
import { ask } from "../lib/ask.ts";
import { checked, run } from "../lib/run.ts";
import type { Ran, Run } from "../ports/run.ts";
import { graphqlLogin, openImportantOf, ReviewThreads, threadsQueryOf } from "../review/findings.ts";
import type { ReviewThread } from "../review/findings.ts";
import { diffArgsOf, diffLinesOf, postPlanOf, reviewMarkerOf, reviewOf } from "../review/post-plan.ts";
import { PRINCIPAL_JUDGE_MODEL, principalJudge, promptOf as principalJudgePrompt } from "../review/principal-judge.ts";
import { inputsOf, resultOfJson, summaryOf } from "../review/review-report.ts";
import { REVIEW_SETTINGS } from "../review/review-settings.ts";
import { routingJudge } from "../routing/routing-judge.ts";
import { judgedRouting, routingRulesOf } from "../routing/routing-rules.ts";
import {
  afterPrincipalJudge,
  afterReview,
  CI_CHECKS,
  ciOf,
  conflictingOf,
  decide,
  EMPTY_RECORD,
  LAND_APPROVAL_LABEL,
  LAND_GATE,
  landApprovalCounts,
  patchDeltaStart,
  PRINCIPAL_JUDGE_TRIES,
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
  ReviewState,
  RoutingAnswer,
  Snapshot,
  StateRecord,
  Step,
} from "./decide.ts";

/** The state record's marker. An external name: existing PR records carry it, so the string stays. */
const MERGE_BOT_STATE_MARKER = "<!-- lab-conductor-state";

const MERGE_BOT_STATE_PATTERN = new RegExp(`${MERGE_BOT_STATE_MARKER} (.*) -->`, "su");

/** The label that sends the change to the Owner. An external name: open PRs carry it, so the string stays. */
const NEEDS_OWNER_LABEL = "needs-human";

/** Decisions per Merge bot run. */
const MAX_DECISIONS = 4;

/** The review job's workflow file. An external name: the Merge bot dispatches it by this name. */
const REVIEW_WORKFLOW = "code-review.yml";

/** The ref the review job runs from, so its runner, REVIEW.md and AGENTS.md come from the Trunk, never from the PR. */
const TRUNK = "dev";

interface Env {
  readonly repo: string;
  readonly owner: string;
  readonly appLogin: string;
  readonly cwd: string;
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

/** The endpoint at `path`, decoded by `schema`. */
const api = async <S extends Schema.ConstraintDecoder<unknown>>(
  env: Env,
  schema: S,
  path: string,
): Promise<S["Type"]> => decodeJson(schema, `gh api ${path}`, await call(env, "GET", path));

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

/** Whether the last Land approval label put on the PR was put by `owner` after its head was pushed. */
export function landApprovalByOwnerOf(
  events: typeof IssueEvents.Type,
  owner: string,
  headPushedAt: string | null,
): boolean {
  const last = events.filter((event) => event.event === "labeled" && event.label?.name === LAND_APPROVAL_LABEL).at(-1);

  return landApprovalCounts(last?.actor?.login === owner, last?.created_at ?? null, headPushedAt);
}

/** `repos/<repo>/commits/<sha>/check-suites`, as far as the Merge bot reads it. */
export const CheckSuites = Schema.Struct({ check_suites: Schema.Array(Schema.Struct({ created_at: Schema.String })) });

/** `repos/<repo>/actions/runs`, as far as the Merge bot reads it. */
export const WorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ conclusion: Schema.NullOr(Schema.String) })),
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

async function rangeOf(env: Env, pr: Pull): Promise<Range> {
  await git(env, [
    "fetch",
    "--quiet",
    "origin",
    `+refs/pull/${pr.number}/head:refs/lab/pr-${pr.number}`,
    `+refs/heads/${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`,
  ]);

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

async function snapshotOf(
  env: Env,
  pr: Pull,
  range: Range,
  record: StateRecord,
  threads: readonly ReviewThread[],
): Promise<Snapshot> {
  const ciRuns = await Promise.all(ciRunsPathsOf(env.repo, pr.head.sha).map((path) => api(env, CheckRuns, path)));

  const patch = await patchOf(env, range);
  const labels = pr.labels.map((label) => label.name);
  let landApprovalByOwner = false;

  if (labels.includes(LAND_APPROVAL_LABEL)) {
    const events = await api(env, IssueEvents, `repos/${env.repo}/issues/${pr.number}/events?per_page=100`);

    // The head's first check suite is created when it is pushed: a Land approval put before that was given for another head.
    const suites = await api(env, CheckSuites, `repos/${env.repo}/commits/${pr.head.sha}/check-suites?per_page=100`);

    const pushedAt = suites.check_suites.map((suite) => suite.created_at).toSorted()[0] ?? null;
    landApprovalByOwner = landApprovalByOwnerOf(events, env.owner, pushedAt);
  }

  const devRuns = await api(
    env,
    WorkflowRuns,
    `repos/${env.repo}/actions/runs?branch=dev&event=push&status=completed&per_page=1`,
  );

  return {
    number: pr.number,
    state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
    sameRepository: pr.head.repo?.full_name === env.repo,
    openedByOwner: pr.user?.login === env.owner,
    draft: pr.draft,
    head: pr.head.sha,
    patch,
    ci: ciOfRuns(ciRuns),
    labels,
    landApprovalByOwner,
    openImportant: openImportantOf(graphqlLogin(env.appLogin), threads),
    devRed: devRuns.workflow_runs[0]?.conclusion === "failure",
    conflicting: conflictingOf(pr.mergeable_state),
    record,
    now: new Date().toISOString(),
    reviewJob: await reviewJobOf(env, pr.number, record.review, patch),
  };
}

async function setCheck(env: Env, name: string, head: string, check: CheckState): Promise<void> {
  const output = { title: check.summary, summary: check.summary };

  const body =
    check.kind === "pending"
      ? { name, head_sha: head, status: "in_progress", output }
      : { name, head_sha: head, status: "completed", conclusion: check.kind, output };

  await send(env, "POST", `repos/${env.repo}/check-runs`, body);
}

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

/** The routing policy of the factory config in `checkout`: the Merge bot's own checkout of the Trunk, never a PR's head. */
export function routingPolicyAt(checkout: string): RoutingPolicy {
  return factoryConfigOf(readFileSync(join(checkout, FACTORY_CONFIG_PATH), "utf8")).land.routing;
}

const changedPaths = async (env: Env, from: string, to: string): Promise<readonly string[]> =>
  (await git(env, changedPathsArgs(from, to))).split("\n").filter((path) => path !== "");

async function route(env: Env, range: Range, record: StateRecord, patchDelta: boolean): Promise<RoutingAnswer> {
  const policy = routingPolicyAt(env.cwd);
  const from = await rangeStart(env, range, record, patchDelta);
  const paths = await changedPaths(env, range.base, range.head);

  const numstat = await git(env, ["diff", "--numstat", `${range.base}..${range.head}`]);

  const lines = numstat.split("\n").reduce(
    (sum, row) =>
      sum +
      row
        .split("\t")
        .slice(0, 2)
        .reduce((acc, n) => acc + (Number(n) || 0), 0),
    0,
  );

  const messages = (await git(env, ["log", "--format=%B%x00", `${range.base}..${range.head}`]))
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");

  const rules = routingRulesOf(policy, { paths, lines, messages });

  let judge: Promise<RoutingAnswer> | undefined;

  const asked = (): Promise<RoutingAnswer> => {
    judge ??= (async () =>
      routingJudge(
        ask,
        env.cwd,
        await git(env, ["diff", "--stat", `${from}..${range.head}`]),
        await git(env, ["diff", `${from}..${range.head}`]),
        patchDelta,
      ))();

    return judge;
  };

  const answer = rules.kind === "ruled" ? rules.answer : judgedRouting(rules, await asked());

  if (rules.kind === "judged" || !patchDelta) {
    return answer;
  }

  // The Routing rules hold the labels of the whole PR; whether this Patch delta is read again is its own question.
  const patchDeltaRules = routingRulesOf(policy, {
    paths: await changedPaths(env, from, range.head),
    lines: 0,
    messages: [],
  });

  return { ...answer, secondRound: patchDeltaRules.kind !== "judged" || (await asked()).secondRound };
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
      const answer = await route(env, range, record, step.patchDelta);
      log(
        `#${pr.number} routing ${step.patch.slice(0, 8)}: route:${answer.land} review:${answer.review} second:${answer.secondRound} by ${answer.model ?? "the Routing rules"} (${answer.reason})`,
      );
      const next = { ...record, triage: { ...record.triage, [step.patch]: answer } };
      await writeRecord(env, pr.number, recordId, next);

      return next;
    }

    case "request-review": {
      const patch = await patchOf(env, range);
      const base = await rangeStart(env, range, record, step.reviewRound === 2);

      const request = {
        pr: pr.number,
        head: range.head,
        base,
        patch,
        round: step.reviewRound,
        ...REVIEW_SETTINGS[step.depth],
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
          const plan = postPlanOf(result.report.findings, diffLinesOf(diff));

          await send(env, "POST", `repos/${env.repo}/pulls/${pr.number}/reviews`, reviewOf(plan, result, range.head));
        } catch (error) {
          // No fallback to the body: a finding posted with no thread would block nothing.
          const summary = `The review could not be posted: ${String(error).slice(0, 300)}`;
          await setCheck(env, REVIEW_CHECK, pr.head.sha, { kind: "failure", summary });
          log(`#${pr.number} ${summary}`);

          return null;
        }
      }

      log(`#${pr.number} ${summaryOf(result)}${posted ? ", posted before" : ""}`);
      const next = afterReview(record, result);
      await writeRecord(env, pr.number, recordId, next);

      if (!pr.draft && result.report.findings.some((finding) => finding.severity === "important")) {
        await mutate(env, "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}", {
          id: pr.node_id,
        });
      }

      return next;
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

    case "needs-owner": {
      await send(env, "POST", `repos/${env.repo}/issues/${pr.number}/labels`, { labels: [NEEDS_OWNER_LABEL] });

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

    case "principal-judge": {
      const guide = readFileSync(join(env.cwd, "REVIEW.md"), "utf8");

      const result = await principalJudge(
        ask,
        env.cwd,
        principalJudgePrompt(guide, await git(env, ["diff", `${range.base}..${range.head}`])),
      );

      const by = `${result.model ?? PRINCIPAL_JUDGE_MODEL}${result.costUsd === null ? "" : `, $${result.costUsd.toFixed(3)}`}`;
      const next = afterPrincipalJudge(record, step.patch, result.verdict);
      const failures = next.fableFailures?.[step.patch] ?? 0;
      // The record first: a failed comment must not make the next decision pay for the Principal judge again.
      await writeRecord(env, pr.number, recordId, next);

      const said =
        result.verdict === null
          ? `no verdict (${result.failure}), run ${failures} of ${PRINCIPAL_JUDGE_TRIES}${failures >= PRINCIPAL_JUDGE_TRIES ? ", so the owner decides" : ", asked again"}.`
          : `${result.verdict.ok ? "OK" : "NOT OK"}. ${result.verdict.reason}`;

      log(`#${pr.number} principal judge ${step.patch.slice(0, 8)} by ${by}: ${said}`);
      await send(env, "POST", `repos/${env.repo}/issues/${pr.number}/comments`, {
        body: `Principal judge (${by}): ${said}`,
      });

      return next;
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

      if (step.kind === "route" || step.kind === "post-review" || step.kind === "principal-judge") {
        decideAgain = true;
      }
    }

    if (!decideAgain) {
      return;
    }
  }
}

async function numbersOf(env: Env): Promise<number[]> {
  const event = required("EVENT_NAME");
  const pr = process.env["PR_NUMBER"];

  if (pr !== undefined && pr !== "") {
    return [Number(pr)];
  }

  if (event === "workflow_run") {
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
    appLogin: required("APP_LOGIN"),
    cwd: process.cwd(),
  };

  const reason = process.env["EJECTION_REASON"];

  for (const number of await numbersOf(env)) {
    await advance(env, number, reason === undefined || reason === "" ? null : reason, (line) => {
      console.log(`merge-bot: ${line}`);
    });
  }
}
