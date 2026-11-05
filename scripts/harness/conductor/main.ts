#!/usr/bin/env bun

/**
 * The conductor's adapter, run by `.github/workflows/conductor.yml` from the default branch with the
 * App's token. For each PR the event names (every open PR on a sweep), it reads a snapshot, asks
 * `decide.ts`, performs the steps, and runs again after a model step, until no model step is left.
 *
 * Reads GITHUB_REPOSITORY, OWNER (the only author served), APP_LOGIN, EVENT_NAME, PR_NUMBER,
 * RUN_HEAD_SHA, DEQUEUE_REASON; calls gh, git and claude.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checked, run } from "../lib/run.ts";
import { commentOf, type Finding, promptOf as reviewPrompt, review, severityOfBody, type RejectedThread } from "../review/findings.ts";
import { floorOf } from "../triage/floor.ts";
import { judge } from "../triage/judge.ts";
import { type CheckState, decide, EMPTY_RECORD, type Land, type Level, type Snapshot, type StateRecord, type Step } from "./decide.ts";

const STATE_MARKER = "<!-- lab-conductor-state";

const MAX_PASSES = 4;

interface Env {
  readonly repo: string;
  readonly owner: string;
  readonly appLogin: string;
  readonly cwd: string;
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") throw new Error(`${name} is unset`);

  return value;
}

const gh = (env: Env, args: readonly string[], stdin?: string): Promise<string> =>
  checked(run, ["gh", ...args], { cwd: env.cwd, ...(stdin === undefined ? {} : { stdin }) });

const git = async (env: Env, args: readonly string[]): Promise<string> => (await checked(run, ["git", ...args], { cwd: env.cwd })).trim();

const api = async <T>(env: Env, path: string, method = "GET", body?: object): Promise<T> => {
  const out = await gh(env, ["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])], body === undefined ? undefined : JSON.stringify(body));

  return (out.trim() === "" ? {} : JSON.parse(out)) as T;
};

const graphql = <T>(env: Env, query: string, variables: Record<string, string> = {}): Promise<T> =>
  api<T>(env, "graphql", "POST", { query, variables });

interface PullJson {
  number: number;
  node_id: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  user: { login: string };
  labels: { name: string }[];
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string };
}

interface ThreadJson {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: { nodes: { author: { login: string } | null; body: string }[] };
}

async function threadsOf(env: Env, pr: number): Promise<ThreadJson[]> {
  const [owner, name] = env.repo.split("/");
  const out = await graphql<{ data: { repository: { pullRequest: { reviewThreads: { nodes: ThreadJson[] } } } } }>(
    env,
    `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${pr}){reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{author{login} body}}}}}}}`,
    { owner: owner ?? "", name: name ?? "" },
  );

  return out.data.repository.pullRequest.reviewThreads.nodes;
}

/** The App's login as GraphQL prints it, without REST's `[bot]` suffix. */
const bare = (login: string): string => login.replace(/\[bot\]$/u, "");

async function recordOf(env: Env, pr: number): Promise<{ id: number | null; record: StateRecord }> {
  const comments = await api<{ id: number; user: { login: string }; body: string }[]>(env, `repos/${env.repo}/issues/${pr}/comments?per_page=100`);
  const mine = comments.find((comment) => comment.user.login === env.appLogin && comment.body.includes(STATE_MARKER));

  if (mine === undefined) return { id: null, record: EMPTY_RECORD };

  const json = /<!-- lab-conductor-state (.*) -->/su.exec(mine.body)?.[1];

  return { id: mine.id, record: json === undefined ? EMPTY_RECORD : { ...EMPTY_RECORD, ...(JSON.parse(json) as StateRecord) } };
}

async function writeRecord(env: Env, pr: number, id: number | null, record: StateRecord): Promise<void> {
  const body = `Conductor state for this PR, kept by the harness. Do not edit.\n\n${STATE_MARKER} ${JSON.stringify(record)} -->`;

  if (id === null) await api(env, `repos/${env.repo}/issues/${pr}/comments`, "POST", { body });
  else await api(env, `repos/${env.repo}/issues/comments/${id}`, "PATCH", { body });
}

interface Range {
  readonly base: string;
  readonly head: string;
}

async function rangeOf(env: Env, pr: PullJson): Promise<Range> {
  await git(env, ["fetch", "--quiet", "origin", `+refs/pull/${pr.number}/head:refs/lab/pr-${pr.number}`, `+refs/heads/${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`]);

  return { base: await git(env, ["merge-base", `origin/${pr.base.ref}`, pr.head.sha]), head: pr.head.sha };
}

async function patchOf(env: Env, range: Range): Promise<string> {
  const diff = await git(env, ["diff", `${range.base}..${range.head}`]);

  if (diff === "") return "empty";

  const ran = await run(["git", "patch-id", "--stable"], { cwd: env.cwd, stdin: `${diff}\n` });

  return ran.stdout.split(" ")[0] ?? "empty";
}

async function snapshotOf(env: Env, pr: PullJson, range: Range, record: StateRecord, threads: readonly ThreadJson[]): Promise<Snapshot> {
  const runs = await api<{ check_runs: { name: string; status: string; conclusion: string | null; app: { slug: string } }[] }>(
    env,
    `repos/${env.repo}/commits/${pr.head.sha}/check-runs?check_name=validate`,
  );
  const validate = runs.check_runs.find((check) => check.app.slug === "github-actions");
  const labels = pr.labels.map((label) => label.name);
  let landOkByOwner = false;

  if (labels.includes("land-ok")) {
    const events = await api<{ event: string; label?: { name: string }; actor: { login: string } }[]>(env, `repos/${env.repo}/issues/${pr.number}/events?per_page=100`);
    const last = events.filter((event) => event.event === "labeled" && event.label?.name === "land-ok").at(-1);
    landOkByOwner = last?.actor.login === env.owner;
  }

  const devRuns = await api<{ workflow_runs: { conclusion: string | null }[] }>(env, `repos/${env.repo}/actions/runs?branch=dev&event=push&status=completed&per_page=1`);

  return {
    number: pr.number,
    state: pr.merged ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
    sameRepository: pr.head.repo?.full_name === env.repo,
    ownAuthor: pr.user.login === env.owner,
    draft: pr.draft,
    head: pr.head.sha,
    patch: await patchOf(env, range),
    ci: validate?.status !== "completed" ? null : validate.conclusion === "success" ? "success" : "failure",
    labels,
    landOkByOwner,
    openImportant: threads.filter(
      (thread) => !thread.isResolved && thread.comments.nodes[0]?.author?.login === bare(env.appLogin) && severityOfBody(thread.comments.nodes[0]?.body ?? "") === "important",
    ).length,
    devRed: devRuns.workflow_runs[0]?.conclusion === "failure",
    record,
  };
}

async function setCheck(env: Env, name: string, head: string, check: CheckState): Promise<void> {
  const output = { title: check.summary, summary: check.summary };
  const body =
    check.kind === "pending"
      ? { name, head_sha: head, status: "in_progress", output }
      : { name, head_sha: head, status: "completed", conclusion: check.kind, output };
  await api(env, `repos/${env.repo}/check-runs`, "POST", body);
}

async function setLabels(env: Env, pr: PullJson, land: Land, level: Level): Promise<void> {
  const wanted = [`land:${land}`, `review:${level}`];
  const current = pr.labels.map((label) => label.name);
  const stale = current.filter((name) => /^(land|review):/u.test(name) && !wanted.includes(name));
  const missing = wanted.filter((name) => !current.includes(name));

  for (const name of stale) await api(env, `repos/${env.repo}/issues/${pr.number}/labels/${encodeURIComponent(name)}`, "DELETE");

  if (missing.length > 0) await api(env, `repos/${env.repo}/issues/${pr.number}/labels`, "POST", { labels: missing });
}

async function triage(env: Env, range: Range, record: StateRecord, delta: boolean) {
  const from = delta && record.reviewedHead !== null ? record.reviewedHead : range.base;
  const paths = (await git(env, ["diff", "--name-only", `${range.base}..${range.head}`])).split("\n").filter((path) => path !== "");
  const numstat = await git(env, ["diff", "--numstat", `${range.base}..${range.head}`]);
  const lines = numstat.split("\n").reduce((sum, row) => sum + row.split("\t").slice(0, 2).reduce((acc, n) => acc + (Number(n) || 0), 0), 0);
  const messages = (await git(env, ["log", "--format=%B%x00", `${range.base}..${range.head}`])).split("\0").map((message) => message.trim()).filter((message) => message !== "");
  const floor = floorOf({ paths, lines, messages });
  const asked = async () =>
    judge(run, env.cwd, await git(env, ["diff", "--stat", `${from}..${range.head}`]), await git(env, ["diff", `${from}..${range.head}`]), delta);

  if (floor === null) return asked();

  if (!delta) return floor;

  // The floor holds the labels of the whole PR; whether this delta is read again is the delta's own question.
  const deltaPaths = (await git(env, ["diff", "--name-only", `${from}..${range.head}`])).split("\n").filter((path) => path !== "");
  const deltaFloor = floorOf({ paths: deltaPaths, lines: 0, messages: [] });

  return { ...floor, secondRound: deltaFloor !== null || (await asked()).secondRound };
}

function rejectedOf(env: Env, threads: readonly ThreadJson[]): RejectedThread[] {
  return threads
    .filter((thread) => thread.isResolved && thread.comments.nodes[0]?.author?.login === bare(env.appLogin) && thread.comments.nodes.length > 1)
    .map((thread) => ({
      where: `${thread.path}:${thread.line ?? "?"}`,
      finding: (thread.comments.nodes[0]?.body ?? "").split("\n")[0] ?? "",
      reply: thread.comments.nodes.slice(1).map((comment) => comment.body).join(" / "),
    }));
}

async function postFindings(env: Env, pr: PullJson, findings: readonly Finding[], round: 1 | 2, costUsd: number | null): Promise<void> {
  const counts = (["important", "nit", "pre_existing"] as const).map((severity) => `${findings.filter((found) => found.severity === severity).length} ${severity}`).join(", ");
  const body = `Review round ${round}: ${counts}.${costUsd === null ? "" : ` Estimated cost $${costUsd.toFixed(3)}.`}`;
  const inline = findings.filter((finding) => finding.line !== null);
  const loose = findings.filter((finding) => finding.line === null);
  const withLoose = loose.length === 0 ? body : `${body}\n\n${loose.map((finding) => `- \`${finding.file}\`: ${commentOf(finding)}`).join("\n")}`;

  try {
    await api(env, `repos/${env.repo}/pulls/${pr.number}/reviews`, "POST", {
      commit_id: pr.head.sha,
      event: "COMMENT",
      body: withLoose,
      comments: inline.map((finding) => ({ path: finding.file, line: finding.line, side: "RIGHT", body: commentOf(finding) })),
    });
  } catch (error) {
    // A line outside the diff makes GitHub refuse the whole review: post it as one body instead.
    const all = findings.map((finding) => `- \`${finding.file}:${finding.line ?? "?"}\` ${commentOf(finding)}`).join("\n");
    await api(env, `repos/${env.repo}/pulls/${pr.number}/reviews`, "POST", { commit_id: pr.head.sha, event: "COMMENT", body: `${body}\n\n${all}\n\n(inline posting failed: ${String(error).slice(0, 200)})` });
  }
}

async function perform(env: Env, pr: PullJson, range: Range, recordId: number | null, record: StateRecord, threads: readonly ThreadJson[], step: Step, log: (line: string) => void): Promise<StateRecord | null> {
  switch (step.kind) {
    case "triage": {
      const answer = await triage(env, range, record, step.delta);
      log(`#${pr.number} triage ${step.patch.slice(0, 8)}: land:${answer.land} review:${answer.review} second:${answer.secondRound} (${answer.reason})`);
      const next = { ...record, triage: { ...record.triage, [step.patch]: answer } };
      await writeRecord(env, pr.number, recordId, next);

      return next;
    }
    case "review": {
      const from = step.round === 2 && record.reviewedHead !== null ? record.reviewedHead : range.base;
      const guide = readFileSync(join(env.cwd, "REVIEW.md"), "utf8");
      const prompt = reviewPrompt(guide, await git(env, ["diff", `${from}..${range.head}`]), step.round, rejectedOf(env, threads));
      let result = await review(run, env.cwd, step.level, prompt, Date.now);

      if (result.findings === null) result = await review(run, env.cwd, step.level, prompt, Date.now);

      log(`#${pr.number} review round ${step.round} at ${step.level}: exit ${result.code}, ${result.ms} ms, $${result.costUsd ?? "?"}, ${result.findings?.length ?? "no"} findings`);

      if (result.findings === null) {
        await setCheck(env, "agent-review", pr.head.sha, { kind: "failure", summary: "The review failed twice." });
        await api(env, `repos/${env.repo}/issues/${pr.number}/labels`, "POST", { labels: ["needs-human"] });

        return null;
      }

      await postFindings(env, pr, result.findings, step.round, result.costUsd);
      const important = result.findings.some((finding) => finding.severity === "important");
      const next = { ...record, reviewedPatch: await patchOf(env, range), reviewedHead: range.head, rounds: record.rounds + (important ? 1 : 0) };
      await writeRecord(env, pr.number, recordId, next);

      if (important) {
        await graphql(env, "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}", { id: pr.node_id });
      }

      return next;
    }
    case "labels":
      await setLabels(env, pr, step.land, step.review);

      return record;
    case "agent-review":
      await setCheck(env, "agent-review", pr.head.sha, step.check);

      return record;
    case "land-gate":
      await setCheck(env, "land-gate", pr.head.sha, step.check);

      return record;
    case "needs-human":
      await api(env, `repos/${env.repo}/issues/${pr.number}/labels`, "POST", { labels: ["needs-human"] });

      return record;
    case "record":
      await writeRecord(env, pr.number, recordId, step.record);

      return step.record;
    case "remove-land-ok":
      await api(env, `repos/${env.repo}/issues/${pr.number}/labels/land-ok`, "DELETE");

      return record;
    case "auto-merge":
      try {
        await graphql(env, "mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){clientMutationId}}", { id: pr.node_id });
      } catch (error) {
        log(`#${pr.number} auto-merge: ${String(error).slice(0, 200)}`);
      }

      return record;
  }
}

async function conduct(env: Env, number: number, dequeueReason: string | null, log: (line: string) => void): Promise<void> {
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const pr = await api<PullJson>(env, `repos/${env.repo}/pulls/${number}`);

    if (pr.state !== "open") {
      log(`#${number} is ${pr.merged ? "merged" : "closed"}`);

      return;
    }

    const range = await rangeOf(env, pr);
    const { id, record: stored } = await recordOf(env, number);
    const record = dequeueReason !== null && pass === 0 ? { ...stored, dequeued: { head: pr.head.sha, reason: dequeueReason } } : stored;
    const threads = await threadsOf(env, number);
    const decision = decide(await snapshotOf(env, pr, range, record, threads));

    if (decision.kind === "ignore") {
      log(decision.reason);

      return;
    }

    log(`#${number} steps: ${decision.steps.map((step) => step.kind).join(", ")}`);
    let current: StateRecord | null = record;
    let modelRan = false;

    if (record !== stored) await writeRecord(env, number, id, record);

    for (const step of decision.steps) {
      current = await perform(env, pr, range, (await recordOf(env, number)).id, current, threads, step, log);

      if (current === null) return;

      if (step.kind === "triage" || step.kind === "review") modelRan = true;
    }

    if (!modelRan) return;
  }
}

async function numbersOf(env: Env): Promise<number[]> {
  const event = required("EVENT_NAME");
  const pr = process.env["PR_NUMBER"];

  if (pr !== undefined && pr !== "") return [Number(pr)];

  if (event === "workflow_run") {
    const sha = required("RUN_HEAD_SHA");
    const listed = await api<{ number: number; state: string }[]>(env, `repos/${env.repo}/commits/${sha}/pulls`);

    return listed.filter((found) => found.state === "open").map((found) => found.number);
  }

  const open = JSON.parse(await gh(env, ["pr", "list", "--repo", env.repo, "--state", "open", "--json", "number"])) as { number: number }[];

  return open.map((found) => found.number);
}

if (import.meta.main) {
  const env: Env = { repo: required("GITHUB_REPOSITORY"), owner: required("OWNER"), appLogin: required("APP_LOGIN"), cwd: process.cwd() };
  const reason = process.env["DEQUEUE_REASON"];

  for (const number of await numbersOf(env)) {
    await conduct(env, number, reason === undefined || reason === "" ? null : reason, (line) => console.log(`conductor: ${line}`));
  }
}

