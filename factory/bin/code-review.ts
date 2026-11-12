/**
 * The review job's runner, which `.github/workflows/code-review.yml` runs from the root checkout of the
 * dispatched ref. It reviews the checkout of the pull request's head under `pr/` and writes the job's
 * result to `review-result.json`, which the workflow uploads as its artifact. On Review rounds 2 and 3, and
 * on the Delta read, it puts the earlier findings `read-threads.ts` wrote to `review-threads.json` in the
 * prompt. When the request
 * asks it and the Code review reported, a security pass runs after it with the same tools and guard, and
 * the result holds the findings of both (`review-run.ts`). The review sessions get a fresh Claude Code configuration and no variable of the
 * job but `PATH`, `HOME` and the OAuth token.
 */

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { projectGuideOf } from "../land/review/code-review.prompt.ts";
import { readGuide, readRules } from "../land/review/guide.live.ts";
import { OUTPUT_SCHEMA, ReviewInputs, summaryOf } from "../land/review/review-report.ts";
import { reviewRunOf } from "../land/review/review-run.ts";
import { reviewSession } from "../land/review/review-session.live.ts";
import { EarlierThreads } from "../land/shared/findings.ts";
import { resolverOf } from "../land/shared/resolve.live.ts";
import type { SessionAnswer } from "../land/shared/review.port.ts";
import { guardOf } from "../land/shared/tool-guard.ts";
import { decodeJson } from "../lib/json.ts";

/** Per session, two of them under the job's 50 minutes: the runner writes its own timeout before GitHub cancels the job. */
const TIMEOUT_MS = 20 * 60_000;

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
  security: process.env.REVIEW_SECURITY,
});

const root = realpathSync(join(workspace, "pr"));

const guides = {
  review: readGuide(workspace, "REVIEW.md"),
  project: projectGuideOf(readGuide(workspace, "AGENTS.md"), readRules(workspace)),
};

const threadsFile = join(workspace, "review-threads.json");

const threads = decodeJson(EarlierThreads, threadsFile, readFileSync(threadsFile, "utf8"));

const env = {
  PATH: required("PATH"),
  HOME: required("HOME"),
  CLAUDE_CODE_OAUTH_TOKEN: required("CLAUDE_CODE_OAUTH_TOKEN"),
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "review-config-")),
};

const sessionOf = (prompt: string): Promise<SessionAnswer> =>
  reviewSession({
    prompt,
    cwd: root,
    model: request.model,
    effort: request.effort,
    outputSchema: OUTPUT_SCHEMA,
    guard: guardOf({ root, resolve: resolverOf(root) }),
    timeoutMs: TIMEOUT_MS,
    env,
  });

const result = await reviewRunOf(
  request,
  { guides, threads },
  sessionOf,
  `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`,
);

writeFileSync(join(workspace, "review-result.json"), `${JSON.stringify(result, null, 2)}\n`);

console.log(summaryOf(result));

if (result.kind === "failed") {
  process.exitCode = 1;
}
