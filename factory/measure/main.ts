/**
 * The Land loop's weekly measure (`bin/measure.ts`): the Owner's wait, the Review rounds, the Important
 * findings fixed or rejected, the Land approvals given again and the reverts of the PRs merged into dev
 * since a date.
 */

import { checked } from "../lib/run.port.ts";
import type { Run } from "../lib/run.port.ts";
import type { PrData, Pull } from "./decide.ts";
import {
  decodeCheckRunsPages,
  decodeCommentsPages,
  decodeCommitsPages,
  decodeDevCommitsPages,
  decodeEventsPages,
  decodePullsPages,
  decodeReviewsPages,
  REPO,
  reportOf,
  rowOf,
} from "./decide.ts";

export const USAGE = "usage: bun factory/bin/measure.ts --since YYYY-MM-DD";

export function argsOf(argv: readonly string[]): { since: string } | null {
  const [flag, since, ...rest] = argv;

  if (flag !== "--since" || since === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(since) || rest.length > 0) {
    return null;
  }

  return { since };
}

async function readPr(api: (endpoint: string) => Promise<string>, pull: Pull): Promise<PrData> {
  const base = `repos/${REPO}`;
  const n = pull.number;

  const [events, commits, reviews, comments] = await Promise.all([
    api(`${base}/issues/${n}/events`).then(decodeEventsPages),
    api(`${base}/pulls/${n}/commits`).then(decodeCommitsPages),
    api(`${base}/pulls/${n}/reviews`).then(decodeReviewsPages),
    api(`${base}/pulls/${n}/comments`).then(decodeCommentsPages),
  ]);

  const checkRuns = await Promise.all(
    commits.map((sha) =>
      api(`${base}/commits/${sha}/check-runs?check_name=land-gate&filter=all`).then(decodeCheckRunsPages),
    ),
  );

  return { pull, events, commits, checkRuns: checkRuns.flat(), reviews, comments };
}

/** The report of the PRs merged into dev from `since` (inclusive), read through `gh api`. */
export async function measure(runner: Run, cwd: string, since: string): Promise<string> {
  const api = (endpoint: string): Promise<string> =>
    checked(runner, ["gh", "api", "-X", "GET", "--paginate", "--slurp", endpoint], { cwd });

  const from = `${since}T00:00:00Z`;

  const merged = decodePullsPages(await api(`repos/${REPO}/pulls?state=closed&base=dev`)).filter(
    (pull) => pull.merged_at !== null && Date.parse(pull.merged_at) >= Date.parse(from),
  );

  const [prs, devCommits] = await Promise.all([
    Promise.all(merged.map((pull) => readPr(api, pull))),
    api(`repos/${REPO}/commits?sha=dev&since=${from}`).then(decodeDevCommitsPages),
  ]);

  return reportOf(prs.map((pr) => rowOf(pr, devCommits)));
}
