#!/usr/bin/env bun

/**
 * The process `.github/workflows/queue-checks.yml` runs on the merge queue's commit: it re-posts the
 * App's required checks there (`land/queue/repost.ts`).
 *
 * Reads GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, MERGE_GROUP_HEAD_SHA, MERGE_GROUP_HEAD_REF (`gh-readonly-queue/<base>/pr-<n>-<sha>`), APP_SLUG.
 */

import { CheckRuns, CHECKS, greenOnHead, prOfRef, Pull, repostBodyOf } from "../land/queue/repost.ts";
import { decodeJson } from "../lib/json.ts";
import { run } from "../lib/run.live.ts";
import { checked } from "../lib/run.port.ts";

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset`);
  }

  return value;
}

const repo = required("GITHUB_REPOSITORY");

const sha = required("MERGE_GROUP_HEAD_SHA");

const ref = required("MERGE_GROUP_HEAD_REF");

const appSlug = required("APP_SLUG");

const runUrl = `${required("GITHUB_SERVER_URL")}/${repo}/actions/runs/${required("GITHUB_RUN_ID")}`;

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
