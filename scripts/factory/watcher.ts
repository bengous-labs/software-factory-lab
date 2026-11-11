/**
 * The watch's reads: one reading of the factory from GitHub, the PRs then the checks on each open head,
 * the sessions and `.lab/outcomes.log` of the main checkout, then the step `watch-plan.ts` decides over it.
 */

import type { Run, RunOptions } from "../land-loop/ports/run.ts";
import { checkRunsPathOf, checksOf, githubOf, sessionsOf, stepOf, stopsOf, watchQueryOf } from "./watch-plan.ts";
import type { Memory, Reading, WatchStep } from "./watch-plan.ts";

export interface WatchPorts {
  readonly run: Run;
  /** The text of the file at `path`, empty when there is none. */
  readonly readText: (path: string) => Promise<string>;
}

export interface WatchTurn {
  /** The repository's main checkout, whose `.lab/outcomes.log` holds the stops. */
  readonly checkout: string;
  /** The watched issues; none watches the repository's open PRs. */
  readonly issues: readonly number[];
  readonly memory: Memory;
  /** When the turn reads, as an ISO timestamp. */
  readonly now: string;
}

async function out(run: Run, argv: readonly string[], options: RunOptions): Promise<string> {
  const ran = await run(argv, options);

  if (ran.code !== 0) {
    throw new Error(`${argv.slice(0, 3).join(" ")} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim()}`);
  }

  return ran.stdout;
}

/** The main checkout of the repository `cwd` is a checkout of: the parent of its git common directory. */
export async function mainCheckoutOf(run: Run, cwd: string): Promise<string> {
  const commonDir = (
    await out(run, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
  ).trim();

  return commonDir.replace(/\/[^/]+$/u, "");
}

/** One reading of the factory: the PRs of `issues`, or the open PRs, with each PR of `prs` the watch saw before. */
async function readFactory(
  { run, readText }: WatchPorts,
  checkout: string,
  issues: readonly number[],
  prs: readonly number[],
): Promise<Reading> {
  const at = { cwd: checkout };

  const answer = await out(
    run,
    ["gh", "api", "graphql", "-f", `query=${watchQueryOf(issues, prs)}`, "-F", "owner={owner}", "-F", "name={repo}"],
    at,
  );

  const github = githubOf(answer);

  const read = await Promise.all(
    github.prs.map(async (pr) => ({
      ...pr,
      checks: pr.state === "OPEN" ? checksOf(await out(run, ["gh", "api", checkRunsPathOf(pr.head)], at)) : [],
    })),
  );

  const agents = await out(run, ["claude", "agents", "--json"], at);
  const log = await readText(`${checkout}/.lab/outcomes.log`);

  return { prs: read, issues: github.issues, sessions: sessionsOf(agents), stops: stopsOf(log) };
}

/** One turn of the watch: reads the factory, then decides what to print. */
export async function watchTurn(ports: WatchPorts, { checkout, issues, memory, now }: WatchTurn): Promise<WatchStep> {
  const reading = await readFactory(ports, checkout, issues, Object.keys(memory.still).map(Number));

  return stepOf(issues, reading, memory, now);
}
