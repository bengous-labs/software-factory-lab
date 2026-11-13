/**
 * What an API Worker is made of, for the steps that launch one, resume it or fork it: a headless
 * session, `claude -p`, whose turns bill the Owner's Console API key. The key stays in its file: the API
 * Worker settings file names a helper command that prints it, so it reaches no command line and no
 * environment, and the sandbox of the session's commands hides its directory from them. A turn loads no
 * settings but that file: the clone's own would run the hooks of the branch the Worker edits. The
 * Worker works in a clone of its own, outside the main checkout: it shares no git directory with the
 * checkout every hook runs from.
 * Dispatch launches the first turn, the relay each later one, both detached, and each turn appends what
 * it printed to one log of the main checkout.
 */

import { API_CLONES_DIR, API_KEY_FILE, CONFIG_DIR } from "../../install/host.ts";
import type { Effort } from "../../lib/effort.ts";

/** The file that holds the Console API key, under the home `home`. */
export function apiKeyFileOf(home: string): string {
  return `${home}/${API_KEY_FILE}`;
}

/**
 * The `apiKeyHelper` command of an API Worker and of its forks: it prints the key file, which Claude
 * Code reads at each start. The path is quoted for the shell that runs the command.
 */
export function apiKeyHelperOf(home: string): string {
  return `cat '${apiKeyFileOf(home).replaceAll("'", String.raw`'\''`)}'`;
}

/** The factory's config directory, which holds the Author's token and the Worker settings files. */
function configDirOf(home: string): string {
  return `${home}/.config/${CONFIG_DIR}`;
}

/** The directory that holds the clone of each API Worker, under the home `home`. */
export function apiClonesDirOf(home: string): string {
  return `${home}/${API_CLONES_DIR}`;
}

/** Where an API Worker's settings are made for: the Owner's home and the repository's main checkout. */
export interface ApiWorkerPlace {
  readonly home: string;
  readonly checkout: string;
}

/**
 * The directories an API Worker's commands and file tools never see: the one that holds the key's file,
 * the factory's own config, whose secrets would land a change around the Land gate, and the main
 * checkout, whose files every hook runs.
 */
function hiddenDirsOf({ home, checkout }: ApiWorkerPlace): string[] {
  const file = apiKeyFileOf(home);

  return [file.slice(0, file.lastIndexOf("/")), configDirOf(home), checkout];
}

/** The hosts an API Worker's commands reach: GitHub, for `git` and `gh`, and the registry `bun install` reads. */
const ALLOWED_DOMAINS = ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"];

/**
 * The sandbox of an API Worker's commands and of its forks': every Bash command runs in it, with no
 * retry outside it, writes under the Worker's clone alone, the network through the
 * hosts above, and no sight of the hidden directories nor of another process. It holds against a command
 * that runs code, which no permission rule does. A session whose sandbox cannot start runs no command.
 */
export function apiWorkerSandboxOf(place: ApiWorkerPlace) {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    credentials: { files: hiddenDirsOf(place).map((path) => ({ path, mode: "deny" })) },
    network: { allowedDomains: ALLOWED_DOMAINS },
  };
}

/**
 * The deny rules on Claude Code's own file tools, which run outside the sandbox: they neither read nor
 * write the hidden directories, through a symbolic link too, and write nothing in the git directory of
 * a clone, whose config and hooks the Stop hook's git reads.
 */
export function apiWorkerDenyRulesOf(place: ApiWorkerPlace): string[] {
  return [
    ...hiddenDirsOf(place).flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]),
    `Edit(/${apiClonesDirOf(place.home)}/*/.git/**)`,
  ];
}

/**
 * What makes a headless command print its result as one JSON object: with no settings source, Claude
 * Code prints every event of the turn unless its settings say so.
 */
export const ONE_RESULT = { verbose: false };

/** The API Worker settings file, which Dispatch writes from the Worker settings file at each API dispatch. */
export function apiWorkerSettingsOf(home: string): string {
  return `${configDirOf(home)}/api-worker-settings.json`;
}

/**
 * The log of the main checkout `checkout` that every turn of the API Worker's session `session` appends
 * its output to. An on-disk name: Dispatch and a running relay write it, and the Owner reads it.
 */
export function apiWorkerLogOf(checkout: string, session: string): string {
  return `${checkout}/.lab/state/api-worker-${session}.log`;
}

/** One headless turn of an API Worker's session. */
export interface HeadlessTurn {
  readonly session: string;
  /** The model the turn runs on; null leaves Claude Code's default, since a headless resume keeps none. */
  readonly model: string | null;
  /**
   * The effort the turn runs at; null leaves Claude Code's own. A resume names none: neither the session
   * nor its transcript keeps the effort of its launch.
   */
  readonly effort: Effort | null;
  /** The API Worker settings file, passed by its path at every turn: a headless session saves no launch option. */
  readonly settings: string;
  /**
   * The main checkout, whose root guide every turn is given. Never the clone's own: Claude Code reads
   * that file outside the sandbox, and a path of the clone is what the Worker makes of it, a
   * symbolic link to a secret included.
   */
  readonly checkout: string;
  readonly prompt: string;
}

/**
 * The settings sources of a turn and of a fork: none. The settings file its command names is all it
 * loads: no hook, plugin or MCP server of the clone, which the Worker edits, and no rule of the
 * Owner's own settings, which could widen the sandbox.
 */
export const NO_SETTING_SOURCES = ["--setting-sources", ""];

/**
 * Claude Code starts an MCP server outside the sandbox, and a `.mcp.json` of the clone names the
 * command of one: a turn takes the servers its own command names, which are none.
 */
const NO_PROJECT_MCP = "--strict-mcp-config";

/** The guide at the root of the main checkout, which a session that loads no project settings is given by its path. */
const ROOT_GUIDE = "AGENTS.md";

/** The permission mode of every turn: a call no allow rule of the settings file covers is denied, since nobody answers a prompt. */
const PERMISSION_MODE = "dontAsk";

function turnArgvOf(start: readonly string[], turn: HeadlessTurn): string[] {
  const { model, effort, settings, checkout, prompt } = turn;

  return [
    "claude",
    "-p",
    ...start,
    ...(model === null ? [] : ["--model", model]),
    ...(effort === null ? [] : ["--effort", effort]),
    "--settings",
    settings,
    ...NO_SETTING_SOURCES,
    NO_PROJECT_MCP,
    "--append-system-prompt-file",
    `${checkout}/${ROOT_GUIDE}`,
    "--permission-mode",
    PERMISSION_MODE,
    "--output-format",
    "json",
    prompt,
  ];
}

/** The command of the first turn of an API Worker: a new session with the id `turn.session`, named `name`. */
export function firstTurnArgvOf(turn: HeadlessTurn, name: string): string[] {
  return turnArgvOf(["--session-id", turn.session, "--name", name], turn);
}

/**
 * The command of a later turn: a headless resume of the session, run in the clone it was launched in.
 * Never `claude --bg --resume`: a background session does not bill the key.
 */
export function resumedTurnArgvOf(turn: HeadlessTurn): string[] {
  return turnArgvOf(["--resume", turn.session], turn);
}
