#!/usr/bin/env bun

/**
 * The process `.github/workflows/queue-checks.yml` runs on the merge queue's commit: it re-posts the App's
 * required checks there (`land/queue/repost.ts`).
 *
 * Reads GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, MERGE_GROUP_HEAD_SHA, MERGE_GROUP_HEAD_REF
 * (`gh-readonly-queue/<base>/pr-<n>-<sha>`), APP_SLUG.
 */

import { CheckRuns, CHECKS, greenOnHead, prOfRef, Pull, repostBodyOf } from "../land/queue/repost.ts";
import { requiredOf } from "../lib/env.ts";
import { decodeJson } from "../lib/json.ts";
import { run } from "../lib/run.live.ts";
import { checked } from "../lib/run.port.ts";

const repo = requiredOf(process.env, "GITHUB_REPOSITORY");

const sha = requiredOf(process.env, "MERGE_GROUP_HEAD_SHA");

const ref = requiredOf(process.env, "MERGE_GROUP_HEAD_REF");

const appSlug = requiredOf(process.env, "APP_SLUG");

const runUrl = `${requiredOf(process.env, "GITHUB_SERVER_URL")}/${repo}/actions/runs/${requiredOf(process.env, "GITHUB_RUN_ID")}`;

const cwd = process.cwd();

const pr = prOfRef(ref);

if (pr === null) {
  throw new Error(`${ref} names no PR`);
}

const head = decodeJson(Pull, `PR #${pr}`, await checked(run, ["gh", "api", `repos/${repo}/pulls/${pr}`], { cwd }));

const runs = decodeJson(
  CheckRuns,
  `the check runs of ${head.head.sha}`,
  await checked(run, ["gh", "api", `repos/${repo}/commits/${head.head.sha}/check-runs?per_page=100`], { cwd }),
);

for (const name of CHECKS) {
  const green = greenOnHead(runs.check_runs, name, appSlug);

  await checked(run, ["gh", "api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"], {
    cwd,
    stdin: JSON.stringify(repostBodyOf(name, sha, { green, pr, headSha: head.head.sha }, runUrl)),
  });
  console.log(`repost: ${name} ${green ? "success" : "failure"} on ${sha.slice(0, 7)} for #${pr}`);
}
