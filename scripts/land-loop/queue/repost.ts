#!/usr/bin/env bun

/**
 * Re-posts the App's required checks on the merge queue's own commit. The Merge bot posts the
 * Review check and the Land gate on the PR head, while the queue tests a new commit of its own: without
 * this job the required checks never report there and the queue times out. A check reads green on the
 * queue's commit only when the App's latest check of that name is green on the PR's head.
 *
 * Reads GITHUB_REPOSITORY, MERGE_GROUP_HEAD_SHA, MERGE_GROUP_HEAD_REF (`gh-readonly-queue/<base>/pr-<n>-<sha>`), APP_SLUG.
 */

import { checked, run } from "../lib/run.ts";
import { LAND_GATE, REVIEW_CHECK } from "../merge-bot/decide.ts";

export const CHECKS = [REVIEW_CHECK, LAND_GATE] as const;

export function prOfRef(ref: string): number | null {
  const match = /\/pr-(\d+)-[0-9a-f]{40}$/u.exec(ref);

  return match === null ? null : Number(match[1]);
}

interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly app: { readonly slug: string };
  readonly completed_at: string | null;
}

/** The latest completed check of that name the App posted, green or not. */
export function greenOnHead(runs: readonly CheckRun[], name: string, appSlug: string): boolean {
  const mine = runs
    .filter((check) => check.name === name && check.app.slug === appSlug && check.status === "completed")
    .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));

  return mine.at(-1)?.conclusion === "success";
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") throw new Error(`${name} is unset`);

  return value;
}

if (import.meta.main) {
  const repo = required("GITHUB_REPOSITORY");
  const sha = required("MERGE_GROUP_HEAD_SHA");
  const ref = required("MERGE_GROUP_HEAD_REF");
  const appSlug = required("APP_SLUG");
  const cwd = process.cwd();
  const pr = prOfRef(ref);

  if (pr === null) throw new Error(`${ref} names no PR`);

  const head = JSON.parse(await checked(run, ["gh", "api", `repos/${repo}/pulls/${pr}`], { cwd })) as { head: { sha: string } };
  const runs = JSON.parse(
    await checked(run, ["gh", "api", `repos/${repo}/commits/${head.head.sha}/check-runs?per_page=100`], { cwd }),
  ) as { check_runs: CheckRun[] };

  for (const name of CHECKS) {
    const green = greenOnHead(runs.check_runs, name, appSlug);
    const summary = green ? `Green on #${pr}'s head ${head.head.sha.slice(0, 7)}.` : `Not green on #${pr}'s head ${head.head.sha.slice(0, 7)}.`;
    const body = { name, head_sha: sha, status: "completed", conclusion: green ? "success" : "failure", output: { title: summary, summary } };
    await checked(run, ["gh", "api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"], { cwd, stdin: JSON.stringify(body) });
    console.log(`repost: ${name} ${green ? "success" : "failure"} on ${sha.slice(0, 7)} for #${pr}`);
  }
}
