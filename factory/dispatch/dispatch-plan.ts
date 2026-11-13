/**
 * What Dispatch decides when it hands an issue to a Worker: the branch and the clone it makes, the one
 * launch prompt, the settings file it writes for the Worker, sandbox and main checkout's hooks included,
 * and the `claude --bg` command that starts the Worker in its clone. For an API Worker, a headless
 * session that bills the Owner's Console API key: its own settings file and the checks Dispatch makes on
 * the key's file.
 */

import { Result, Schema } from "effect";

import { branchMadeFor } from "../contract.ts";
import { TRUNK } from "../install/host.ts";
import { clonesDirOf, configDirOf } from "../install/paths.ts";
import { apiKeyHelperOf, NO_SETTING_SOURCES, ONE_RESULT } from "../land/shared/api-worker.ts";
import { BUN_CACHE_VARIABLE, sandboxedOf } from "../land/shared/worker-sandbox.ts";
import type { SandboxPlace } from "../land/shared/worker-sandbox.ts";
import { API_WORKER_VARIABLE, CHECKOUT_VARIABLE } from "../lib/author-session.ts";
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

/**
 * The clone a Worker works in, under the home `home`: a repository of its own outside the main
 * checkout, where a worktree would share the git directory of the checkout every hook runs from.
 */
export function cloneOf(home: string, issue: number): string {
  return `${clonesDirOf(home)}/issue-${issue}`;
}

/** The command that makes a Worker's clone at `clone`, from the remote at `url`, on the Trunk. */
export function cloneArgvOf(url: string, clone: string): string[] {
  return ["git", "clone", "--quiet", "--branch", TRUNK, url, clone];
}

/** The Worker settings file `factory/install/AGENTS.md` describes, which the Owner provisions. */
export function workerSettingsOf(home: string): string {
  return `${configDirOf(home)}/worker-settings.json`;
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

/** The Worker settings file whole: what the settings Dispatch writes add to, and every other key as it stands. */
const WorkerSettingsFile = Schema.StructWithRest(
  Schema.Struct({
    env: Schema.Record(Schema.String, Schema.String),
    permissions: Schema.optionalKey(
      Schema.StructWithRest(Schema.Struct({ allow: Rules, deny: Rules }), [Schema.Record(Schema.String, Schema.Json)]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

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
 * checkout, which is the worktree the Worker edits. It drops the variable that names the Worker's bun
 * cache first: a hook and what it starts run outside the sandbox, and never read a cache the Worker
 * writes. A command of any other form throws: rewritten by guess, it could still run a file of the
 * worktree.
 */
function mainCheckoutCommandOf(command: string): string {
  const file = HOOK_COMMAND.exec(command)?.[1];

  if (file === undefined || file.split("/").includes("..")) {
    throw new Error(
      `${PROJECT_SETTINGS}: the hook command \`${command}\` is not \`bun "$${PROJECT_VARIABLE}"/<file>\`, the one form an API Worker's settings can run from the main checkout`,
    );
  }

  return `cd "$${CHECKOUT_VARIABLE}" && unset ${BUN_CACHE_VARIABLE} && bun "$${CHECKOUT_VARIABLE}"/${file}`;
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
 * What every Worker's settings are made of, from the Worker settings file's text and the main checkout's
 * `.claude/settings.json`: the Worker's identity, token and rules, in the sandbox of every Worker
 * (`factory/land/shared/worker-sandbox.ts`); the main checkout, which makes the session one that works
 * in a clone; and the main checkout's hooks, each started there. A Worker's session loads no settings
 * but its file: its clone's own would run the hooks of the branch the Worker edits, outside the sandbox.
 */
function cloneWorkerSettingsOf(workerSettings: string, projectSettings: string, place: SandboxPlace) {
  const settings = sandboxedOf(decodeJson(WorkerSettingsFile, "the Worker settings file", workerSettings), place);

  return {
    ...settings,
    env: { ...settings.env, [CHECKOUT_VARIABLE]: place.checkout },
    hooks: mainCheckoutHooksOf(projectSettings),
  };
}

/**
 * The text of the API Worker settings file, the only settings an API Worker's turn loads: what every
 * Worker's settings are made of; the helper that prints the key, so the key enters no environment; and
 * the marker that makes the session an API Worker.
 */
export function apiWorkerSettingsTextOf(workerSettings: string, projectSettings: string, place: SandboxPlace): string {
  const settings = cloneWorkerSettingsOf(workerSettings, projectSettings, place);

  const added = {
    ...settings,
    ...ONE_RESULT,
    apiKeyHelper: apiKeyHelperOf(place.home),
    env: { ...settings.env, [API_WORKER_VARIABLE]: "1" },
  };

  return `${JSON.stringify(added, null, 2)}\n`;
}

/**
 * The background Worker settings file, which Dispatch writes from the Worker settings file at each
 * dispatch of a background Worker. An on-disk name: running sessions were launched on it.
 */
export function backgroundWorkerSettingsOf(home: string): string {
  return `${configDirOf(home)}/background-worker-settings.json`;
}

/** The permission mode of a background Worker: a call no allow rule covers is denied, since nobody answers a prompt. */
const BACKGROUND_MODE = "dontAsk";

/**
 * The text of the background Worker settings file, the only settings a background Worker's session
 * loads: what every Worker's settings are made of, in a mode that asks nothing. It runs any command, in
 * the sandbox, and edits under its clone.
 */
export function backgroundWorkerSettingsTextOf(
  workerSettings: string,
  projectSettings: string,
  place: SandboxPlace,
): string {
  const settings = cloneWorkerSettingsOf(workerSettings, projectSettings, place);
  const added = { ...settings, permissions: { ...settings.permissions, defaultMode: BACKGROUND_MODE } };

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

export interface Assignment {
  readonly issue: number;
  readonly repo: string;
  /** The tree the Worker works in: its clone. */
  readonly worktree: string;
  readonly branch: string;
}

/**
 * The one launch prompt. It names the issue and the Worker's clone, where its session starts; what a
 * Worker does comes from its own instructions, `AGENTS.md`, never from here.
 */
export function promptOf({ issue, repo, worktree, branch }: Assignment): string {
  return `Implement GitHub issue #${issue} of ${repo} (read it with: gh issue view ${issue} --repo ${repo}). You are in your own clone of the repository, ${worktree}: work there; its branch ${branch} starts at origin/${TRUNK}.`;
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
 * The install that gives a Worker's clone its dependencies, run by Dispatch before the Worker exists,
 * while the clone holds the Trunk's files alone. No hook installs for such a Worker: a hook runs outside
 * the sandbox, and an install in a directory the Worker has written follows what it left there. The
 * command of `scripts/hooks/install-deps.ts`: copies, never hardlinks into bun's cache, and no
 * lifecycle script.
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
  /** The background Worker settings file, passed by its path: its token never reaches the command line. */
  readonly settings: string;
  /** The main checkout, whose root guide the session is given: it loads no project settings. */
  readonly checkout: string;
  readonly prompt: string;
}

/**
 * The command that starts a background Worker, in its clone. The session loads no settings but its
 * file, and no MCP server but those its command names, which are none: the clone's own settings would
 * run the hooks of the branch the Worker edits, a `.mcp.json` of the clone names a command Claude Code
 * starts outside the sandbox, and the Owner's own settings can widen a sandbox. The guide it is given is
 * the main checkout's: Claude Code reads that file outside the sandbox, and a path of the clone can be
 * a link to a secret.
 */
export function launchArgvOf({ issue, model, effort, settings, checkout, prompt }: Launch): string[] {
  return [
    "claude",
    "--bg",
    "--model",
    model,
    ...(effort === undefined ? [] : ["--effort", effort]),
    "--settings",
    settings,
    ...NO_SETTING_SOURCES,
    "--strict-mcp-config",
    "--append-system-prompt-file",
    `${checkout}/AGENTS.md`,
    "--name",
    sessionNameOf(issue),
    prompt,
  ];
}

/** What Claude Code prints when it starts no background session in a workspace nobody trusted. */
const NOT_TRUSTED = "Workspace not trusted";

/**
 * What Dispatch adds to `failure`, the failure of a background launch as it tells it, when Claude Code
 * refused the launch for workspace trust; nothing for any other failure. Claude Code's own words stay:
 * they advise to accept the trust prompt in the clone, which the failed dispatch removes, and trust
 * never reaches a new clone, so the advice that works is an API Worker.
 */
export function trustAdviceOf(failure: string): string {
  return failure.includes(NOT_TRUSTED)
    ? " (no new clone has that trust: hand the issue to an API Worker with --api)"
    : "";
}

/** The id of the session `claude --bg` started, read from the `claude stop <id>` hint it prints. */
export function sessionIdOf(stdout: string): string {
  const id = /^\s*claude stop (\S+)/mu.exec(stdout)?.[1];

  if (id === undefined) {
    throw new Error(`claude --bg printed no session id: ${stdout.trim()}`);
  }

  return id;
}
