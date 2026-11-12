/**
 * What the Merge bot reads of a PR's range to route it: the git commands that list its paths and count
 * its lines, the Routing judge's environment, and the line a route leaves in the log.
 */

import { TRUNK } from "../../install/host.ts";
import { tokensText } from "../../lib/tokens.ts";
import type { RoutingVerdict } from "../routing/routing-judge.ts";
import type { RoutingAnswer } from "../routing/routing-rules.ts";
import type { ReviewRound } from "../shared/review-round.ts";
import type { Env } from "./github.ts";
import { git } from "./github.ts";
import type { Pull } from "./readings.ts";
import type { StateRecord } from "./record.ts";
import { patchDeltaStart } from "./snapshot.ts";

/** The refspecs `rangeOf` fetches: the PR's head, its base and the Trunk, whose head `devRunsReader` reads. */
export function rangeRefspecsOf(pr: Pick<Pull, "number" | "base">): readonly string[] {
  const branches = pr.base.ref === TRUNK ? [TRUNK] : [pr.base.ref, TRUNK];

  return [
    `+refs/pull/${pr.number}/head:refs/lab/pr-${pr.number}`,
    ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
  ];
}

/** The arguments of a `git diff` that lists every path a range touches: renames split, so a moved file lists both its paths. */
export const changedPathsArgs = (from: string, to: string): readonly string[] => [
  "diff",
  "--name-only",
  "--no-renames",
  `${from}..${to}`,
];

/** The arguments of a `git diff` that lists the paths a range deletes, renames split as in `changedPathsArgs`. */
export const deletedPathsArgs = (from: string, to: string): readonly string[] => [
  "diff",
  "--name-only",
  "--no-renames",
  "--diff-filter=D",
  `${from}..${to}`,
];

/** The arguments of the `git diff` the Routing judge reads, its `--stat` or its patch, over the whole range. */
export const judgeDiffArgs = (from: string, to: string, stat: boolean): readonly string[] => [
  "diff",
  ...(stat ? ["--stat"] : []),
  `${from}..${to}`,
];

/** The arguments of the `git diff --numstat` that counts the lines a range changes. */
export const numstatArgs = (from: string, to: string): readonly string[] => ["diff", "--numstat", `${from}..${to}`];

/** The lines a `git diff --numstat` output counts, added and deleted; a binary file's `-` counts none. */
export const linesOfNumstat = (numstat: string): number =>
  numstat.split("\n").reduce(
    (sum, row) =>
      sum +
      row
        .split("\t")
        .slice(0, 2)
        .reduce((acc, n) => acc + (Number(n) || 0), 0),
    0,
  );

/** Whether a Review round reads the Patch delta, from the head the last round read: every round after the first. */
export const readsPatchDelta = (round: ReviewRound): boolean => round >= 2;

export type JobEnv = Readonly<Partial<Record<string, string>>>;

/** The Routing judge's whole environment, from the job's: its PATH, HOME and model token, and no GitHub token. */
export function judgeEnvOf(job: JobEnv, configDir: string) {
  const of = (name: string): string => {
    const value = job[name];

    if (value === undefined || value === "") {
      throw new Error(`${name} is unset`);
    }

    return value;
  };

  return {
    PATH: of("PATH"),
    HOME: of("HOME"),
    CLAUDE_CODE_OAUTH_TOKEN: of("CLAUDE_CODE_OAUTH_TOKEN"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CONFIG_DIR: configDir,
  };
}

/** The log line of a route; the Routing judge's tokens close it when the judge was asked. */
export function routingLineOf(pr: number, patch: string, answer: RoutingAnswer, judge: RoutingVerdict | null): string {
  const line = `#${pr} routing ${patch.slice(0, 8)}: route:${answer.land} review:${answer.review} second:${answer.secondRound} by ${answer.model ?? "the Routing rules"} (${answer.reason})`;

  return judge === null ? line : `${line} ${tokensText(judge.tokens)}`;
}

export interface Range {
  readonly base: string;
  readonly head: string;
}

export async function rangeOf(env: Env, pr: Pull): Promise<Range> {
  await git(env, ["fetch", "--quiet", "origin", ...rangeRefspecsOf(pr)]);

  return { base: await git(env, ["merge-base", `origin/${pr.base.ref}`, pr.head.sha]), head: pr.head.sha };
}

export async function patchOf(env: Env, range: Range): Promise<string> {
  const diff = await git(env, ["diff", `${range.base}..${range.head}`]);

  if (diff === "") {
    return "empty";
  }

  const ran = await env.run(["git", "patch-id", "--stable"], { cwd: env.cwd, stdin: `${diff}\n` });

  return ran.stdout.split(" ")[0] ?? "empty";
}

/**
 * Where the range read starts: for a Patch delta, the head the last review read, while it is still an
 * ancestor of this head; else the merge base. A rebase leaves that head out of the PR's history, and
 * the Patch delta is then the whole PR again.
 */
export async function rangeStart(env: Env, range: Range, record: StateRecord, patchDelta: boolean): Promise<string> {
  if (!patchDelta || record.reviewedHead === null) {
    return range.base;
  }

  const ancestor = await env.run(["git", "merge-base", "--is-ancestor", record.reviewedHead, range.head], {
    cwd: env.cwd,
  });

  return patchDeltaStart(range.base, record.reviewedHead, ancestor.code);
}

export const pathsListed = async (env: Env, args: readonly string[]): Promise<readonly string[]> =>
  (await git(env, args)).split("\n").filter((path) => path !== "");

export const linesChanged = async (env: Env, from: string, to: string): Promise<number> =>
  linesOfNumstat(await git(env, numstatArgs(from, to)));
