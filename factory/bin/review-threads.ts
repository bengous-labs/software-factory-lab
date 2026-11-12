#!/usr/bin/env bun

/**
 * The review job's thread step, run on every Review round, with the job's read-only token. It reads the
 * pull request's review threads and writes the App's earlier findings the review is shown, with the
 * author's answers (`shownThreadsOf`), to `review-threads.json` at the root checkout, outside `pr/`, for
 * `code-review.ts` to put in the prompt. The review session itself never gets a GitHub token.
 *
 * Reads GITHUB_REPOSITORY, the request's variables (`REVIEW_VARIABLES`) and APP_LOGIN; calls gh with GH_TOKEN.
 */

import { AUTHOR_LOGIN, OWNER_LOGIN } from "../install/logins.ts";
import { writeEarlierThreads } from "../land/review/job-files.live.ts";
import { requestOfVariables } from "../land/review/review-report.ts";
import { graphqlLogin, ReviewThreads, shownThreadsOf, threadsQueryOf } from "../land/shared/findings.ts";
import { requiredOf } from "../lib/env.ts";
import { decodeJson } from "../lib/json.ts";
import { run } from "../lib/run.live.ts";
import { checked } from "../lib/run.port.ts";

const { pr, round } = requestOfVariables(process.env);

const [owner = "", name = ""] = requiredOf(process.env, "GITHUB_REPOSITORY").split("/");

const answer = await checked(
  run,
  ["gh", "api", "graphql", "-f", `query=${threadsQueryOf(pr)}`, "-f", `owner=${owner}`, "-f", `name=${name}`],
  { cwd: process.cwd() },
);

const threads = decodeJson(ReviewThreads, "the review threads query", answer).data.repository.pullRequest.reviewThreads
  .nodes;

const earlier = shownThreadsOf(
  { app: graphqlLogin(requiredOf(process.env, "APP_LOGIN")), author: AUTHOR_LOGIN, owner: OWNER_LOGIN },
  round,
  threads,
);

writeEarlierThreads(process.cwd(), earlier);

console.log(`review threads pr=${pr}: ${earlier.length} earlier finding(s)`);
