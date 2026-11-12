#!/usr/bin/env bun

/**
 * The review job's thread step, run on every Review round, with the job's read-only token. It reads the
 * pull request's review threads and writes the App's earlier findings the review is shown, with the
 * author's answers (`shownThreadsOf`), to `review-threads.json` at the root checkout, outside `pr/`, for
 * `code-review.ts` to put in the prompt. The review session itself never gets a GitHub token.
 *
 * Reads GITHUB_REPOSITORY, REVIEW_PR, REVIEW_ROUND and APP_LOGIN; calls gh with GH_TOKEN.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AUTHOR_LOGIN, OWNER_LOGIN } from "../install/logins.ts";
import { graphqlLogin, ReviewThreads, shownThreadsOf, threadsQueryOf } from "../land/shared/findings.ts";
import { requiredOf } from "../lib/env.ts";
import { decodeJson } from "../lib/json.ts";
import { run } from "../lib/run.live.ts";
import { checked } from "../lib/run.port.ts";

const pr = Number(requiredOf(process.env, "REVIEW_PR"));

if (!Number.isInteger(pr)) {
  throw new TypeError(`REVIEW_PR is not a pull request number: ${requiredOf(process.env, "REVIEW_PR")}`);
}

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
  Number(requiredOf(process.env, "REVIEW_ROUND")),
  threads,
);

writeFileSync(join(process.cwd(), "review-threads.json"), `${JSON.stringify(earlier, null, 2)}\n`);

console.log(`review threads pr=${pr}: ${earlier.length} earlier finding(s)`);
