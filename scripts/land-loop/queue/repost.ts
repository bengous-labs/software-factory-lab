#!/usr/bin/env bun

/**
 * Re-posts the App's required checks on the merge queue's own commit. The Merge bot posts the
 * Review check and the Land gate on the PR head, while the queue tests a new commit of its own: without
 * this job the required checks never report there and the queue times out. A check reads green on the
 * queue's commit only when the App's latest check of that name is green on the PR's head.
 *
 * Reads GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, MERGE_GROUP_HEAD_SHA, MERGE_GROUP_HEAD_REF (`gh-readonly-queue/<base>/pr-<n>-<sha>`), APP_SLUG.
 */

import { Schema } from "effect";

import { decodeJson } from "../../lib/json.ts";
import { checked, run } from "../lib/run.ts";
import { LAND_GATE, REVIEW_CHECK } from "../merge-bot/decide.ts";

export const CHECKS = [REVIEW_CHECK, LAND_GATE] as const;

export function prOfRef(ref: string): number | null {
  const match = /\/pr-(\d+)-[0-9a-f]{40}$/u.exec(ref);

  return match === null ? null : Number(match[1]);
}

const CheckRun = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  app: Schema.NullOr(Schema.Struct({ slug: Schema.String })),
  completed_at: Schema.NullOr(Schema.String),
});

type CheckRun = typeof CheckRun.Type;

/** `repos/<repo>/pulls/<n>`, as far as this job reads it. */
export const Pull = Schema.Struct({ head: Schema.Struct({ sha: Schema.String }) });

/** `repos/<repo>/commits/<sha>/check-runs`, as far as this job reads it. */
export const CheckRuns = Schema.Struct({ check_runs: Schema.Array(CheckRun) });

/** The latest completed check of that name the App posted, green or not. */
export function greenOnHead(runs: readonly CheckRun[], name: string, appSlug: string): boolean {
  const mine = runs
    .filter((check) => check.name === name && check.app?.slug === appSlug && check.status === "completed")
    .toSorted((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));

  return mine.at(-1)?.conclusion === "success";
}

/** How the App's latest check of a name reads on the head of the PR the queue tests. */
export interface OnHead {
  readonly green: boolean;
  readonly pr: number;
  readonly headSha: string;
}

/** The POST body of `repos/<repo>/check-runs` that re-posts `name` on the queue's commit `sha`. */
export function repostBodyOf(name: string, sha: string, onHead: OnHead, runUrl: string): Schema.JsonObject {
  const { green, pr, headSha } = onHead;

  const summary = green
    ? `Green on #${pr}'s head ${headSha.slice(0, 7)}.`
    : `Not green on #${pr}'s head ${headSha.slice(0, 7)}.`;

  return {
    name,
    head_sha: sha,
    status: "completed",
    conclusion: green ? "success" : "failure",
    output: { title: summary, summary },
    details_url: runUrl,
  };
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is unset`);
  }

  return value;
}

if (import.meta.main) {
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
}
