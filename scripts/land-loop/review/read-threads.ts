/**
 * The review job's thread step, run on every Review round, with the job's read-only token. It reads the
 * pull request's body and review threads and writes the earlier findings, with the author's answers, to
 * `review-threads.json` at the root checkout, outside `pr/`, for `run-review.ts` to put in the prompt:
 * the entries of the local review block the Stop hook wrote in the body, then the App's threads. The
 * review session itself never gets a GitHub token.
 *
 * Reads GITHUB_REPOSITORY, REVIEW_PR and APP_LOGIN; calls gh with GH_TOKEN.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { checked, run } from "../lib/run.ts";
import { earlierFindingsOf, graphqlLogin, ReviewThreads, threadsQueryOf } from "./findings.ts";

/** The pull request as `gh api repos/<repo>/pulls/<n>` gives it, as far as this step reads it; GitHub gives an empty body as null. */
const PullBody = Schema.Struct({ body: Schema.NullOr(Schema.String) });

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset`);
  }

  return value;
}

const pr = Number(required("REVIEW_PR"));

if (!Number.isInteger(pr)) {
  throw new TypeError(`REVIEW_PR is not a pull request number: ${required("REVIEW_PR")}`);
}

const [owner = "", name = ""] = required("GITHUB_REPOSITORY").split("/");

const answer = await checked(
  run,
  ["gh", "api", "graphql", "-f", `query=${threadsQueryOf(pr)}`, "-f", `owner=${owner}`, "-f", `name=${name}`],
  { cwd: process.cwd() },
);

const threads = decodeJson(ReviewThreads, "the review threads query", answer).data.repository.pullRequest.reviewThreads
  .nodes;

const { body } = decodeJson(
  PullBody,
  "the pull request",
  await checked(run, ["gh", "api", `repos/${owner}/${name}/pulls/${pr}`], { cwd: process.cwd() }),
);

const earlier = earlierFindingsOf(graphqlLogin(required("APP_LOGIN")), threads, body ?? "");

writeFileSync(join(process.cwd(), "review-threads.json"), `${JSON.stringify(earlier, null, 2)}\n`);

console.log(`review threads pr=${pr}: ${earlier.length} earlier finding(s)`);
