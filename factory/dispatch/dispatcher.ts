/**
 * Dispatch: hands one issue to a Worker. It creates the Worker's worktree on a new branch from
 * the Trunk, then launches the Worker as a background session in the main checkout, which enters
 * that worktree itself. An API Worker is launched headless in its worktree instead, detached, on the
 * settings file Dispatch writes for it.
 */

import { Schema } from "effect";

import { TRUNK } from "../install/host.ts";
import { OWNER_LOGIN } from "../install/logins.ts";
import { apiKeyFileOf, apiWorkerLogOf, apiWorkerSettingsOf, firstTurnArgvOf } from "../land/shared/api-worker.ts";
import { decodeJson } from "../lib/json.ts";
import { checked } from "../lib/run.port.ts";
import type { Leave, Ran, Run, RunOptions } from "../lib/run.port.ts";
import { sessionEnvOf } from "../lib/session-env.ts";
import { printableOf } from "../lib/terminal.ts";
import {
  apiKeyProblemOf,
  apiWorkerSettingsTextOf,
  branchOf,
  firstTurnProblemOf,
  INSTALL_ARGV,
  issueBranchesIn,
  launchArgvOf,
  projectSettingsOf,
  promptOf,
  repoOfIssueUrl,
  sessionIdOf,
  sessionNameOf,
  workerSettingsOf,
  workerSettingsProblemOf,
  worktreeListed,
  worktreeOf,
} from "./dispatch-plan.ts";
import type { ApiWorkerPlace, Assignment, DispatchArgs } from "./dispatch-plan.ts";

export interface DispatchPorts {
  readonly run: Run;
  /** Runs the Worker's launch with `options.env` as its whole environment. */
  readonly launch: Run;
  /** Leaves an API Worker's first turn running, with `options.env` as its whole environment. */
  readonly leave: Leave;
  readonly readText: (path: string) => Promise<string>;
  /** Writes `text` to the file at `path`, which only its owner may read. */
  readonly writeSecret: (path: string, text: string) => Promise<void>;
  /** The permission bits of the file at `path`, null when there is none. */
  readonly modeOf: (path: string) => Promise<number | null>;
  /** A new session id. */
  readonly newSession: () => string;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface DispatchRequest extends DispatchArgs {
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
  /** The log an API Worker's turns append their output to; null for a background Worker. */
  readonly log: string | null;
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

/** The text of the Worker settings file at `path`; throws unless it makes the Worker an Author with the machine account's token. */
async function workerSettingsText(readText: DispatchPorts["readText"], path: string): Promise<string> {
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

  return text;
}

/**
 * The text of the API Worker settings file, from the Worker settings file's `text` and the main
 * checkout's settings; throws unless the key's file is there and its owner's alone. It writes nothing:
 * the file every running API Worker reads changes only when a Worker is launched.
 */
async function apiSettingsText(ports: DispatchPorts, place: ApiWorkerPlace, text: string): Promise<string> {
  const key = apiKeyFileOf(place.home);
  const problem = apiKeyProblemOf(await ports.modeOf(key));

  if (problem !== null) {
    throw new Error(`the API key file ${key} ${problem}`);
  }

  return apiWorkerSettingsTextOf(text, await ports.readText(projectSettingsOf(place.checkout)), place);
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

/** What a launch needs besides the assignment: the model, the effort, the settings file, and the caller's place. */
interface Launching {
  readonly model: string;
  readonly effort: DispatchArgs["effort"];
  readonly settings: string;
  readonly checkout: string;
  readonly env: DispatchRequest["env"];
}

/** A launch that went through: what `claude --bg` printed, or the session and the log of an API Worker. */
type Launched =
  | { readonly kind: "background"; readonly stdout: string }
  | { readonly kind: "headless"; readonly session: string; readonly log: string };

/** Launches the Worker as a background session in the main checkout; throws when the launch fails. */
async function launchBackground(
  { launch }: DispatchPorts,
  assignment: Assignment,
  { model, effort, settings, checkout, env }: Launching,
): Promise<Launched> {
  const argv = launchArgvOf({ issue: assignment.issue, model, effort, settings, prompt: promptOf(assignment, false) });
  const launched = await launch(argv, { cwd: checkout, env: sessionEnvOf(env) });

  if (launched.code !== 0) {
    throw new Error(failureOf("claude --bg", launched));
  }

  return { kind: "background", stdout: launched.stdout };
}

/** How long Dispatch looks at an API Worker's first turn before it says the Worker is launched. */
const FIRST_LOOK_MS = 10_000;

/**
 * Launches the API Worker: installs the dependencies of its worktree, which holds the Trunk's files
 * alone, writes its settings file, whose text is `settingsText`, then leaves its first turn running
 * headless in that worktree, its output appended to the session's log in the main checkout. A turn that
 * ends with an error while Dispatch looks, its key refused or its command wrong, throws.
 */
async function launchHeadless(
  { run, leave, newSession, sleep, writeSecret }: DispatchPorts,
  assignment: Assignment,
  { model, effort, settings, checkout, env }: Launching,
  settingsText: string,
): Promise<Launched> {
  const { issue, worktree } = assignment;
  await checked(run, INSTALL_ARGV, { cwd: worktree });
  await writeSecret(settings, settingsText);

  const session = newSession();
  const log = apiWorkerLogOf(checkout, session);
  const turn = { session, model, effort: effort ?? null, settings, checkout, prompt: promptOf(assignment, true) };

  const left = leave(firstTurnArgvOf(turn, sessionNameOf(issue)), { cwd: worktree, env: sessionEnvOf(env), log });
  const problem = firstTurnProblemOf(await Promise.race([left.exited, sleep(FIRST_LOOK_MS).then(() => null)]), log);

  if (problem !== null) {
    throw new Error(problem);
  }

  return { kind: "headless", session, log };
}

/** What a failed launch leaves, said after its failure: nothing, or the worktree and the branch with how to remove them. */
async function leftoverOf(run: Run, { worktree, branch }: Assignment, at: RunOptions): Promise<string> {
  const left = await removalFailures(
    run,
    [
      ["git", "worktree", "remove", worktree],
      ["git", "branch", "-D", branch],
    ],
    at,
  );

  return left.length === 0
    ? ""
    : `. Its worktree and branch are left (${left.join("; ")}): remove them with git worktree remove --force ${worktree} && git branch -D ${branch}`;
}

export async function dispatch(ports: DispatchPorts, request: DispatchRequest): Promise<Dispatched> {
  const { run, readText } = ports;
  const { issue, model, effort, api, checkout, env } = request;
  const home = env["HOME"];

  if (home === undefined) {
    throw new Error("HOME is not set: the Worker settings file lives under it");
  }

  const workerSettings = workerSettingsOf(home);
  const text = await workerSettingsText(readText, workerSettings);
  const apiText = api ? await apiSettingsText(ports, { home, checkout }, text) : null;

  const at = { cwd: checkout };
  const { title, repo } = await ownersIssue(run, issue, at);

  await checked(run, ["git", "fetch", "--prune", "origin"], at);

  const worktree = worktreeOf(checkout, issue);
  await checkFree(run, issue, worktree, at);

  const branch = branchOf(issue, title);
  await checked(run, ["git", "worktree", "add", "-b", branch, worktree, `origin/${TRUNK}`], at);

  const assignment = { issue, repo, worktree, branch };
  const launching = { model, effort, checkout, env };
  let launched: Launched;

  try {
    launched = await (apiText === null
      ? launchBackground(ports, assignment, { ...launching, settings: workerSettings })
      : launchHeadless(ports, assignment, { ...launching, settings: apiWorkerSettingsOf(home) }, apiText));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);

    throw new Error(`${failure}${await leftoverOf(run, assignment, at)}`, { cause: error });
  }

  return launched.kind === "headless"
    ? { issue, title, worktree, branch, session: launched.session, log: launched.log }
    : { issue, title, worktree, branch, session: sessionIdOf(launched.stdout), log: null };
}
