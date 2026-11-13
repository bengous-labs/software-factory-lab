import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_PATHS,
  PROBED_CREDENTIAL_DIRS,
  READABLE_UNDER_HOME,
  USER_SETTINGS,
  WORKERS_BUN_CACHE,
} from "./sandbox-paths.ts";

/** Whether the path `inner` is `outer` or lies under it. */
const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

describe("what a Worker reads under the home", () => {
  test("is the toolchain, bun's cache and git's configuration, and nothing else", () => {
    expect(READABLE_UNDER_HOME).toEqual([
      ".local/share/mise/installs",
      ".bun/install/cache",
      ".gitconfig",
      ".config/git/config",
      ".config/git/ignore",
    ]);
  });

  test("the credential paths are the keys and the logins a home holds", () => {
    expect(CREDENTIAL_PATHS).toEqual([
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
    ]);
  });

  test("no readable entry equals a credential path, holds one, or lies under one", () => {
    const clashes = READABLE_UNDER_HOME.flatMap((readable) =>
      CREDENTIAL_PATHS.filter((credential) => within(readable, credential) || within(credential, readable)).map(
        (credential) => ({ readable, credential }),
      ),
    );

    expect(clashes).toEqual([]);
  });

  test("the probe puts its canaries in three credential paths, SSH's first, and reads the Owner's own settings file", () => {
    expect(PROBED_CREDENTIAL_DIRS).toEqual([".ssh", ".config/gh", ".gnupg"]);
    expect(PROBED_CREDENTIAL_DIRS.filter((dir) => !CREDENTIAL_PATHS.includes(dir))).toEqual([]);
    expect(USER_SETTINGS).toBe(".claude/settings.json");
  });

  test("the Workers' own bun cache lies beside the API Workers' clones, in no credential path and not in the Owner's cache", () => {
    expect(WORKERS_BUN_CACHE).toBe(".local/share/software-factory-lab/bun-cache");
    expect(
      [...CREDENTIAL_PATHS, ...READABLE_UNDER_HOME].filter(
        (path) => within(path, WORKERS_BUN_CACHE) || within(WORKERS_BUN_CACHE, path),
      ),
    ).toEqual([]);
  });

  test("every entry is a path from the home: no leading slash, no step up", () => {
    for (const path of [...READABLE_UNDER_HOME, ...CREDENTIAL_PATHS]) {
      expect({ path, relative: !path.startsWith("/") && !path.split("/").includes("..") }).toEqual({
        path,
        relative: true,
      });
    }
  });
});
