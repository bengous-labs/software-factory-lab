/**
 * The review job's runner, which `.github/workflows/code-review.yml` runs from the root checkout of the
 * dispatched ref. It reviews the checkout of the pull request's head under `pr/` and writes the job's
 * result to `review-result.json`, which the workflow uploads as its artifact. On Review rounds 2 and 3 it puts
 * the earlier findings `read-threads.ts` wrote to `review-threads.json` in the prompt. The review session
 * gets a fresh Claude Code configuration and no variable of the job but `PATH`, `HOME` and the OAuth token.
 */

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { resolverOf } from "../lib/resolve.ts";
import { reviewSession } from "../lib/review-session.ts";
import { EarlierThreads } from "./findings.ts";
import { promptOf, readsEarlierThreads } from "./review-prompt.ts";
import { OUTPUT_SCHEMA, resultOf, ReviewInputs, summaryOf } from "./review-report.ts";
import { guardOf } from "./tool-guard.ts";

/** Under the job's 30 minutes: the runner writes its own timeout before GitHub cancels the job. */
const TIMEOUT_MS = 25 * 60_000;

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset`);
  }

  return value;
}

const workspace = process.cwd();

const request = Schema.decodeUnknownSync(ReviewInputs)({
  pr: process.env.REVIEW_PR,
  head: process.env.REVIEW_HEAD,
  base: process.env.REVIEW_BASE,
  patch: process.env.REVIEW_PATCH,
  round: process.env.REVIEW_ROUND,
  model: process.env.REVIEW_MODEL,
  effort: process.env.REVIEW_EFFORT,
});

const root = realpathSync(join(workspace, "pr"));

const guides = {
  review: readFileSync(join(workspace, "REVIEW.md"), "utf8"),
  project: readFileSync(join(workspace, "AGENTS.md"), "utf8"),
};

const threadsFile = join(workspace, "review-threads.json");

const threads = readsEarlierThreads(request.round)
  ? decodeJson(EarlierThreads, threadsFile, readFileSync(threadsFile, "utf8"))
  : [];

const answer = await reviewSession({
  prompt: promptOf(request, guides, threads),
  cwd: root,
  model: request.model,
  effort: request.effort,
  outputSchema: OUTPUT_SCHEMA,
  guard: guardOf({ root, resolve: resolverOf(root) }),
  timeoutMs: TIMEOUT_MS,
  env: {
    PATH: required("PATH"),
    HOME: required("HOME"),
    CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "review-config-")),
  },
});

const result = resultOf(
  request,
  answer,
  `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`,
);

writeFileSync(join(workspace, "review-result.json"), `${JSON.stringify(result, null, 2)}\n`);

console.log(summaryOf(result));

if (result.kind === "failed") {
  process.exitCode = 1;
}
