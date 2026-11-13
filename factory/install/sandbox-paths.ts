/**
 * What a Worker's commands and file tools read under the Owner's home, and what they never do, each by
 * its path from that home. The sandbox of a Worker (`factory/land/shared/worker-sandbox.ts`) denies the
 * whole home and re-allows the first list; the second names the credentials a deny rule spells out for
 * Claude Code's own file tools, which run outside the sandbox.
 */

import { CONFIG_DIR } from "./host.ts";

/**
 * What a Worker's commands need under the home: the toolchain mise installed, bun's install cache, and
 * git's own configuration without its credentials. No entry is the home, a credential path, or a parent
 * of one (`sandbox-paths.test.ts`).
 */
export const READABLE_UNDER_HOME = [
  ".local/share/mise/installs",
  ".bun/install/cache",
  ".gitconfig",
  ".config/git/config",
  ".config/git/ignore",
];

/** Where credentials live under a home: SSH and GPG keys, the logins of `gh`, of cloud and registry tools, and of git. */
export const CREDENTIAL_PATHS = [
  ".ssh",
  ".config/gh",
  ".gnupg",
  ".aws",
  ".docker",
  ".kube",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  ".config/git/credentials",
];

/**
 * The credential directories the sandbox probe (`factory/bin/sandbox-probe.ts`) puts a canary file in,
 * when they exist. The first is the one its symbolic links point into.
 */
export const PROBED_CREDENTIAL_DIRS = [".ssh", ".config/gh", ".gnupg"];

/** The Owner's own Claude Code settings file, whose write paths a background Worker's sandbox must not take. */
export const USER_SETTINGS = ".claude/settings.json";

/**
 * bun's install cache of the Workers alone, by its path from the home: the one directory outside its
 * working directory a Worker's command writes. `bun install` needs a cache it can write, and the Owner's
 * own cache, which every other install of the machine trusts, stays read-only.
 */
export const WORKERS_BUN_CACHE = `.local/share/${CONFIG_DIR}/bun-cache`;
