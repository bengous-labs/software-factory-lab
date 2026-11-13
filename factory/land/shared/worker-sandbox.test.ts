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

const DENY = [...SECRET_RULES, ...CREDENTIAL_RULES];

/** An API Worker's: the main checkout too, and every write in the git directory of a clone. */
const API_DENY = [
  ...SECRET_RULES,
  "Read(//repo/**)",
  "Edit(//repo/**)",
  "Edit(//home/me/.local/share/software-factory-lab/api-workers/*/.git/**)",
  ...CREDENTIAL_RULES,
];

const GIT_ENV = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
  GIT_CONFIG_VALUE_0: "git@github.com:",
  GIT_CONFIG_KEY_1: "commit.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "tag.gpgsign",
  GIT_CONFIG_VALUE_2: "false",
};

const SANDBOX = {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  filesystem: {
    denyRead: ["/home/me"],
    allowRead: [
      "/repo",
      "/home/me/.local/share/mise/installs",
      "/home/me/.bun/install/cache",
      "/home/me/.gitconfig",
      "/home/me/.config/git/config",
      "/home/me/.config/git/ignore",
    ],
  },
  credentials: {
    files: [
      { path: "/home/me/.api-agent", mode: "deny" },
      { path: "/home/me/.config/software-factory-lab", mode: "deny" },
    ],
  },
  network: { allowedDomains: ["github.com", "*.github.com", "*.githubusercontent.com", "registry.npmjs.org"] },
};

/** An API Worker's sandbox: no entry for where it works, its clone being its working directory, and the main checkout hidden from it. */
const API_SANDBOX = {
  ...SANDBOX,
  filesystem: {
    denyRead: ["/home/me"],
    allowRead: SANDBOX.filesystem.allowRead.slice(1),
  },
  credentials: { files: [...SANDBOX.credentials.files, { path: "/repo", mode: "deny" }] },
};

describe("sandboxedOf", () => {
  test("an API Worker is allowed the list alone beside its working directory, never the clones' directory nor the main checkout, which is hidden from its commands and its file tools, and its file tools write nothing in a clone's git directory", () => {
    expect(sandboxedOf({ env: { LAB_AUTHOR: "1" } }, PLACE, "api")).toEqual({
      env: { LAB_AUTHOR: "1", ...GIT_ENV },
      sandbox: API_SANDBOX,
      permissions: { blockReadsOutsideWorkingDirectories: true, allow: ["Edit(./**)", "Bash"], deny: API_DENY },
    });
    expect(API_SANDBOX.filesystem.allowRead).toEqual([
      "/home/me/.local/share/mise/installs",
      "/home/me/.bun/install/cache",
      "/home/me/.gitconfig",
      "/home/me/.config/git/config",
      "/home/me/.config/git/ignore",
    ]);
  });

  test("a background Worker: denies the home to every command, allows the checkout and the list again, hides the factory's secrets, and holds the file tools to the working directories", () => {
    expect(sandboxedOf({ env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker" } }, PLACE, "background")).toEqual({
      env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker", ...GIT_ENV },
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

    expect(sandboxedOf(held, PLACE, "background")).toEqual({
      env: { LAB_AUTHOR: "1", ...GIT_ENV },
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

    expect(sandboxedOf(held, PLACE, "background")).toEqual({
      env: GIT_ENV,
      sandbox: SANDBOX,
      permissions: { blockReadsOutsideWorkingDirectories: true, allow: ["Edit(./**)", "Bash"], deny: DENY },
    });
  });

  test("the sandbox widens nothing: it holds those keys alone, with no write path, excluded command or Unix socket", () => {
    const { sandbox } = sandboxedOf({ env: {} }, PLACE, "background");

    expect(Object.keys(sandbox).toSorted()).toEqual([
      "allowUnsandboxedCommands",
      "autoAllowBashIfSandboxed",
      "credentials",
      "enabled",
      "failIfUnavailable",
      "filesystem",
      "network",
    ]);
    expect(Object.keys(sandbox.filesystem).toSorted()).toEqual(["allowRead", "denyRead"]);
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
  test("for either kind of Worker, what it allows to read under the home is narrower than the home and outside every credential path, and every credential path has its two rules", () => {
    fc.assert(
      fc.property(place, fc.constantFrom("background" as const, "api" as const), ({ home, checkout }, kind) => {
        const { sandbox, permissions } = sandboxedOf({ env: {} }, { home, checkout }, kind);
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

  test.each([
    ["/home/me", "/home/me", "the home itself"],
    ["/home", "/home/me", "a parent of the home"],
    ["/home/me/.ssh", "/home/me/.ssh", "a credential path"],
    ["/home/me/.ssh/repo", "/home/me/.ssh", "a directory of a credential path"],
    ["/home/me/.config", "/home/me/.config/software-factory-lab", "a parent of the factory's config"],
    ["/home/me/.api-agent/repo", "/home/me/.api-agent", "a directory of the key's"],
    ["/home/me/.config/git", "/home/me/.config/git/credentials", "a parent of git's credentials"],
  ])("a checkout at %s is refused, naming %s (%s): it is readable whole", (checkout, secret) => {
    expect(sandboxPlaceProblemOf({ home: "/home/me", checkout })).toBe(
      `the main checkout ${checkout} holds ${secret} or lies in it: a Worker reads its whole checkout, so the sandbox would hide nothing there`,
    );
  });
});
