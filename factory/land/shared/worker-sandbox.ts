/**
 * The sandbox of a Worker, API or background, and of the forks of its stops: the one definition of what
 * its commands and Claude Code's own file tools reach. A Worker runs code, so what holds a secret is
 * never a rule on a command's text. Every Bash command runs in Claude Code's sandbox, where the Owner's
 * whole home is denied to read and a short list under it is allowed again
 * (`factory/install/sandbox-paths.ts`): a secret nobody listed stays unread. The file tools run outside
 * the sandbox: they read under the session's working directories alone, and deny rules name each
 * credential path, which holds through a symbolic link too.
 */

import type { Schema } from "effect";

import { CREDENTIAL_PATHS, READABLE_UNDER_HOME } from "../../install/sandbox-paths.ts";
import { apiClonesDirOf, apiKeyFileOf, configDirOf } from "./api-worker.ts";

/** Where a Worker's sandbox is made for: the Owner's home and the repository's main checkout. */
export interface SandboxPlace {
  readonly home: string;
  readonly checkout: string;
}

/**
 * The kind of Worker a sandbox is made for, by where it works. A background Worker works in a worktree
 * of the main checkout, which it reads whole, its other worktrees included. An API Worker works in a
 * clone of its own under the clones' directory, and the main checkout, whose files every hook runs, is
 * hidden from it.
 */
export type WorkerKind = "background" | "api";

/** Whether the path `inner` is `outer` or lies under it. */
const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

/**
 * The directories of the factory's own secrets, which no command and no file tool of a Worker sees,
 * whatever else the settings allow: the one that holds the API key's file, and the factory's config,
 * whose secrets would land a change around the Land gate.
 */
function secretDirsOf(home: string): string[] {
  const file = apiKeyFileOf(home);

  return [file.slice(0, file.lastIndexOf("/")), configDirOf(home)];
}

/** The directories hidden from a Worker of `kind`: the factory's secrets, and for an API Worker the main checkout. */
function hiddenDirsOf({ home, checkout }: SandboxPlace, kind: WorkerKind): string[] {
  return [...secretDirsOf(home), ...(kind === "api" ? [checkout] : [])];
}

/** The credential paths under the home `home`, by their absolute paths. */
function credentialPathsOf(home: string): string[] {
  return CREDENTIAL_PATHS.map((path) => `${home}/${path}`);
}

/** The characters that make Claude Code read a path of the settings as a pattern. */
const PATTERN_CHARACTER = /[*?[\]]/u;

/**
 * Why no sandbox can be made for `place`, or null when one can. Claude Code reads a path that holds
 * `*`, `?`, `[` or `]` as a pattern, so the settings would not name the home or the checkout they
 * mean. A main checkout that holds the home or a secret, or lies in a secret, would be allowed to read
 * with it: a background Worker reads its checkout whole.
 */
export function sandboxPlaceProblemOf({ home, checkout }: SandboxPlace): string | null {
  for (const [name, path] of [
    ["the home", home],
    ["the main checkout", checkout],
  ] as const) {
    if (PATTERN_CHARACTER.test(path)) {
      return `${name} ${path} holds one of * ? [ ]: Claude Code reads such a path as a pattern, so no sandbox can name it`;
    }
  }

  const secret = [home, ...secretDirsOf(home), ...credentialPathsOf(home)].find(
    (path) => within(checkout, path) || (path !== home && within(path, checkout)),
  );

  return secret === undefined
    ? null
    : `the main checkout ${checkout} holds ${secret} or lies in it: a Worker reads its whole checkout, so the sandbox would hide nothing there`;
}

/** The hosts a Worker's commands reach: GitHub, for `git` and `gh`, and the registry `bun install` reads. */
const ALLOWED_DOMAINS = ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"];

/**
 * What a Worker may do with no one to ask: edit under its working directory, and run any command, since
 * every command runs in the sandbox, which bounds it where no rule on a command's text would.
 */
const WORKER_ALLOW = ["Edit(./**)", "Bash"];

/**
 * Git's configuration for a Worker's commands, through its environment: the repository's remote is read
 * over HTTPS, since the sandbox holds no SSH agent and no key, and a commit or a tag is not signed,
 * since the home holds the signing key.
 */
const GIT_ENV = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "tag.gpgsign",
  GIT_CONFIG_VALUE_2: "false",
};

/**
 * The sandbox of the commands of a Worker of `kind`: every Bash command runs in it, with no retry
 * outside it, and none runs when it cannot start. A command reads nothing under the home but where the
 * Worker works, the main checkout or the clones' directory, and the allowed list; it sees no file of
 * the hidden directories whatever it runs, writes under its working directory alone, and reaches the
 * hosts above. No key widens it: no write path, no excluded command, no Unix socket.
 */
function sandboxOf(place: SandboxPlace, kind: WorkerKind) {
  const { home, checkout } = place;

  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      denyRead: [home],
      allowRead: [
        kind === "api" ? apiClonesDirOf(home) : checkout,
        ...READABLE_UNDER_HOME.map((path) => `${home}/${path}`),
      ],
    },
    credentials: { files: hiddenDirsOf(place, kind).map((path) => ({ path, mode: "deny" })) },
    network: { allowedDomains: ALLOWED_DOMAINS },
  };
}

/**
 * The deny rules on Claude Code's own file tools, which run outside the sandbox: they neither read nor
 * write the hidden directories, read no credential path, the path itself nor what lies under it,
 * through a symbolic link too, and, for an API Worker, write nothing in the git directory of a clone,
 * whose config and hooks the Stop hook's git reads. A rule names an absolute path by a second leading
 * slash.
 */
function denyRulesOf(place: SandboxPlace, kind: WorkerKind): string[] {
  return [
    ...hiddenDirsOf(place, kind).flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]),
    ...(kind === "api" ? [`Edit(/${apiClonesDirOf(place.home)}/*/.git/**)`] : []),
    ...credentialPathsOf(place.home).flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`]),
  ];
}

/** The settings a sandbox is added to, as far as it reads them: their variables and their rules. */
export interface SandboxableSettings {
  readonly env: Readonly<Record<string, string>>;
  readonly permissions?:
    | ({ readonly allow?: readonly string[]; readonly deny?: readonly string[] } & Readonly<
        Record<string, Schema.Json>
      >)
    | undefined;
}

/**
 * `settings`, the Worker settings, with the sandbox a Worker of `kind` has in `place` merged in: git's
 * configuration in the environment, the sandbox, which replaces any the settings held, and the rules of
 * the file tools, which read under the working directories alone. The allow and deny rules add to those
 * the settings hold; every other key stays as it stands.
 */
export function sandboxedOf<Settings extends SandboxableSettings>(
  settings: Settings,
  place: SandboxPlace,
  kind: WorkerKind,
) {
  return {
    ...settings,
    env: { ...settings.env, ...GIT_ENV },
    sandbox: sandboxOf(place, kind),
    permissions: {
      ...settings.permissions,
      blockReadsOutsideWorkingDirectories: true,
      allow: [...(settings.permissions?.allow ?? []), ...WORKER_ALLOW],
      deny: [...(settings.permissions?.deny ?? []), ...denyRulesOf(place, kind)],
    },
  };
}
