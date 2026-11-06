#!/usr/bin/env bun

/**
 * The Merge bot's adapter, run by `.github/workflows/merge-bot.yml` from the default branch with the
 * App's token. Each start makes one Merge bot run for the PR the event names, or, on a Sweep, one for
 * every open PR. A Merge bot run reads a snapshot of its PR, asks `decide.ts`, performs the steps, and
 * decides again after a model step, until no model step is left.
 *
 * Reads GITHUB_REPOSITORY, OWNER (the only GitHub login whose PRs are served), APP_LOGIN, EVENT_NAME, PR_NUMBER,
 * RUN_HEAD_SHA, EJECTION_REASON; calls gh and git, and the models through the Agent SDK.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { ask } from "../lib/ask.ts";
import { checked, run } from "../lib/run.ts";
import {
  codeReview,
  commentOf,
  EFFORT,
  MODEL,
  promptOf as codeReviewPrompt,
  rejectedOf,
  severityOfBody,
} from "../review/code-review.ts";
import type { Finding } from "../review/code-review.ts";
import { PRINCIPAL_JUDGE_MODEL, principalJudge, promptOf as principalJudgePrompt } from "../review/principal-judge.ts";
import { routingJudge } from "../routing/routing-judge.ts";
import { routingRulesOf } from "../routing/routing-rules.ts";
import {
  afterPrincipalJudge,
  conflictingOf,
  decide,
  EMPTY_RECORD,
  LAND_APPROVAL_LABEL,
  LAND_GATE,
  landApprovalCounts,
  openImportantOf,
  patchDeltaStart,
  PRINCIPAL_JUDGE_TRIES,
  recordOfJson,
  REVIEW_CHECK,
  storedLandRouteOf,
  storedOfRecord,
} from "./decide.ts";
import type { CheckState, LandRoute, ReviewDepth, Snapshot, StateRecord, Step } from "./decide.ts";

/** The state record's marker. An external name: existing PR records carry it, so the string stays. */
const MERGE_BOT_STATE_MARKER = "<!-- lab-conductor-state";

const MERGE_BOT_STATE_PATTERN = new RegExp(`${MERGE_BOT_STATE_MARKER} (.*) -->`, "su");

/** The label that sends the change to the Owner. An external name: open PRs carry it, so the string stays. */
const NEEDS_OWNER_LABEL = "needs-human";

/** Decisions per Merge bot run. */
const MAX_DECISIONS = 4;

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
  number: Schema.Number,
  node_id: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  draft: Schema.Boolean,
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeable_state: Schema.String,
  user: Schema.Struct({ login: Schema.String }),
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

const ThreadJson = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  comments: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ author: Schema.NullOr(Login), body: Schema.String })),
  }),
});

type ThreadJson = typeof ThreadJson.Type;

/** The review threads query's answer. */
export const ReviewThreads = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({ reviewThreads: Schema.Struct({ nodes: Schema.Array(ThreadJson) }) }),
    }),
  }),
});

/** `repos/<repo>/issues/<n>/comments`, as far as the Merge bot reads it. */
export const IssueComments = Schema.Array(Schema.Struct({ id: Schema.Number, user: Login, body: Schema.String }));

/** `repos/<repo>/commits/<sha>/check-runs`, as far as the Merge bot reads it. */
export const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      app: Schema.Struct({ slug: Schema.String }),
    }),
  ),
});

/** `repos/<repo>/issues/<n>/events`, as far as the Merge bot reads it. */
export const IssueEvents = Schema.Array(
  Schema.Struct({
    event: Schema.String,
    label: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
    actor: Login,
    created_at: Schema.String,
  }),
);

/** `repos/<repo>/commits/<sha>/check-suites`, as far as the Merge bot reads it. */
export const CheckSuites = Schema.Struct({ check_suites: Schema.Array(Schema.Struct({ created_at: Schema.String })) });

/** `repos/<repo>/actions/runs`, as far as the Merge bot reads it. */
export const WorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ conclusion: Schema.NullOr(Schema.String) })),
});

/** `repos/<repo>/commits/<sha>/pulls`, as far as the Merge bot reads it. */
export const CommitPulls = Schema.Array(Schema.Struct({ number: Schema.Number, state: Schema.String }));

/** `gh pr list --json number`. */
export const ListedPrs = Schema.Array(Schema.Struct({ number: Schema.Number }));

async function threadsOf(env: Env, pr: number): Promise<readonly ThreadJson[]> {
  const [owner, name] = env.repo.split("/");

  const out = await graphql(
    env,
    ReviewThreads,
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{author{login} body}}}}}}}`,
    { owner: owner ?? "", name: name ?? "" },
  );

  return out.data.repository.pullRequest.reviewThreads.nodes;
}

/** The App's login as GraphQL prints it, without REST's `[bot]` suffix. */
const bare = (login: string): string => login.replace(/\[bot\]$/u, "");

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
    (comment) => comment.user.login === env.appLogin && comment.body.includes(MERGE_BOT_STATE_MARKER),
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

async function snapshotOf(
  env: Env,
  pr: Pull,
  range: Range,
  record: StateRecord,
  threads: readonly ThreadJson[],
): Promise<Snapshot> {
  const runs = await api(env, CheckRuns, `repos/${env.repo}/commits/${pr.head.sha}/check-runs?check_name=validate`);

  const validate = runs.check_runs.find((check) => check.app.slug === "github-actions");
  const labels = pr.labels.map((label) => label.name);
  let landApprovalByOwner = false;

  if (labels.includes(LAND_APPROVAL_LABEL)) {
    const events = await api(env, IssueEvents, `repos/${env.repo}/issues/${pr.number}/events?per_page=100`);

    const last = events
      .filter((event) => event.event === "labeled" && event.label?.name === LAND_APPROVAL_LABEL)
      .at(-1);

    // The head's first check suite is created when it is pushed: a Land approval put before that was given for another head.
    const suites = await api(env, CheckSuites, `repos/${env.repo}/commits/${pr.head.sha}/check-suites?per_page=100`);

    const pushedAt = suites.check_suites.map((suite) => suite.created_at).toSorted()[0] ?? null;
    landApprovalByOwner = landApprovalCounts(last?.actor.login === env.owner, last?.created_at ?? null, pushedAt);
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
    openedByOwner: pr.user.login === env.owner,
    draft: pr.draft,
    head: pr.head.sha,
    patch: await patchOf(env, range),
    ci: validate?.status === "completed" ? (validate.conclusion === "success" ? "success" : "failure") : null,
    labels,
    landApprovalByOwner,
    openImportant: openImportantOf(
      threads.filter(
        (thread) =>
          !thread.isResolved &&
          thread.comments.nodes[0]?.author?.login === bare(env.appLogin) &&
          severityOfBody(thread.comments.nodes[0].body) === "important",
      ).length,
      record,
      await patchOf(env, range),
    ),
    devRed: devRuns.workflow_runs[0]?.conclusion === "failure",
    conflicting: conflictingOf(pr.mergeable_state),
    record,
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
 * Where a Patch delta starts: the head the last review read, while it is still an ancestor of this head.
 * A rebase leaves it out of the PR's history, and the Patch delta is then the whole PR again.
 */
async function patchDeltaBase(env: Env, range: Range, record: StateRecord): Promise<string> {
  if (record.reviewedHead === null) {
    return range.base;
  }

  const ancestor = await run(["git", "merge-base", "--is-ancestor", record.reviewedHead, range.head], { cwd: env.cwd });

  return patchDeltaStart(range.base, record.reviewedHead, ancestor.code);
}

async function route(env: Env, range: Range, record: StateRecord, patchDelta: boolean) {
  const from = patchDelta ? await patchDeltaBase(env, range, record) : range.base;

  const paths = (await git(env, ["diff", "--name-only", `${range.base}..${range.head}`]))
    .split("\n")
    .filter((path) => path !== "");

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

  const rules = routingRulesOf({ paths, lines, messages });

  const asked = async () =>
    routingJudge(
      ask,
      env.cwd,
      await git(env, ["diff", "--stat", `${from}..${range.head}`]),
      await git(env, ["diff", `${from}..${range.head}`]),
      patchDelta,
    );

  if (rules === null) {
    return asked();
  }

  if (!patchDelta) {
    return rules;
  }

  // The Routing rules hold the labels of the whole PR; whether this Patch delta is read again is its own question.
  const patchDeltaPaths = (await git(env, ["diff", "--name-only", `${from}..${range.head}`]))
    .split("\n")
    .filter((path) => path !== "");

  const patchDeltaRules = routingRulesOf({ paths: patchDeltaPaths, lines: 0, messages: [] });

  return { ...rules, secondRound: patchDeltaRules !== null || (await asked()).secondRound };
}

/** Posts the review; answers how many Important findings went out with no thread to resolve. */
async function postFindings(
  env: Env,
  pr: Pull,
  findings: readonly Finding[],
  reviewRound: 1 | 2,
  by: string,
  costUsd: number | null,
): Promise<number> {
  const counts = (["important", "nit", "pre_existing"] as const)
    .map((severity) => `${findings.filter((found) => found.severity === severity).length} ${severity}`)
    .join(", ");

  const body = `Review round ${reviewRound} (${by}): ${counts}.${costUsd === null ? "" : ` Estimated cost $${costUsd.toFixed(3)}.`}`;
  const inline = findings.filter((finding) => finding.line !== null);
  const loose = findings.filter((finding) => finding.line === null);

  const withLoose =
    loose.length === 0
      ? body
      : `${body}\n\n${loose.map((finding) => `- \`${finding.file}\`: ${commentOf(finding)}`).join("\n")}`;

  try {
    await send(env, "POST", `repos/${env.repo}/pulls/${pr.number}/reviews`, {
      commit_id: pr.head.sha,
      event: "COMMENT",
      body: withLoose,
      comments: inline.map((finding) => ({
        path: finding.file,
        line: finding.line,
        side: "RIGHT",
        body: commentOf(finding),
      })),
    });

    return loose.filter((finding) => finding.severity === "important").length;
  } catch (error) {
    // A line outside the diff makes GitHub refuse the whole review: post it as one body instead.
    const all = findings
      .map((finding) => `- \`${finding.file}:${finding.line ?? "?"}\` ${commentOf(finding)}`)
      .join("\n");

    await send(env, "POST", `repos/${env.repo}/pulls/${pr.number}/reviews`, {
      commit_id: pr.head.sha,
      event: "COMMENT",
      body: `${body}\n\n${all}\n\n(inline posting failed: ${String(error).slice(0, 200)})`,
    });

    return findings.filter((finding) => finding.severity === "important").length;
  }
}

// oxlint-disable-next-line typescript/consistent-return -- the switch covers every Step kind, so no path reaches the end.
async function perform(
  env: Env,
  pr: Pull,
  range: Range,
  recordId: number | null,
  record: StateRecord,
  threads: readonly ThreadJson[],
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

    case "code-review": {
      const from = step.reviewRound === 2 ? await patchDeltaBase(env, range, record) : range.base;
      const guide = readFileSync(join(env.cwd, "REVIEW.md"), "utf8");

      const prompt = codeReviewPrompt(
        guide,
        await git(env, ["diff", `${from}..${range.head}`]),
        step.reviewRound,
        rejectedOf(bare(env.appLogin), threads),
      );

      let result = await codeReview(ask, env.cwd, step.depth, prompt, Date.now);

      if (result.findings === null) {
        result = await codeReview(ask, env.cwd, step.depth, prompt, Date.now);
      }

      log(
        `#${pr.number} review round ${step.reviewRound} at ${step.depth} (${result.model ?? MODEL[step.depth]}, effort ${EFFORT}): ${result.error ?? "answered"}, ${result.ms} ms, $${result.costUsd ?? "?"}, ${result.findings?.length ?? "no"} findings`,
      );

      if (result.findings === null) {
        await setCheck(env, REVIEW_CHECK, pr.head.sha, { kind: "failure", summary: "The Code review failed twice." });
        await send(env, "POST", `repos/${env.repo}/issues/${pr.number}/labels`, { labels: [NEEDS_OWNER_LABEL] });

        return null;
      }

      const unthreaded = await postFindings(
        env,
        pr,
        result.findings,
        step.reviewRound,
        `${step.depth}: ${result.model ?? MODEL[step.depth]}, effort ${EFFORT}`,
        result.costUsd,
      );

      const important = result.findings.some((finding) => finding.severity === "important");
      const reviewedPatch = await patchOf(env, range);

      const next = {
        ...record,
        reviewedPatch,
        reviewedHead: range.head,
        reviewRounds: step.reviewRound,
        bodyImportant: { ...record.bodyImportant, [reviewedPatch]: unthreaded },
      };

      await writeRecord(env, pr.number, recordId, next);

      if (important) {
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

    const threads = await threadsOf(env, number);
    const decision = decide(await snapshotOf(env, pr, range, record, threads));

    if (decision.kind === "ignore") {
      log(decision.reason);

      return;
    }

    log(`#${number} steps: ${decision.steps.map((step) => step.kind).join(", ")}`);
    let current: StateRecord | null = record;
    let modelRan = false;

    if (record !== stored) {
      await writeRecord(env, number, id, record);
    }

    for (const step of decision.steps) {
      current = await perform(env, pr, range, (await recordOf(env, number)).id, current, threads, step, log);

      if (current === null) {
        return;
      }

      if (step.kind === "route" || step.kind === "code-review" || step.kind === "principal-judge") {
        modelRan = true;
      }
    }

    if (!modelRan) {
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
