/**
 * Dispatch: hands one issue to a Worker. It creates the Worker's worktree on a new branch from
 * `origin/dev`, then launches the Worker as a background session in the main checkout, which enters
 * that worktree itself.
 */

import { Schema } from "effect";

import type { Run, RunOptions } from "../land-loop/ports/run.ts";
import { decodeJson } from "../lib/json.ts";
import {
  branchOf,
  issueBranchesIn,
  launchArgvOf,
  launchEnvOf,
  promptOf,
  repoOfIssueUrl,
  sessionIdOf,
  workerSettingsOf,
  worktreeListed,
  worktreeOf,
} from "./dispatch-plan.ts";

export interface DispatchRequest {
  readonly issue: number;
  readonly model: string;
  /** The repository's main checkout, where the Worker is launched. */
  readonly checkout: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Dispatched {
  readonly issue: number;
  readonly title: string;
  readonly worktree: string;
  readonly branch: string;
  readonly session: string;
}

const IssueView = Schema.Struct({ title: Schema.String, url: Schema.String });

async function out(run: Run, argv: readonly string[], options: RunOptions): Promise<string> {
  const ran = await run(argv, options);

  if (ran.code !== 0) {
    throw new Error(`${argv.slice(0, 3).join(" ")} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim()}`);
  }

  return ran.stdout;
}

export async function dispatch(run: Run, { issue, model, checkout, env }: DispatchRequest): Promise<Dispatched> {
  const home = env["HOME"];

  if (home === undefined) {
    throw new Error("HOME is not set: the Worker settings file lives under it");
  }

  const at = { cwd: checkout };
  const view = await out(run, ["gh", "issue", "view", String(issue), "--json", "title,url"], at);
  const { title, url } = decodeJson(IssueView, `gh issue view ${issue}`, view);

  await out(run, ["git", "fetch", "origin", "dev"], at);

  const refs = await out(
    run,
    ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
    at,
  );

  const branches = issueBranchesIn(refs, issue);

  if (branches.length > 0) {
    throw new Error(
      `issue #${issue} already has a branch: ${branches.join(", ")}. Remove it first (git branch -D <branch>, git push origin --delete <branch>)`,
    );
  }

  const worktree = worktreeOf(checkout, issue);

  if (worktreeListed(await out(run, ["git", "worktree", "list", "--porcelain"], at), worktree)) {
    throw new Error(
      `issue #${issue} already has a worktree: ${worktree}. Remove it first (git worktree remove ${worktree})`,
    );
  }

  const branch = branchOf(issue, title);
  await out(run, ["git", "worktree", "add", "-b", branch, worktree, "origin/dev"], at);

  const prompt = promptOf({ issue, repo: repoOfIssueUrl(url), worktree, branch });
  const argv = launchArgvOf({ issue, model, settings: workerSettingsOf(home), prompt });
  const launched = await out(run, argv, { cwd: checkout, env: launchEnvOf(env) });

  return { issue, title, worktree, branch, session: sessionIdOf(launched) };
}
