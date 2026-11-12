/**
 * Dispatch: hands one issue to a Worker. It creates the Worker's worktree on a new branch from
 * the Trunk, then launches the Worker as a background session in the main checkout, which enters
 * that worktree itself.
 */

import { Schema } from "effect";

import { TRUNK } from "../install/host.ts";
import { OWNER_LOGIN } from "../install/logins.ts";
import { decodeJson } from "../lib/json.ts";
import { checked } from "../lib/run.port.ts";
import type { Ran, Run, RunOptions } from "../lib/run.port.ts";
import { printableOf } from "../lib/terminal.ts";
import {
  branchOf,
  issueBranchesIn,
  launchArgvOf,
  launchEnvOf,
  promptOf,
  repoOfIssueUrl,
  sessionIdOf,
  workerSettingsOf,
  workerSettingsProblemOf,
  worktreeListed,
  worktreeOf,
} from "./dispatch-plan.ts";
import type { Effort } from "./dispatch-plan.ts";

export interface DispatchPorts {
  readonly run: Run;
  /** Runs the Worker's launch with `options.env` as its whole environment. */
  readonly launch: Run;
  readonly readText: (path: string) => Promise<string>;
}

export interface DispatchRequest {
  readonly issue: number;
  readonly model: string;
  readonly effort?: Effort | undefined;
  /** The repository's main checkout, where the Worker is launched. */
  readonly checkout: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface Dispatched {
  readonly issue: number;
  /** The issue's title, without its control characters. */
  readonly title: string;
  readonly worktree: string;
  readonly branch: string;
  readonly session: string;
}

const IssueView = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  author: Schema.Struct({ login: Schema.String }),
});

function failureOf(command: string, ran: Ran): string {
  return `${command} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim()}`;
}

/** Runs each removal, whatever the one before did, and returns the failures, with the command each names. */
async function removalFailures(
  run: Run,
  removals: ReadonlyArray<readonly string[]>,
  options: RunOptions,
): Promise<string[]> {
  const failures: string[] = [];

  for (const argv of removals) {
    const ran = await run(argv, options);

    if (ran.code !== 0) {
      failures.push(failureOf(argv.join(" "), ran));
    }
  }

  return failures;
}

/** Throws unless `path` makes the Worker an Author with the machine account's token. */
async function checkWorkerSettings(readText: DispatchPorts["readText"], path: string): Promise<void> {
  let text: string;

  try {
    text = await readText(path);
  } catch (error) {
    throw new Error(
      `the Worker settings file ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const problem = workerSettingsProblemOf(text);

  if (problem !== null) {
    throw new Error(`the Worker settings file ${path}: ${problem}`);
  }
}

/**
 * The issue's title and repository. A Worker holds the Author's token and does what the issue says;
 * the lab is public, so only an issue the Owner wrote, which only the Owner and the repository's
 * writers can edit, is handed to one.
 */
async function ownersIssue(run: Run, issue: number, at: RunOptions): Promise<{ title: string; repo: string }> {
  const view = await checked(run, ["gh", "issue", "view", String(issue), "--json", "title,url,author"], at);
  const { title, url, author } = decodeJson(IssueView, `gh issue view ${issue}`, view);

  if (author.login !== OWNER_LOGIN) {
    throw new Error(
      `issue #${issue} was written by ${author.login}, not by the Owner ${OWNER_LOGIN}: a Worker holds the Author's token, so it implements only the Owner's issues`,
    );
  }

  return { title: printableOf(title), repo: repoOfIssueUrl(url) };
}

/** Throws, naming what to remove, when the issue already has a worktree or a branch. */
async function checkFree(run: Run, issue: number, worktree: string, at: RunOptions): Promise<void> {
  if (worktreeListed(await checked(run, ["git", "worktree", "list", "--porcelain"], at), worktree)) {
    throw new Error(
      `issue #${issue} already has a worktree: ${worktree}. Remove it first (git worktree remove ${worktree})`,
    );
  }

  const refs = await checked(
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
}

export async function dispatch(
  { run, launch, readText }: DispatchPorts,
  { issue, model, effort, checkout, env }: DispatchRequest,
): Promise<Dispatched> {
  const home = env["HOME"];

  if (home === undefined) {
    throw new Error("HOME is not set: the Worker settings file lives under it");
  }

  const settings = workerSettingsOf(home);
  await checkWorkerSettings(readText, settings);

  const at = { cwd: checkout };
  const { title, repo } = await ownersIssue(run, issue, at);

  await checked(run, ["git", "fetch", "--prune", "origin"], at);

  const worktree = worktreeOf(checkout, issue);
  await checkFree(run, issue, worktree, at);

  const branch = branchOf(issue, title);
  await checked(run, ["git", "worktree", "add", "-b", branch, worktree, `origin/${TRUNK}`], at);

  const argv = launchArgvOf({ issue, model, effort, settings, prompt: promptOf({ issue, repo, worktree, branch }) });

  const launched = await launch(argv, { cwd: checkout, env: launchEnvOf(env) });

  if (launched.code !== 0) {
    const left = await removalFailures(
      run,
      [
        ["git", "worktree", "remove", worktree],
        ["git", "branch", "-D", branch],
      ],
      at,
    );

    const leftover =
      left.length === 0
        ? ""
        : `. Its worktree and branch are left (${left.join("; ")}): remove them with git worktree remove --force ${worktree} && git branch -D ${branch}`;

    throw new Error(`${failureOf("claude --bg", launched)}${leftover}`);
  }

  return { issue, title, worktree, branch, session: sessionIdOf(launched.stdout) };
}
