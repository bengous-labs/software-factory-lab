/**
 * Dispatch: hands one issue to a Worker. It makes the Worker a clone of its own, outside the main
 * checkout, on a new branch from the Trunk, installs it, then launches the Worker there: a background
 * session, or for an API Worker a headless one, detached. Either runs on the settings file Dispatch
 * writes for its kind, which holds its sandbox and the main checkout's hooks.
 */

import { Schema } from "effect";

import { OWNER_LOGIN } from "../install/logins.ts";
import { apiKeyFileOf } from "../install/paths.ts";
import { apiWorkerLogOf, apiWorkerSettingsOf, firstTurnArgvOf } from "../land/shared/api-worker.ts";
import { sandboxPlaceProblemOf } from "../land/shared/worker-sandbox.ts";
import type { SandboxPlace } from "../land/shared/worker-sandbox.ts";
import { decodeJson } from "../lib/json.ts";
import { checked } from "../lib/run.port.ts";
import type { Leave, Ran, Run, RunOptions } from "../lib/run.port.ts";
import { sessionEnvOf } from "../lib/session-env.ts";
import { printableOf } from "../lib/terminal.ts";
import {
  apiKeyProblemOf,
  apiWorkerSettingsTextOf,
  backgroundWorkerSettingsOf,
  backgroundWorkerSettingsTextOf,
  branchOf,
  cloneArgvOf,
  cloneOf,
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
} from "./dispatch-plan.ts";
import type { Assignment, DispatchArgs } from "./dispatch-plan.ts";

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
  /** The tree the Worker works in: its clone. */
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
async function apiSettingsText(ports: DispatchPorts, place: SandboxPlace, text: string): Promise<string> {
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

/** Throws, naming what to remove, when the issue already has a clone or a branch. */
async function checkFree({ run, modeOf }: DispatchPorts, issue: number, clone: string, at: RunOptions): Promise<void> {
  if ((await modeOf(clone)) !== null) {
    throw new Error(`issue #${issue} already has a clone: ${clone}. Remove it first (rm -rf ${clone})`);
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

/**
 * What a launch needs besides the assignment: the model, the effort, the settings file Dispatch writes
 * with its text, and the caller's place.
 */
interface Launching {
  readonly model: string;
  readonly effort: DispatchArgs["effort"];
  readonly settings: string;
  readonly settingsText: string;
  readonly checkout: string;
  readonly env: DispatchRequest["env"];
}

/** A launch that went through: what `claude --bg` printed, or the session and the log of an API Worker. */
type Launched =
  | { readonly kind: "background"; readonly stdout: string }
  | { readonly kind: "headless"; readonly session: string; readonly log: string };

/**
 * Makes the Worker's clone, which holds the Trunk's files alone, ready for its session: creates its
 * branch and installs its dependencies there, then writes the settings file of its kind.
 */
async function prepare(
  { run, writeSecret }: DispatchPorts,
  { worktree, branch }: Assignment,
  { settings, settingsText }: Launching,
): Promise<void> {
  await checked(run, ["git", "switch", "--quiet", "--create", branch], { cwd: worktree });
  await checked(run, INSTALL_ARGV, { cwd: worktree });
  await writeSecret(settings, settingsText);
}

/** Launches the background Worker in its clone, on its settings file; throws when the launch fails. */
async function launchBackground(ports: DispatchPorts, assignment: Assignment, launching: Launching): Promise<Launched> {
  const { model, effort, settings, checkout, env } = launching;
  await prepare(ports, assignment, launching);

  const argv = launchArgvOf({
    issue: assignment.issue,
    model,
    effort,
    settings,
    checkout,
    prompt: promptOf(assignment),
  });

  const launched = await ports.launch(argv, { cwd: assignment.worktree, env: sessionEnvOf(env) });

  if (launched.code !== 0) {
    throw new Error(failureOf("claude --bg", launched));
  }

  return { kind: "background", stdout: launched.stdout };
}

/** How long Dispatch looks at an API Worker's first turn before it says the Worker is launched. */
const FIRST_LOOK_MS = 10_000;

/**
 * Launches the API Worker in its clone: leaves its first turn running headless there, its output
 * appended to the session's log in the main checkout. A turn that ends with an error while Dispatch
 * looks, its key refused or its command wrong, throws.
 */
async function launchHeadless(ports: DispatchPorts, assignment: Assignment, launching: Launching): Promise<Launched> {
  const { leave, newSession, sleep } = ports;
  const { model, effort, settings, checkout, env } = launching;
  const { issue, worktree } = assignment;
  await prepare(ports, assignment, launching);

  const session = newSession();
  const log = apiWorkerLogOf(checkout, session);
  const turn = { session, model, effort: effort ?? null, settings, checkout, prompt: promptOf(assignment) };

  const left = leave(firstTurnArgvOf(turn, sessionNameOf(issue)), { cwd: worktree, env: sessionEnvOf(env), log });
  const problem = firstTurnProblemOf(await Promise.race([left.exited, sleep(FIRST_LOOK_MS).then(() => null)]), log);

  if (problem !== null) {
    throw new Error(problem);
  }

  return { kind: "headless", session, log };
}

/** What a failed launch leaves, said after its failure: nothing, or the Worker's clone, with how to remove it. */
async function leftoverOf(run: Run, { worktree }: Assignment, at: RunOptions): Promise<string> {
  const left = await removalFailures(run, [["rm", "-rf", "--", worktree]], at);

  return left.length === 0 ? "" : `. Its clone is left (${left.join("; ")}): remove it with rm -rf ${worktree}`;
}

export async function dispatch(ports: DispatchPorts, request: DispatchRequest): Promise<Dispatched> {
  const { run, readText } = ports;
  const { issue, model, effort, api, checkout, env } = request;
  const home = env["HOME"];

  if (home === undefined) {
    throw new Error("HOME is not set: the Worker settings file lives under it");
  }

  const place = { home, checkout };
  const placeProblem = sandboxPlaceProblemOf(place);

  if (placeProblem !== null) {
    throw new Error(`no Worker can be sandboxed here: ${placeProblem}`);
  }

  const text = await workerSettingsText(readText, workerSettingsOf(home));

  const settingsText = api
    ? await apiSettingsText(ports, place, text)
    : backgroundWorkerSettingsTextOf(text, await readText(projectSettingsOf(checkout)), place);

  const at = { cwd: checkout };
  const { title, repo } = await ownersIssue(run, issue, at);

  await checked(run, ["git", "fetch", "--prune", "origin"], at);

  const worktree = cloneOf(home, issue);
  await checkFree(ports, issue, worktree, at);

  const branch = branchOf(issue, title);
  const remote = (await checked(run, ["git", "remote", "get-url", "origin"], at)).trim();
  await checked(run, cloneArgvOf(remote, worktree), at);

  const assignment = { issue, repo, worktree, branch };
  const launching = { model, effort, settingsText, checkout, env };
  let launched: Launched;

  try {
    launched = await (api
      ? launchHeadless(ports, assignment, { ...launching, settings: apiWorkerSettingsOf(home) })
      : launchBackground(ports, assignment, { ...launching, settings: backgroundWorkerSettingsOf(home) }));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);

    throw new Error(`${failure}${await leftoverOf(run, assignment, at)}`, { cause: error });
  }

  return launched.kind === "headless"
    ? { issue, title, worktree, branch, session: launched.session, log: launched.log }
    : { issue, title, worktree, branch, session: sessionIdOf(launched.stdout), log: null };
}
