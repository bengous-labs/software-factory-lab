/**
 * What re-posts the App's required checks on the merge queue's own commit (`bin/queue-checks.ts`). The
 * Merge bot posts the Review check and the Land gate on the PR head, while the queue tests a new commit of
 * its own: without this job the required checks never report there and the queue times out. A check reads
 * green on the queue's commit only when the App's latest check of that name is green on the PR's head.
 */

import { Schema } from "effect";

import { LAND_GATE, REVIEW_CHECK } from "../../contract.ts";

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
