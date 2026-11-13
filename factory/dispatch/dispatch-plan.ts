/**
 * What Dispatch decides when it hands an issue to a Worker: the branch and the worktree it creates, the
 * one launch prompt, and the `claude --bg` command that starts the Worker in the main checkout. For an
 * API Worker, a headless session that bills the Owner's Console API key: the settings file it writes
 * and the checks it makes on the key's file.
 */

import { Result, Schema } from "effect";

import { branchMadeFor } from "../contract.ts";
import { CONFIG_DIR, TRUNK } from "../install/host.ts";
import {
  apiClonesDirOf,
  apiKeyHelperOf,
  apiWorkerDenyRulesOf,
  apiWorkerSandboxOf,
  ONE_RESULT,
} from "../land/shared/api-worker.ts";
import type { ApiWorkerPlace } from "../land/shared/api-worker.ts";
import { API_WORKER_VARIABLE } from "../lib/author-session.ts";
import { Effort } from "../lib/effort.ts";
import { decodeJson } from "../lib/json.ts";

export interface DispatchArgs {
  readonly issue: number;
  readonly model: string;
  /** Undefined, the Worker runs at the effort Claude Code picks. */
  readonly effort: Effort | undefined;
  /** The Worker is an API Worker: it runs headless and bills the Console API key, not the subscription. */
  readonly api: boolean;
}

const API_FLAG = "--api";

const USAGE = `usage: bun factory/bin/dispatch.ts <issue> [--model <model>] [--effort <${Effort.literals.join("|")}>] [${API_FLAG}]`;

/** The issue, the model, the effort and the bill `argv` names; throws the usage on anything else. */
export function dispatchArgsOf(argv: readonly string[]): DispatchArgs {
  const words = argv.filter((word) => word !== API_FLAG);
  const model = flagOf(words, "--model");
  const effort = flagOf(model.rest, "--effort");
  const issue = effort.rest.join(" ");

  if (!/^[1-9]\d*$/u.test(issue)) {
    throw new Error(USAGE);
  }

  if (effort.value !== undefined && !Schema.is(Effort)(effort.value)) {
    throw new Error(USAGE);
  }

  return {
    issue: Number(issue),
    model: model.value ?? "opus",
    effort: effort.value,
    api: words.length < argv.length,
  };
}

interface Flag {
  /** Undefined when `argv` holds no such flag. */
  readonly value: string | undefined;
  /** `argv` without the flag and its value. */
  readonly rest: readonly string[];
}

/** The value `argv` gives the flag `name`; throws the usage on a flag with no value. */
function flagOf(argv: readonly string[], name: string): Flag {
  const at = argv.indexOf(name);

  if (at === -1) {
    return { value: undefined, rest: argv };
  }

  const value = argv[at + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(USAGE);
  }

  return { value, rest: argv.filter((_, index) => index !== at && index !== at + 1) };
}

const SLUG_MAX = 40;

/** The title's words in lower case joined by dashes, cut at a word to at most 40 characters. */
export function slugOf(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/gu) ?? [];

  const overflow = words.findIndex((_, index) => words.slice(0, index + 1).join("-").length > SLUG_MAX);
  const kept = overflow === -1 ? words : words.slice(0, overflow);
  const slug = kept.length === 0 ? (words[0]?.slice(0, SLUG_MAX) ?? "") : kept.join("-");

  return slug === "" ? "issue" : slug;
}

/** `issue/<n>-<slug>`: the Stop hook reads a branch `<type>/<n>-…` as made for issue n, and closes it. */
export function branchOf(issue: number, title: string): string {
  return `issue/${issue}-${slugOf(title)}`;
}

export function worktreeOf(checkout: string, issue: number): string {
  return `${checkout}/.claude/worktrees/issue-${issue}`;
}

/**
 * The clone an API Worker works in, under the home `home`: a repository of its own outside the main
 * checkout, where a worktree would share the git directory of the checkout every hook runs from.
 */
export function apiCloneOf(home: string, issue: number): string {
  return `${apiClonesDirOf(home)}/issue-${issue}`;
}

/** The command that makes an API Worker's clone at `clone`, from the remote at `url`, on the Trunk. */
export function cloneArgvOf(url: string, clone: string): string[] {
  return ["git", "clone", "--quiet", "--branch", TRUNK, url, clone];
}

/** The Worker settings file `factory/install/AGENTS.md` describes, which the Owner provisions. */
export function workerSettingsOf(home: string): string {
  return `${home}/.config/${CONFIG_DIR}/worker-settings.json`;
}

/**
 * Why the Worker settings file would not make the Worker an Author with the machine account's token,
 * or null when it does. The file holds the token: no problem quotes it.
 */
export function workerSettingsProblemOf(text: string): string | null {
  const decoded = Schema.decodeResult(Schema.fromJsonString(WorkerSettings))(text);

  if (Result.isFailure(decoded)) {
    return "is not JSON with an env of strings";
  }

  const { LAB_AUTHOR, GH_TOKEN } = decoded.success.env;

  if (LAB_AUTHOR !== "1") {
    return 'env.LAB_AUTHOR is not "1"';
  }

  return GH_TOKEN === undefined || GH_TOKEN === "" ? "env.GH_TOKEN is not set" : null;
}

const WorkerSettings = Schema.Struct({
  env: Schema.Struct({ LAB_AUTHOR: Schema.optional(Schema.String), GH_TOKEN: Schema.optional(Schema.String) }),
});

const Rules = Schema.optionalKey(Schema.Array(Schema.String));

/** The Worker settings file whole: what an API Worker's settings add to, and every other key as it stands. */
const WorkerSettingsFile = Schema.StructWithRest(
  Schema.Struct({
    env: Schema.Record(Schema.String, Schema.String),
    permissions: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({ allow: Rules, deny: Rules }), [Schema.Record(Schema.String, Schema.Json)]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

/**
 * What an API Worker may do with no one to ask: edit under its clone, and run any command, since
 * every command runs in the sandbox, which bounds it where no rule on a command's text would.
 */
const API_WORKER_ALLOW = ["Edit(./**)", "Bash"];

/**
 * The variable that holds the main checkout in an API Worker's session: its hooks are the main
 * checkout's, named through it. An external name: the API Worker settings file and running sessions hold it.
 */
export const CHECKOUT_VARIABLE = "LAB_MAIN_CHECKOUT";

/** The variable Claude Code gives a hook for the session's own checkout, which is the worktree for an API Worker. */
const PROJECT_VARIABLE = "CLAUDE_PROJECT_DIR";

const Rest = Schema.Record(Schema.String, Schema.Json);

/** A hook as `.claude/settings.json` wires it, as far as an API Worker's settings rewrite it: its command. */
const Hook = Schema.StructWithRest(Schema.Struct({ command: Schema.String }), [Rest]);

const HookGroup = Schema.StructWithRest(Schema.Struct({ hooks: Schema.Array(Hook) }), [Rest]);

const ProjectSettings = Schema.Struct({ hooks: Schema.Record(Schema.String, Schema.Array(HookGroup)) });

const PROJECT_SETTINGS = "the main checkout's .claude/settings.json";

/** The one form of a hook's command an API Worker's settings take: `bun`, then a file of the session's own checkout. */
const HOOK_COMMAND = new RegExp(String.raw`^bun "\$${PROJECT_VARIABLE}"/([\w./-]+)$`, "u");

/**
 * The command of a hook for an API Worker, from the one `.claude/settings.json` writes: it starts in the
 * main checkout and runs the main checkout's file. The start matters as much as the file: `bun` reads
 * the `bunfig.toml` and the `.env` of the directory it starts in, and a session's hooks start in its own
 * checkout, which is the worktree the Worker edits. A command of any other form throws: rewritten by
 * guess, it could still run a file of the worktree.
 */
function mainCheckoutCommandOf(command: string): string {
  const file = HOOK_COMMAND.exec(command)?.[1];

  if (file === undefined || file.split("/").includes("..")) {
    throw new Error(
      `${PROJECT_SETTINGS}: the hook command \`${command}\` is not \`bun "$${PROJECT_VARIABLE}"/<file>\`, the one form an API Worker's settings can run from the main checkout`,
    );
  }

  return `cd "$${CHECKOUT_VARIABLE}" && bun "$${CHECKOUT_VARIABLE}"/${file}`;
}

/**
 * The hooks of the main checkout's `.claude/settings.json`, from its text, each command rewritten by
 * `mainCheckoutCommandOf`: the guards, the Stop hook and the relay it leaves then run from files the
 * Worker cannot edit, in a directory it cannot write, as a background Worker's do.
 */
function mainCheckoutHooksOf(projectSettings: string) {
  const { hooks } = decodeJson(ProjectSettings, PROJECT_SETTINGS, projectSettings);

  return Object.fromEntries(
    Object.entries(hooks).map(([event, groups]) => [
      event,
      groups.map((group) => ({
        ...group,
        hooks: group.hooks.map((hook) => ({ ...hook, command: mainCheckoutCommandOf(hook.command) })),
      })),
    ]),
  );
}

/**
 * The text of the API Worker settings file, the only settings an API Worker's turn loads, from the
 * Worker settings file's and the main checkout's `.claude/settings.json`: the Worker's identity, token
 * and rules; the helper that prints the key, so the key enters no environment; the marker that makes
 * the session an API Worker; the main checkout's hooks; the sandbox, which hides the key and the
 * factory's own secrets from every command; the allow rules above, and deny rules on the same
 * directories for Claude Code's own file tools. Git reads the repository's remote over HTTPS in such a session: the sandbox holds no SSH agent.
 */
export function apiWorkerSettingsTextOf(
  workerSettings: string,
  projectSettings: string,
  place: ApiWorkerPlace,
): string {
  const { home, checkout } = place;
  const settings = decodeJson(WorkerSettingsFile, "the Worker settings file", workerSettings);

  const added = {
    ...settings,
    ...ONE_RESULT,
    apiKeyHelper: apiKeyHelperOf(home),
    env: {
      ...settings.env,
      [API_WORKER_VARIABLE]: "1",
      [CHECKOUT_VARIABLE]: checkout,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_0: "git@github.com:",
    },
    hooks: mainCheckoutHooksOf(projectSettings),
    sandbox: apiWorkerSandboxOf(place),
    permissions: {
      ...settings.permissions,
      allow: [...(settings.permissions?.allow ?? []), ...API_WORKER_ALLOW],
      deny: [...(settings.permissions?.deny ?? []), ...apiWorkerDenyRulesOf(place)],
    },
  };

  return `${JSON.stringify(added, null, 2)}\n`;
}

/** The main checkout's settings file, whose hooks an API Worker runs. */
export function projectSettingsOf(checkout: string): string {
  return `${checkout}/.claude/settings.json`;
}

/**
 * Why the key's file would not do, from its permission bits, null for a missing file; or null when it
 * does. Dispatch reads the file's mode alone, never the key.
 */
export function apiKeyProblemOf(mode: number | null): string | null {
  if (mode === null) {
    return "is missing";
  }

  return (mode & 0o077) === 0 ? null : "is readable by its group or by others: set its mode to 600";
}

/** `owner/name` of the repository of the issue at `url`. */
export function repoOfIssueUrl(url: string): string {
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/u.exec(url)?.[1];

  if (repo === undefined) {
    throw new Error(`not an issue URL: ${url}`);
  }

  return repo;
}

/** The branches among `refs`, one short ref name a line, that were made for `issue`. */
export function issueBranchesIn(refs: string, issue: number): string[] {
  return refs.split("\n").filter((ref) => branchMadeFor(ref, issue));
}

/** Whether `git worktree list --porcelain` printed `path` among its worktrees. */
export function worktreeListed(listing: string, path: string): boolean {
  return listing.split("\n").includes(`worktree ${path}`);
}

export interface Assignment {
  readonly issue: number;
  readonly repo: string;
  /** The tree the Worker works in: its worktree of the main checkout, or the clone of an API Worker. */
  readonly worktree: string;
  readonly branch: string;
}

/**
 * The one launch prompt. It names the issue and the Worker's tree; what a Worker does comes from its own
 * instructions, `AGENTS.md`, never from here. A Worker launched in the main checkout enters its worktree
 * itself; one `launchedInClone`, an API Worker, is told it is in its clone.
 */
export function promptOf({ issue, repo, worktree, branch }: Assignment, launchedInClone: boolean): string {
  const place = launchedInClone
    ? `You are in your own clone of the repository, ${worktree}: work there`
    : `Your worktree exists: first call EnterWorktree with the path ${worktree} and work there`;

  return `Implement GitHub issue #${issue} of ${repo} (read it with: gh issue view ${issue} --repo ${repo}). ${place}; its branch ${branch} starts at origin/${TRUNK}.`;
}

/**
 * Why an API Worker's first turn did not start working, from the exit code it ended with while Dispatch
 * looked, null while it still runs; or null when nothing says so. `log` holds what the turn printed.
 */
export function firstTurnProblemOf(code: number | null, log: string): string | null {
  return code === null || code === 0
    ? null
    : `the API Worker's first turn ended at once with exit ${code}: ${log} holds what it printed`;
}

/**
 * The install that gives an API Worker's clone its dependencies, run by Dispatch before the Worker
 * exists, while the clone holds the Trunk's files alone. No hook installs for an API Worker: a hook
 * runs outside the sandbox, and an install in a directory the Worker has written follows what it left
 * there. The command of `scripts/hooks/install-deps.ts`: copies, never hardlinks into bun's cache, and
 * no lifecycle script.
 */
export const INSTALL_ARGV = ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"];

/** The name of the Worker's session, which Claude Code shows where it lists sessions. */
export function sessionNameOf(issue: number): string {
  return `w-issue-${issue}`;
}

export interface Launch {
  readonly issue: number;
  readonly model: string;
  readonly effort: Effort | undefined;
  /** The Worker settings file, passed by its path: its token never reaches the command line. */
  readonly settings: string;
  readonly prompt: string;
}

export function launchArgvOf({ issue, model, effort, settings, prompt }: Launch): string[] {
  return [
    "claude",
    "--bg",
    "--model",
    model,
    ...(effort === undefined ? [] : ["--effort", effort]),
    "--settings",
    settings,
    "--name",
    sessionNameOf(issue),
    prompt,
  ];
}

/** The id of the session `claude --bg` started, read from the `claude stop <id>` hint it prints. */
export function sessionIdOf(stdout: string): string {
  const id = /^\s*claude stop (\S+)/mu.exec(stdout)?.[1];

  if (id === undefined) {
    throw new Error(`claude --bg printed no session id: ${stdout.trim()}`);
  }

  return id;
}
