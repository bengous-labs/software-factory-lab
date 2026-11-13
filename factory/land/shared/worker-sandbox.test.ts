import { describe, expect, test } from "bun:test";

import type { Schema } from "effect";
import * as fc from "fast-check";

import { CREDENTIAL_PATHS } from "../../install/sandbox-paths.ts";
import { sandboxedOf, sandboxPlaceProblemOf } from "./worker-sandbox.ts";
import type { SandboxableSettings } from "./worker-sandbox.ts";

const PLACE = { home: "/home/me", checkout: "/repo" };

/** The two rules of each credential path under `/home/me`: the path itself, and what lies under it. */
const CREDENTIAL_RULES = [
  "Read(//home/me/.ssh)",
  "Read(//home/me/.ssh/**)",
  "Read(//home/me/.config/gh)",
  "Read(//home/me/.config/gh/**)",
  "Read(//home/me/.gnupg)",
  "Read(//home/me/.gnupg/**)",
  "Read(//home/me/.aws)",
  "Read(//home/me/.aws/**)",
  "Read(//home/me/.docker)",
  "Read(//home/me/.docker/**)",
  "Read(//home/me/.kube)",
  "Read(//home/me/.kube/**)",
  "Read(//home/me/.netrc)",
  "Read(//home/me/.netrc/**)",
  "Read(//home/me/.npmrc)",
  "Read(//home/me/.npmrc/**)",
  "Read(//home/me/.git-credentials)",
  "Read(//home/me/.git-credentials/**)",
  "Read(//home/me/.config/git/credentials)",
  "Read(//home/me/.config/git/credentials/**)",
];

/** The rules on the factory's own secrets: neither read nor written. */
const SECRET_RULES = [
  "Read(//home/me/.api-agent/**)",
  "Edit(//home/me/.api-agent/**)",
  "Read(//home/me/.config/software-factory-lab/**)",
  "Edit(//home/me/.config/software-factory-lab/**)",
];

/** The secrets, the main checkout, every write in the git directory of a clone, then each credential path. */
const DENY = [
  ...SECRET_RULES,
  "Read(//repo/**)",
  "Edit(//repo/**)",
  "Edit(//home/me/.local/share/software-factory-lab/api-workers/*/.git/**)",
  ...CREDENTIAL_RULES,
];

const SANDBOX_ENV = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "tag.gpgsign",
  GIT_CONFIG_VALUE_2: "false",
  BUN_INSTALL_CACHE_DIR: "/home/me/.local/share/software-factory-lab/bun-cache",
};

const SANDBOX = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  filesystem: {
    denyRead: ["/home/me"],
    allowRead: [
      "/home/me/.local/share/mise/installs",
      "/home/me/.bun/install/cache",
      "/home/me/.gitconfig",
      "/home/me/.config/git/config",
      "/home/me/.config/git/ignore",
      "/home/me/.local/share/software-factory-lab/bun-cache",
    ],
    allowWrite: ["/home/me/.local/share/software-factory-lab/bun-cache"],
  },
  credentials: {
    files: [
      { path: "/home/me/.api-agent", mode: "deny" },
      { path: "/home/me/.config/software-factory-lab", mode: "deny" },
      { path: "/repo", mode: "deny" },
    ],
  },
  network: { allowedDomains: ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"] },
};

describe("sandboxedOf", () => {
  test("a command is allowed the list and the Workers' own bun cache alone beside its working directory: no entry for its clone, and none for the main checkout, which is hidden", () => {
    expect(SANDBOX.filesystem.allowRead).toEqual([
      "/home/me/.local/share/mise/installs",
      "/home/me/.bun/install/cache",
      "/home/me/.gitconfig",
      "/home/me/.config/git/config",
      "/home/me/.config/git/ignore",
      "/home/me/.local/share/software-factory-lab/bun-cache",
    ]);
    expect(SANDBOX.credentials.files).toContainEqual({ path: "/repo", mode: "deny" });
    expect(sandboxedOf({ env: {} }, PLACE).sandbox).toEqual(SANDBOX);
  });

  test("denies the home to every command, allows the list again, hides the main checkout, hides the factory's secrets, and holds the file tools to the working directories", () => {
    expect(sandboxedOf({ env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker" } }, PLACE)).toEqual({
      env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker", ...SANDBOX_ENV },
      sandbox: SANDBOX,
      permissions: { blockReadsOutsideWorkingDirectories: true, allow: ["Edit(./**)", "Bash"], deny: DENY },
    });
  });

  test("the rules the settings hold stay, before the sandbox's own, with every other key", () => {
    const held = {
      env: { LAB_AUTHOR: "1" },
      outputStyle: "Proactive",
      permissions: { allow: ["Bash(jq *)"], deny: ["Read(./secrets/**)"], ask: ["Bash(rm *)"] },
    };

    expect(sandboxedOf(held, PLACE)).toEqual({
      env: { LAB_AUTHOR: "1", ...SANDBOX_ENV },
      outputStyle: "Proactive",
      sandbox: SANDBOX,
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        allow: ["Bash(jq *)", "Edit(./**)", "Bash"],
        deny: ["Read(./secrets/**)", ...DENY],
        ask: ["Bash(rm *)"],
      },
    });
  });

  test("a sandbox, a git configuration or a wider read the settings hold give way to the sandbox's", () => {
    const held: SandboxableSettings & Readonly<Record<string, Schema.Json>> = {
      env: { GIT_CONFIG_COUNT: "0", GIT_CONFIG_KEY_1: "commit.gpgsign", GIT_CONFIG_VALUE_1: "true" },
      sandbox: { enabled: false, excludedCommands: ["git *"], filesystem: { allowWrite: ["/"] } },
      permissions: { blockReadsOutsideWorkingDirectories: false },
    };

    expect(sandboxedOf(held, PLACE)).toEqual({
      env: SANDBOX_ENV,
      sandbox: SANDBOX,
      permissions: { blockReadsOutsideWorkingDirectories: true, allow: ["Edit(./**)", "Bash"], deny: DENY },
    });
  });

  test("the sandbox widens nothing: it holds those keys alone, with no excluded command or Unix socket, and one write path, the Workers' own bun cache", () => {
    const { sandbox } = sandboxedOf({ env: {} }, PLACE);

    expect(Object.keys(sandbox).toSorted()).toEqual([
      "allowUnsandboxedCommands",
      "autoAllowBashIfSandboxed",
      "credentials",
      "enabled",
      "failIfUnavailable",
      "filesystem",
      "network",
    ]);
    expect(Object.keys(sandbox.filesystem).toSorted()).toEqual(["allowRead", "allowWrite", "denyRead"]);
    expect(sandbox.filesystem.allowWrite).toEqual(["/home/me/.local/share/software-factory-lab/bun-cache"]);
    expect(Object.keys(sandbox.network)).toEqual(["allowedDomains"]);
  });
});

/** A path of one to three plain segments under `root`. */
const pathUnder = (root: string): fc.Arbitrary<string> =>
  fc
    .array(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,8}$/u), { minLength: 1, maxLength: 3 })
    .map((segments) => `${root}/${segments.join("/")}`);

/** A home, and a main checkout outside it or under it, that `sandboxPlaceProblemOf` has no word against. */
const place = pathUnder("").chain((home) =>
  fc
    .oneof(pathUnder(""), pathUnder(home))
    .map((checkout) => ({ home, checkout }))
    .filter((made) => sandboxPlaceProblemOf(made) === null),
);

/** Whether the path `inner` is `outer` or lies under it. */
const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(`${outer}/`);

describe("the sandbox of any place", () => {
  test("what it allows to read under the home is narrower than the home and outside every credential path, and every credential path has its two rules", () => {
    fc.assert(
      fc.property(place, ({ home, checkout }) => {
        const { sandbox, permissions } = sandboxedOf({ env: {} }, { home, checkout });
        const credentials = CREDENTIAL_PATHS.map((path) => `${home}/${path}`);

        expect(sandbox.filesystem.denyRead).toEqual([home]);

        for (const allowed of sandbox.filesystem.allowRead) {
          expect({ allowed, holdsTheHome: within(allowed, home) }).toEqual({ allowed, holdsTheHome: false });

          for (const credential of credentials) {
            expect({
              allowed,
              credential,
              clash: within(allowed, credential) || within(credential, allowed),
            }).toEqual({ allowed, credential, clash: false });
          }
        }

        for (const credential of credentials) {
          expect(permissions.deny).toContain(`Read(/${credential})`);
          expect(permissions.deny).toContain(`Read(/${credential}/**)`);
        }
      }),
    );
  });
});

describe("sandboxPlaceProblemOf", () => {
  test("a plain home and a checkout outside it or under it have none", () => {
    expect(sandboxPlaceProblemOf(PLACE)).toBeNull();
    expect(sandboxPlaceProblemOf({ home: "/home/me", checkout: "/home/me/Work/repo" })).toBeNull();
    expect(sandboxPlaceProblemOf({ home: "/home/my home", checkout: "/srv/a repo (1)" })).toBeNull();
    expect(sandboxPlaceProblemOf({ home: "/home/me", checkout: "/home/me/.sshx" })).toBeNull();
    expect(sandboxPlaceProblemOf({ home: "/home/me", checkout: "/home/meadow/repo" })).toBeNull();
  });

  test.each(["*", "?", "[", "]"])(
    "a home or a checkout that holds %s is refused: Claude Code reads it as a pattern",
    (character) => {
      expect(sandboxPlaceProblemOf({ home: `/home/m${character}e`, checkout: "/repo" })).toBe(
        `the home /home/m${character}e holds one of * ? [ ]: Claude Code reads such a path as a pattern, so no sandbox can name it`,
      );
      expect(sandboxPlaceProblemOf({ home: "/home/me", checkout: `/re${character}po` })).toBe(
        `the main checkout /re${character}po holds one of * ? [ ]: Claude Code reads such a path as a pattern, so no sandbox can name it`,
      );
    },
  );
});
