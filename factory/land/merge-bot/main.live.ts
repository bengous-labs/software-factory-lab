/**
 * The Merge bot's shell, which `bin/merge-bot.ts` starts: `.github/workflows/merge-bot.yml` runs it from
 * the default branch with the App's token. Each start makes one Merge bot run for the PR the event names,
 * or, on a Sweep, one for every open PR. A Merge bot run reads a snapshot of its PR, asks `decide.ts`, performs the steps, and
 * decides again after a model step, until no model step is left. Each decision rewrites the ledger of
 * the review's findings in the comment that holds the state record, when what it shows changed. When the
 * Owner's Land approval lands Important findings open, it opens their follow-up issue.
 *
 * Reads GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, OWNER (the only GitHub login whose PRs are
 * served), AUTHOR_LOGIN, APP_LOGIN, EVENT_NAME, PR_NUMBER, RUN_HEAD_SHA, RUN_EVENT, EJECTION_REASON; calls
 * gh and git through the `run` port, and the models through the `ask` port. The Code review runs in its own
 * job, `.github/workflows/code-review.yml`, which the Merge bot dispatches and whose artifact it reads.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LAND_APPROVAL_LABEL, LAND_GATE, landLabelOf, REVIEW_CHECK, reviewLabelOf } from "../../contract.ts";
import type { LandRoute, ReviewDepth } from "../../contract.ts";
import { TRUNK } from "../../install/host.ts";
import { requiredOf } from "../../lib/env.ts";
import { decodeJson } from "../../lib/json.ts";
import type { Run } from "../../lib/run.port.ts";
import { CODE_REVIEW } from "../review/code-review.actor.ts";
import { againRepliesOf, diffArgsOf, diffLinesOf, postPlanOf, reviewOf } from "../review/post-plan.ts";
import { inputsOf, resultOfJson, summaryOf } from "../review/review-report.ts";
import {
  graphqlLogin,
  ledgerFindingsOf,
  openImportantOf,
  rejectedImportantOf,
  reviewMarkerOf,
  unnotedOf,
} from "../shared/findings.ts";
import type { ReviewThread } from "../shared/findings.ts";
import { decide } from "./decide.ts";
import type { Env } from "./github.ts";
import {
  againPoster,
  api,
  call,
  checkSetter,
  conversationReader,
  devRunsReader,
  draftConverter,
  gh,
  git,
  issueOpener,
  labelEventsReader,
  mutate,
  ownerCommenter,
  readOrGone,
  reviewsReader,
  send,
  stateWriter,
  threadLoginsOf,
  threadsOf,
  threadsResolver,
} from "./github.ts";
import { followUpIssueOf, landedOpenNoteOf } from "./ledger.ts";
import {
  ActionsRun,
  CheckRuns,
  CheckSuites,
  ciOfRuns,
  ciRunsPathsOf,
  CommitPulls,
  devRedOf,
  Dispatched,
  humanLabelByOf,
  landApprovalByOwnerOf,
  landApprovalPutByOwnerOf,
  latestReviewAtOf,
  ListedPrs,
  openedByFactoryOf,
  Pull,
  startOf,
  stateCommentIn,
} from "./readings.ts";
import type { StateComment } from "./readings.ts";
import type { ReviewState, StateRecord } from "./record.ts";
import { postedFindingsOf } from "./review-job.ts";
import { route } from "./route.live.ts";
import {
  changedPathsArgs,
  patchOf,
  pathsListed,
  rangeOf,
  rangeStart,
  readsPatchDelta,
  routingLineOf,
} from "./routing-inputs.ts";
import type { Range } from "./routing-inputs.ts";
import { conflictingOf } from "./snapshot.ts";
import type { ReviewJob, Snapshot } from "./snapshot.ts";
import { stepsDone } from "./steps-run.ts";
import type { Step } from "./steps.ts";

/** Decisions per Merge bot run. */
const MAX_DECISIONS = 4;

/** The review job's workflow file. An external name: the Merge bot dispatches it by this name. */
const REVIEW_WORKFLOW = "code-review.yml";

/** The PR from the single-PR endpoint, read again up to three times while GitHub has not computed its mergeability yet. */
async function pullOf(env: Env, number: number): Promise<Pull> {
  let pr = await api(env, Pull, `repos/${env.repo}/pulls/${number}`);

  for (let tries = 0; tries < 3 && pr.state === "open" && pr.mergeable === null; tries += 1) {
    await Bun.sleep(5000);
    pr = await api(env, Pull, `repos/${env.repo}/pulls/${number}`);
  }

  return pr;
}

async function stateOf(env: Env, pr: number): Promise<StateComment> {
  return stateCommentIn(await conversationReader(env.run)(env, pr), env);
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

async function snapshotOf(
  env: Env,
  pr: Pull,
  range: Range,
  record: StateRecord,
  threads: readonly ReviewThread[],
): Promise<Snapshot> {
  const [ciRuns, devRuns] = await Promise.all([
    Promise.all(ciRunsPathsOf(env.repo, pr.head.sha).map((path) => api(env, CheckRuns, path))),
    devRunsReader(env.run)(env),
  ]);

  const patch = await patchOf(env, range);
  const empty = (await pathsListed(env, changedPathsArgs(range.base, range.head))).length === 0;
  const labels = pr.labels.map((label) => label.name);
  const humanLabel = landLabelOf("owner");

  const events =
    labels.includes(LAND_APPROVAL_LABEL) || labels.includes(humanLabel)
      ? await labelEventsReader(env.run)(env, pr.number)
      : [];

  let landApprovalByOwner = false;
  let landApprovalPutByOwner = false;

  if (labels.includes(LAND_APPROVAL_LABEL)) {
    // The head's first check suite is created when it is pushed: a Land approval put before that was given for another head.
    const [suites, reviews] = await Promise.all([
      api(env, CheckSuites, `repos/${env.repo}/commits/${pr.head.sha}/check-suites?per_page=100`),
      reviewsReader(env.run)(env, pr.number),
    ]);

    const headPushedAt = suites.check_suites.map((suite) => suite.created_at).toSorted()[0] ?? null;
    const reviewedAt = latestReviewAtOf(reviews, env.appLogin);
    landApprovalByOwner = landApprovalByOwnerOf(events, env.owner, { headPushedAt, reviewedAt });
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
    rejectedImportant: rejectedImportantOf(threadLoginsOf(env), threads),
    devRed: devRedOf(devRuns),
    conflicting: conflictingOf(pr.mergeable_state),
    record,
    now: new Date().toISOString(),
    reviewJob: await reviewJobReader(env.run)(env, pr.number, record.review, patch),
  };
}

/** Sets the `land:*` and `review:*` labels. Their names are external: open PRs carry them, so the strings stay. */
async function setLabels(env: Env, pr: Pull, landRoute: LandRoute, depth: ReviewDepth): Promise<void> {
  const wanted = [landLabelOf(landRoute), reviewLabelOf(depth)];
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

// oxlint-disable-next-line typescript/consistent-return -- the switch covers every Step kind, so no path reaches the end.
async function perform(
  env: Env,
  pr: Pull,
  range: Range,
  write: (record: StateRecord) => Promise<void>,
  record: StateRecord,
  step: Step,
  log: (line: string) => void,
): Promise<StateRecord | null> {
  switch (step.kind) {
    case "route": {
      const { answer, judge } = await route(env, range, record, { patchDelta: step.patchDelta, pr: pr.number });
      log(routingLineOf(pr.number, step.patch, answer, judge));
      const next = { ...record, triage: { ...record.triage, [step.patch]: answer } };
      await write(next);

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
        ...CODE_REVIEW.depths[step.depth],
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

      await write(next);

      return next;
    }

    case "post-review": {
      const { result } = step;
      // Every page: each reply the App posts in a thread is a review too, so a PR passes 100 of them early.
      const reviews = await reviewsReader(env.run)(env, pr.number);
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
          await checkSetter(env.run)(env, REVIEW_CHECK, pr.head.sha, { kind: "failure", summary });
          log(`#${pr.number} ${summary}`);

          return null;
        }
      }

      if (step.heldOpen.length > 0) {
        const threads = await threadsOf(env, pr.number);

        await againPoster(env.run)(env, againRepliesOf(result, step.heldOpen, threads, graphqlLogin(env.appLogin)));
      }

      log(`#${pr.number} ${summaryOf(result)}${posted ? ", posted before" : ""}`);

      return record;
    }

    case "resolve-threads": {
      await threadsResolver(env.run)(env, step.threads);
      log(`#${pr.number} resolved ${step.threads.length} Important thread(s)`);

      return record;
    }

    case "follow-up": {
      const findings = ledgerFindingsOf(threadLoginsOf(env), await threadsOf(env, pr.number));
      const issue = followUpIssueOf(pr.number, step.threads, findings);

      if (issue === null) {
        log(`#${pr.number} follow-up: none of ${step.threads.length} thread(s) holds a finding that reads`);

        return record;
      }

      const number = await issueOpener(env.run)(env, issue);
      log(`#${pr.number} opened the follow-up issue #${number}`);
      // Written at once: a run that stops before the record opens a second issue.
      const next: StateRecord = { ...record, followUpIssue: number };
      await write(next);

      return next;
    }

    case "land-open": {
      const unnoted = unnotedOf(graphqlLogin(env.appLogin), step.threads, await threadsOf(env, pr.number));
      const note = landedOpenNoteOf(record.followUpIssue);

      await againPoster(env.run)(
        env,
        unnoted.map((thread) => ({ thread, body: note })),
      );
      await threadsResolver(env.run)(env, step.threads);
      log(`#${pr.number} landed ${step.threads.length} Important thread(s) open`);

      return record;
    }

    case "to-draft": {
      await draftConverter(env.run)(env, pr.node_id);

      return record;
    }

    case "labels": {
      await setLabels(env, pr, step.route, step.depth);

      return record;
    }

    case "review-check": {
      await checkSetter(env.run)(env, REVIEW_CHECK, pr.head.sha, step.check);

      return record;
    }

    case "land-gate": {
      await checkSetter(env.run)(env, LAND_GATE, pr.head.sha, step.check);

      return record;
    }

    case "record": {
      await write(step.record);

      return step.record;
    }

    case "remove-land-approval": {
      await send(env, "DELETE", `repos/${env.repo}/issues/${pr.number}/labels/${LAND_APPROVAL_LABEL}`);

      return record;
    }

    case "owner-comment": {
      await ownerCommenter(env.run)(env, pr.number, step.body);

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
    const state = await stateOf(env, number);
    const stored = state.record;

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
    const logins = threadLoginsOf(env);

    const decideAgain = await stepsDone(
      decision.steps,
      { read: state, record, inputs: { findings: ledgerFindingsOf(logins, threads), fixed: state.fixed } },
      {
        perform: (step, current, write) => perform(env, pr, range, write, current, step, log),
        findings: async () => ledgerFindingsOf(logins, await threadsOf(env, number)),
        write: (id, body) => stateWriter(env.run)(env, number, id, body),
      },
    );

    if (!decideAgain) {
      return;
    }
  }
}

async function numbersOf(env: Env): Promise<number[]> {
  const start = startOf({
    event: requiredOf(process.env, "EVENT_NAME"),
    pr: process.env["PR_NUMBER"],
    runEvent: process.env["RUN_EVENT"],
  });

  if (start.kind === "pr") {
    return [start.number];
  }

  if (start.kind === "commit-pulls") {
    const sha = requiredOf(process.env, "RUN_HEAD_SHA");
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

/**
 * One start of the Merge bot, over the `ports` its door gives it: a Merge bot run for the PR the event
 * names, or one for every PR a Sweep serves.
 */
export async function main(ports: Pick<Env, "run" | "ask">): Promise<void> {
  const env: Env = {
    ...ports,
    repo: requiredOf(process.env, "GITHUB_REPOSITORY"),
    owner: requiredOf(process.env, "OWNER"),
    authorLogin: requiredOf(process.env, "AUTHOR_LOGIN"),
    appLogin: requiredOf(process.env, "APP_LOGIN"),
    cwd: process.cwd(),
    runUrl: `${requiredOf(process.env, "GITHUB_SERVER_URL")}/${requiredOf(process.env, "GITHUB_REPOSITORY")}/actions/runs/${requiredOf(process.env, "GITHUB_RUN_ID")}`,
  };

  const reason = process.env["EJECTION_REASON"];

  for (const number of await numbersOf(env)) {
    await advance(env, number, reason === undefined || reason === "" ? null : reason, (line) => {
      console.log(`merge-bot: ${line}`);
    });
  }
}
