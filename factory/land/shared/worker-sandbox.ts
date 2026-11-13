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

import { apiKeyFileOf, clonesDirOf, configDirOf } from "../../install/paths.ts";
import { CREDENTIAL_PATHS, READABLE_UNDER_HOME } from "../../install/sandbox-paths.ts";

/**
 * Where a Worker's sandbox is made for: the Owner's home and the repository's main checkout, which is
 * hidden from the Worker. It works in a clone of its own, its session's working directory.
 */
export interface SandboxPlace {
  readonly home: string;
  readonly checkout: string;
}

/**
 * The directories of the factory's own secrets, which no command and no file tool of a Worker sees,
 * whatever else the settings allow: the one that holds the API key's file, and the factory's config,
 * whose secrets would land a change around the Land gate.
 */
function secretDirsOf(home: string): string[] {
  const file = apiKeyFileOf(home);

  return [file.slice(0, file.lastIndexOf("/")), configDirOf(home)];
}

/**
 * The directories hidden from a Worker: the factory's secrets, and the main checkout, whose files every
 * hook runs outside the sandbox.
 */
function hiddenDirsOf({ home, checkout }: SandboxPlace): string[] {
  return [...secretDirsOf(home), checkout];
}

/** The credential paths under the home `home`, by their absolute paths. */
function credentialPathsOf(home: string): string[] {
  return CREDENTIAL_PATHS.map((path) => `${home}/${path}`);
}

/** The variable that names bun's install cache. Dispatch keeps it from every hook, which runs outside the sandbox. */
export const BUN_CACHE_VARIABLE = "BUN_INSTALL_CACHE_DIR";

/**
 * bun's install cache in a Worker's session: a path bun reads from the directory it starts in, so the
 * `.lab/bun-cache` of the clone, which git ignores, for a command run at the clone's root, and a cache
 * of its own for a `bun` started elsewhere, a test's fixture in the temporary directory. `bun install`
 * needs a cache it can write, and one the Workers shared would let a Worker leave a package the next one
 * installs. The settings file is one for every Worker of a kind, so it cannot name a clone: a relative
 * path is what gives each its own, where the sandbox lets it write with no entry.
 */
const BUN_CACHE_IN_CLONE = ".lab/bun-cache";

/** The characters that make Claude Code read a path of the settings as a pattern. */
const PATTERN_CHARACTER = /[*?[\]]/u;

/**
 * Why no sandbox can be made for `place`, or null when one can. Claude Code reads a path that holds
 * `*`, `?`, `[` or `]` as a pattern, so the settings would not name the home or the checkout they mean.
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

  return null;
}

/** The hosts a Worker's commands reach: GitHub, for `git` and `gh`, and the registry `bun install` reads. */
const ALLOWED_DOMAINS = ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"];

/**
 * What a Worker may do with no one to ask: edit under its working directory, its clone, and run any command, since
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
 * The sandbox of a Worker's commands: every Bash command runs in it, with no retry outside it, and none
 * runs when it cannot start. A command reads nothing under the home but its working directory, the
 * Worker's clone, which the sandbox lets it read and write with no entry, and the allowed list; it sees
 * no file of the hidden directories whatever it runs, the main checkout among them, and reaches the
 * hosts above. No entry holds the clone: an entry that is a parent of the working directory makes the
 * sandbox fail to start (`bwrap` cannot place its guards in a directory bound read-only). No key widens
 * the sandbox: no write path, no excluded command, no Unix socket.
 */
function sandboxOf(place: SandboxPlace) {
  const { home } = place;

  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      denyRead: [home],
      allowRead: READABLE_UNDER_HOME.map((path) => `${home}/${path}`),
    },
    credentials: { files: hiddenDirsOf(place).map((path) => ({ path, mode: "deny" })) },
    network: { allowedDomains: ALLOWED_DOMAINS },
  };
}

/**
 * The deny rules on Claude Code's own file tools, which run outside the sandbox: they neither read nor
 * write the hidden directories, read no credential path, the path itself nor what lies under it,
 * through a symbolic link too, and write nothing in the git directory of a clone, whose config and
 * hooks the Stop hook's git reads. A rule names an absolute path by a second leading slash.
 */
function denyRulesOf(place: SandboxPlace): string[] {
  return [
    ...hiddenDirsOf(place).flatMap((dir) => [`Read(/${dir}/**)`, `Edit(/${dir}/**)`]),
    `Edit(/${clonesDirOf(place.home)}/*/.git/**)`,
    ...credentialPathsOf(place.home).flatMap((path) => [`Read(/${path})`, `Read(/${path}/**)`]),
  ];
}

/** The settings a sandbox is added to, as far as it reads them: their variables and their rules. */
export interface SandboxableSettings {
  /** Undefined for settings that hold no variable: a fork's. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly permissions?:
    | ({ readonly allow?: readonly string[]; readonly deny?: readonly string[] } & Readonly<
        Record<string, Schema.Json>
      >)
    | undefined;
}

/**
 * `settings`, the Worker settings, with the sandbox of `place` merged in: git's configuration and bun's
 * cache in the environment, the sandbox, which replaces any the settings held, and the rules of the file
 * tools, which read under the working directories alone. The allow and deny rules add to those the
 * settings hold; every other key stays as it stands.
 */
export function sandboxedOf<Settings extends SandboxableSettings>(settings: Settings, place: SandboxPlace) {
  return {
    ...settings,
    env: { ...settings.env, ...GIT_ENV, [BUN_CACHE_VARIABLE]: BUN_CACHE_IN_CLONE },
    sandbox: sandboxOf(place),
    permissions: {
      ...settings.permissions,
      blockReadsOutsideWorkingDirectories: true,
      allow: [...(settings.permissions?.allow ?? []), ...WORKER_ALLOW],
      deny: [...(settings.permissions?.deny ?? []), ...denyRulesOf(place)],
    },
  };
}
