/**
 * No file of the factory outside `install/` spells a name of the repository it is installed in: its
 * logins, its name, its Trunk, its config directory, its API key file, the directory of its API Workers' clones, or a path of one machine. Installing the factory
 * elsewhere then changes `install/` alone. A test file may: it tells what happens on this host.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as host from "./host.ts";
import * as logins from "./logins.ts";

const FACTORY = join(import.meta.dir, "..");

/** The source files held to the rule: every file of the factory but its tests and `install/` itself. */
const SOURCES = [...new Bun.Glob("**/*.ts").scanSync({ cwd: FACTORY })]
  .filter((file) => !file.startsWith("install/") && !/\.(?:test|fixtures)\.ts$/u.test(file))
  .toSorted();

/** Each name `install/` holds, by the constant that holds it. */
const NAMES = { ...host, ...logins } satisfies Readonly<Record<string, string>>;

/**
 * `name` as a word of its own: `dev` is not found in `devRed`, nor in `/dev/null`, and a login is not
 * found inside a longer one.
 */
const spelled = (name: string): RegExp =>
  new RegExp(String.raw`(?<![\w-])${name.replaceAll(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`)}(?![\w-]|/null)`, "u");

/** A path under one user's home. */
const HOME_PATH = /\/(?:home|Users)\/[\w.-]+\//u;

describe("the names of this host", () => {
  test("install/ holds the repository, its Trunk, its release branch, its config directory, its API key file, the directory of its API Workers' clones and its three logins", () => {
    expect(Object.keys(NAMES).toSorted()).toEqual([
      "API_CLONES_DIR",
      "API_KEY_FILE",
      "APP_LOGIN",
      "AUTHOR_LOGIN",
      "CONFIG_DIR",
      "OWNER_LOGIN",
      "RELEASE_BRANCH",
      "REPOSITORY",
      "TRUNK",
    ]);
  });

  test("a name is found as a word of its own, never inside another", () => {
    expect(spelled("dev").test("rebase onto origin/dev.")).toBe(true);
    expect(spelled("dev").test("devRed, GIT_CONFIG_GLOBAL: /dev/null, a dev-server")).toBe(false);
    expect(spelled("bengous").test("the Owner, `bengous`,")).toBe(true);
    expect(spelled("bengous").test("bengous-labs-author")).toBe(false);
  });

  test("no source file of the factory outside install/ spells one, nor a path under a user's home", () => {
    expect(SOURCES).toContain("land/merge-bot/decide.ts");
    expect(SOURCES).toContain("bin/merge-bot.ts");

    // The release branch's name is a common word: `import.meta.main`, a process's `main`. The Trunk's is the one a rule spells.
    const held = Object.entries(NAMES).filter(([constant]) => constant !== "RELEASE_BRANCH");

    for (const file of SOURCES) {
      const text = readFileSync(join(FACTORY, file), "utf8");
      const found = held.flatMap(([constant, name]) => (spelled(name).test(text) ? [constant] : []));

      expect({ file, spells: found, homePath: HOME_PATH.test(text) }).toEqual({ file, spells: [], homePath: false });
    }
  });
});
