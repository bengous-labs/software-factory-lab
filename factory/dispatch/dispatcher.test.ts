import { describe, expect, test } from "bun:test";

import type { LeaveOptions, Ran, RunOptions } from "../lib/run.port.ts";
import { dispatch } from "./dispatcher.ts";
import type { DispatchPorts } from "./dispatcher.ts";

const CHECKOUT = "/repo";

const SETTINGS = "/home/me/.config/software-factory-lab/worker-settings.json";

const BACKGROUND_SETTINGS = "/home/me/.config/software-factory-lab/background-worker-settings.json";

const API_SETTINGS = "/home/me/.config/software-factory-lab/api-worker-settings.json";

const KEY = "/home/me/.api-agent/key";

const CLONE = "/home/me/.local/share/software-factory-lab/api-workers/issue-7";

const SESSION = "0b1c2d3e-0000-4000-8000-000000000007";

const LOG = `/repo/.lab/state/api-worker-${SESSION}.log`;

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

const ISSUE = '{"title":"Add a flag","url":"https://github.com/o/r/issues/7","author":{"login":"bengous"}}';

const PROVISIONED = '{"env":{"LAB_AUTHOR":"1","GH_TOKEN":"ghp_worker"}}';

const PROJECT_SETTINGS = "/repo/.claude/settings.json";

const PROJECT = JSON.stringify({
  hooks: { Stop: [{ hooks: [{ type: "command", command: 'bun "$CLAUDE_PROJECT_DIR"/factory/bin/stop-hook.ts' }] }] },
});

interface Left {
  readonly argv: readonly string[];
  readonly options: LeaveOptions;
}

/** The two hidden directories, then the first credential path's two rules, which every Worker's settings deny first. */
const FIRST_DENIES = [
  "Read(//home/me/.api-agent/**)",
  "Read(//home/me/.config/software-factory-lab/**)",
  "Read(//home/me/.ssh)",
  "Read(//home/me/.ssh/**)",
];

/** What the fake's machine holds besides its commands: the Worker settings file, the key file's mode, whether a detached launch starts. */
interface Machine {
  readonly settings: string | null;
  readonly keyMode: number | null;
  readonly starts: boolean;
  /** The exit code the first turn ends with while Dispatch looks; null when it still runs after the look. */
  readonly firstTurn: number | null;
  /** The main checkout's settings file; null when there is none. */
  readonly project: string | null;
  /** Whether the settings file Dispatch writes for the Worker can be written. */
  readonly writable: boolean;
  /** The permission bits of the directory an API Worker's clone goes to; null when nothing is there. */
  readonly clone: number | null;
}

function world(answers: Partial<Record<string, Ran>> = {}, machine: Partial<Machine> = {}) {
  const { settings = PROVISIONED, keyMode = 0o600, starts = true, firstTurn = null } = machine;
  const { project = PROJECT, writable = true, clone = null } = machine;
  const calls: Call[] = [];
  /** What the dispatch did, in its order: each command, the settings written, the turn left. */
  const order: string[] = [];

  const defaults: ReadonlyArray<readonly [prefix: string, ran: Ran]> = [
    ["gh issue", { code: 0, stdout: ISSUE, stderr: "" }],
    ["git fetch", { code: 0, stdout: "", stderr: "" }],
    ["git for-each-ref", { code: 0, stdout: "dev\norigin/dev\n", stderr: "" }],
    ["git worktree list", { code: 0, stdout: "worktree /repo\n", stderr: "" }],
    ["git worktree add", { code: 0, stdout: "", stderr: "" }],
    ["git worktree remove", { code: 0, stdout: "", stderr: "" }],
    ["git branch -D", { code: 0, stdout: "", stderr: "" }],
    ["claude --bg", { code: 0, stdout: "claude stop s-123      stop this session\n", stderr: "" }],
    ["bun install", { code: 0, stdout: "", stderr: "" }],
    ["git remote get-url origin", { code: 0, stdout: "git@github.com:o/r.git\n", stderr: "" }],
    ["git clone", { code: 0, stdout: "", stderr: "" }],
    ["git switch", { code: 0, stdout: "", stderr: "" }],
    ["rm -rf", { code: 0, stdout: "", stderr: "" }],
  ];

  const answer = (argv: readonly string[], options: RunOptions): Promise<Ran> => {
    calls.push({ argv, options });
    order.push(argv.slice(0, 3).join(" "));
    const found = defaults.find(([prefix]) => argv.join(" ").startsWith(prefix));

    if (found === undefined) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }

    return Promise.resolve(answers[found[0]] ?? found[1]);
  };

  const launches: Call[] = [];
  const left: Left[] = [];
  const written: Array<{ path: string; text: string }> = [];
  const stats: string[] = [];
  const sleeps: number[] = [];

  const ports: DispatchPorts = {
    run: answer,
    launch: (argv, options) => {
      launches.push({ argv, options });

      return answer(argv, options);
    },
    leave: (argv, options) => {
      if (!starts) {
        throw new Error(`the process did not start: ${argv.join(" ")}`);
      }

      left.push({ argv, options });
      order.push("leave");

      return { pid: 4242, exited: firstTurn === null ? new Promise<number>(() => {}) : Promise.resolve(firstTurn) };
    },
    readText: (path) => {
      const text = new Map([
        [SETTINGS, settings],
        [PROJECT_SETTINGS, project],
      ]).get(path);

      return text === undefined || text === null
        ? Promise.reject(new Error(`ENOENT: no such file, open '${path}'`))
        : Promise.resolve(text);
    },
    writeSecret: (path, text) => {
      if (!writable) {
        return Promise.reject(new Error(`EACCES: permission denied, open '${path}'`));
      }

      written.push({ path, text });
      order.push("write");

      return Promise.resolve();
    },
    modeOf: (path) => {
      stats.push(path);

      return Promise.resolve(path === CLONE ? clone : keyMode);
    },
    newSession: () => SESSION,
    sleep: async (ms) => {
      // The fake's first turn ends, when it does, before the look is over.
      await Promise.resolve();
      sleeps.push(ms);
    },
  };

  return { ports, calls, launches, left, written, stats, sleeps, order };
}

/** The message a dispatch rejects with; it fails the test when the dispatch resolves. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected a rejection");
}

const ENV = { HOME: "/home/me", PATH: "/bin", GH_TOKEN: "secret", LAB_AUTHOR: "1" };

const STRANGERS_ISSUE = '{"title":"x","url":"https://github.com/o/r/issues/7","author":{"login":"someone"}}';

const REQUEST = { issue: 7, model: "opus", effort: undefined, api: false, checkout: CHECKOUT, env: ENV };

const API_REQUEST = { ...REQUEST, api: true };

const commandsOf = (calls: readonly Call[]) => calls.map((call) => call.argv.slice(0, 3).join(" "));

describe("dispatch", () => {
  test("clones the remote on the Trunk, creates the branch and installs the clone, writes the background Worker settings file, launches the Worker on it in its clone, and says what it did", async () => {
    const { ports, calls, launches, written, order } = world();

    const dispatched = await dispatch(ports, REQUEST);

    expect(dispatched).toEqual({
      issue: 7,
      title: "Add a flag",
      worktree: CLONE,
      branch: "issue/7-add-a-flag",
      session: "s-123",
      log: null,
    });
    expect(commandsOf(calls)).toEqual([
      "gh issue view",
      "git fetch --prune",
      "git for-each-ref --format=%(refname:short)",
      "git remote get-url",
      "git clone --quiet",
      "git switch --quiet",
      "bun install --frozen-lockfile",
      "claude --bg --model",
    ]);
    expect(calls[1]?.argv).toEqual(["git", "fetch", "--prune", "origin"]);
    expect(calls[5]).toEqual({
      argv: ["git", "switch", "--quiet", "--create", "issue/7-add-a-flag"],
      options: { cwd: CLONE },
    });
    expect(calls[6]?.options.cwd).toBe(CLONE);
    expect(launches).toHaveLength(1);
    expect(written.map((file) => file.path)).toEqual([BACKGROUND_SETTINGS]);
    expect(order.slice(-3)).toEqual(["bun install --frozen-lockfile", "write", "claude --bg --model"]);

    const launch = launches[0];
    expect(launch?.options.cwd).toBe(CLONE);
    expect(launch?.options.env).toEqual({ HOME: "/home/me", PATH: "/bin" });
    expect(launch?.argv).toEqual([
      "claude",
      "--bg",
      "--model",
      "opus",
      "--settings",
      BACKGROUND_SETTINGS,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--append-system-prompt-file",
      `${CHECKOUT}/AGENTS.md`,
      "--name",
      "w-issue-7",
      `Implement GitHub issue #7 of o/r (read it with: gh issue view 7 --repo o/r). You are in your own clone of the repository, ${CLONE}: work there; its branch issue/7-add-a-flag starts at origin/dev.`,
    ]);
    expect(launch?.argv.join(" ")).not.toContain("secret");
    expect(calls.some((call) => call.argv[1] === "worktree")).toBe(false);
  });

  test("launches the Worker at the effort the request names", async () => {
    const { ports, launches } = world();

    await dispatch(ports, { ...REQUEST, effort: "low" });

    expect(launches[0]?.argv.slice(0, 6)).toEqual(["claude", "--bg", "--model", "opus", "--effort", "low"]);
  });

  test("returns the title without its control characters", async () => {
    const { ports } = world({
      "gh issue": {
        code: 0,
        stdout: String.raw`{"title":"Add\u001b[2J a flag","url":"https://github.com/o/r/issues/7","author":{"login":"bengous"}}`,
        stderr: "",
      },
    });

    expect((await dispatch(ports, REQUEST)).title).toBe("Add[2J a flag");
  });

  test("refuses an issue the Owner did not write, before it creates anything", async () => {
    const { ports, calls } = world({
      "gh issue": {
        code: 0,
        stdout: '{"title":"x","url":"https://github.com/o/r/issues/7","author":{"login":"someone"}}',
        stderr: "",
      },
    });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      "issue #7 was written by someone, not by the Owner bengous: a Worker holds the Author's token, so it implements only the Owner's issues",
    );
    expect(commandsOf(calls)).toEqual(["gh issue view"]);
  });

  test("refuses Worker settings that do not make an Author, before it reads the issue, without quoting them", async () => {
    const { ports, calls } = world({}, { settings: '{"env":{"GH_TOKEN":"ghp_worker"}}' });

    const failure = await failureOf(dispatch(ports, REQUEST));

    expect(failure).toBe(`the Worker settings file ${SETTINGS}: env.LAB_AUTHOR is not "1"`);
    expect(calls).toEqual([]);
  });

  test("refuses a missing Worker settings file", async () => {
    const { ports, calls } = world({}, { settings: null });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      `the Worker settings file ${SETTINGS} cannot be read: ENOENT: no such file, open '${SETTINGS}'`,
    );
    expect(calls).toEqual([]);
  });

  test("refuses an issue that already has a branch, and names what to remove", async () => {
    const { ports, calls } = world({
      "git for-each-ref": { code: 0, stdout: "fix/7-old\norigin/fix/7-old\n", stderr: "" },
    });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      "issue #7 already has a branch: fix/7-old, origin/fix/7-old. Remove it first (git branch -D <branch>, git push origin --delete <branch>)",
    );
    expect(calls.some((call) => call.argv[0] === "claude" || call.argv[2] === "add")).toBe(false);
  });

  test("names the clone first when one is there, whatever branch the issue has", async () => {
    const { ports } = world(
      { "git for-each-ref": { code: 0, stdout: "issue/7-add-a-flag\n", stderr: "" } },
      { clone: 0o755 },
    );

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      `issue #7 already has a clone: ${CLONE}. Remove it first (rm -rf ${CLONE})`,
    );
  });

  test("a background launch Claude Code refuses for workspace trust fails with Claude Code's own words, its exit code and the way that works, an API Worker, and removes the clone", async () => {
    const refused = "Workspace not trusted. Run `claude` in /clone once and accept the trust prompt, then retry.";
    const { ports, calls } = world({ "claude --bg": { code: 1, stdout: "", stderr: refused } });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      `claude --bg exited 1: ${refused} (no new clone has that trust: hand the issue to an API Worker with --api)`,
    );
    expect(calls.at(-1)?.argv).toEqual(["rm", "-rf", "--", CLONE]);
  });

  test("removes the clone it made when the launch fails", async () => {
    const { ports, calls } = world({ "claude --bg": { code: 1, stdout: "", stderr: "no such model" } });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe("claude --bg exited 1: no such model");
    expect(calls.at(-1)?.argv).toEqual(["rm", "-rf", "--", CLONE]);
  });

  test("the failure of a launch carries the launch's own error as its cause", async () => {
    const { ports } = world(
      { "claude --bg": { code: 1, stdout: "", stderr: "no such model" } },
      { settings: PROVISIONED },
    );

    const failure = await dispatch(ports, REQUEST).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("cause.message", "claude --bg exited 1: no such model");
  });

  test("keeps the launch's error and says the clone is left when the removal fails", async () => {
    const { ports } = world({
      "claude --bg": { code: 1, stdout: "", stderr: "no such model" },
      "rm -rf": { code: 1, stdout: "", stderr: "Permission denied" },
    });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      `claude --bg exited 1: no such model. Its clone is left (rm -rf -- ${CLONE} exited 1: Permission denied): remove it with rm -rf ${CLONE}`,
    );
  });

  test("a background session whose id is not read keeps its clone: the Worker runs", async () => {
    const { ports, calls } = world({ "claude --bg": { code: 0, stdout: "started\n", stderr: "" } });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe("claude --bg printed no session id: started");
    expect(commandsOf(calls).at(-1)).toBe("claude --bg --model");
  });

  test("a background Worker reads no key file and is left no headless turn, and the one file written is its own", async () => {
    const { ports, left, written, stats } = world();

    await dispatch(ports, REQUEST);

    expect({ left, stats, written: written.map((file) => file.path) }).toEqual({
      left: [],
      stats: [CLONE],
      written: [BACKGROUND_SETTINGS],
    });
  });

  test("the settings file it writes makes the Worker an Author in a clone, sandboxed with the home denied and the main checkout hidden, on the main checkout's hooks, that asks nothing, with no key helper and no marker of an API Worker", async () => {
    const { ports, written } = world();

    await dispatch(ports, REQUEST);

    const settings: unknown = JSON.parse(written[0]?.text ?? "");

    expect(settings).toMatchObject({
      env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker", GIT_CONFIG_COUNT: "3", LAB_MAIN_CHECKOUT: CHECKOUT },
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command:
                  'cd "$LAB_MAIN_CHECKOUT" && unset BUN_INSTALL_CACHE_DIR && bun "$LAB_MAIN_CHECKOUT"/factory/bin/stop-hook.ts',
              },
            ],
          },
        ],
      },
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyRead: ["/home/me"] },
      },
      permissions: { defaultMode: "dontAsk", blockReadsOutsideWorkingDirectories: true },
    });
    expect(settings).toHaveProperty("sandbox.credentials.files.2", { path: CHECKOUT, mode: "deny" });
    expect(settings).not.toHaveProperty("sandbox.filesystem.allowRead.6");
    expect(settings).toHaveProperty("permissions.deny", expect.arrayContaining(FIRST_DENIES));
    expect(settings).not.toHaveProperty("apiKeyHelper");
    expect(settings).not.toHaveProperty("env.LAB_API_WORKER");
  });

  test("removes the clone when the background Worker settings file cannot be written, and launches nothing", async () => {
    const { ports, calls, launches } = world({}, { writable: false });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(`EACCES: permission denied, open '${BACKGROUND_SETTINGS}'`);
    expect(launches).toEqual([]);
    expect(calls.at(-1)?.argv).toEqual(["rm", "-rf", "--", CLONE]);
  });

  test("refuses a main checkout whose settings cannot be read, or hold no hooks, before it creates anything: a Worker with no Stop hook publishes nothing", async () => {
    for (const project of [null, '{"enabledPlugins":{}}']) {
      const { ports, calls, written } = world({}, { project });

      expect(await failureOf(dispatch(ports, REQUEST))).not.toBe("");
      expect({ calls, written }).toEqual({ calls: [], written: [] });
    }
  });

  test.each([
    [{ HOME: "/home/m*e" }, CHECKOUT, "the home /home/m*e holds one of * ? [ ]"],
    [{ HOME: "/home/me" }, "/srv/repo[1]", "the main checkout /srv/repo[1] holds one of * ? [ ]"],
  ])(
    "refuses a place no sandbox can be made for (%j, %s), for either kind of Worker, before it reads a file or creates anything",
    async (env, checkout, problem) => {
      for (const request of [REQUEST, API_REQUEST]) {
        const { ports, calls, written, stats } = world();

        expect(await failureOf(dispatch(ports, { ...request, env, checkout }))).toStartWith(
          `no Worker can be sandboxed here: ${problem}`,
        );
        expect({ calls, written, stats }).toEqual({ calls: [], written: [], stats: [] });
      }
    },
  );

  test("fails with what gh printed when the issue cannot be read", async () => {
    const { ports } = world({ "gh issue": { code: 1, stdout: "", stderr: "could not find issue" } });

    expect(await failureOf(dispatch(ports, REQUEST))).toContain("could not find issue");
  });

  test("refuses a run with no HOME, where the Worker settings file lives", async () => {
    const { ports } = world();

    expect(await failureOf(dispatch(ports, { ...REQUEST, env: {} }))).toContain("HOME is not set");
  });
});

describe("the dispatch of an API Worker", () => {
  const TAIL = [
    "--settings",
    API_SETTINGS,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--append-system-prompt-file",
    `${CHECKOUT}/AGENTS.md`,
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "json",
    `Implement GitHub issue #7 of o/r (read it with: gh issue view 7 --repo o/r). You are in your own clone of the repository, ${CLONE}: work there; its branch issue/7-add-a-flag starts at origin/dev.`,
  ];

  test("makes the clone, writes the API Worker settings file just before the launch, and leaves the first turn running headless in the clone", async () => {
    const { ports, calls, launches, left, written, stats, order } = world();

    expect(await dispatch(ports, API_REQUEST)).toEqual({
      issue: 7,
      title: "Add a flag",
      worktree: CLONE,
      branch: "issue/7-add-a-flag",
      session: SESSION,
      log: LOG,
    });
    expect(stats).toEqual([KEY, CLONE]);
    expect(written.map((file) => file.path)).toEqual([API_SETTINGS]);
    expect(order).toEqual([
      "gh issue view",
      "git fetch --prune",
      "git for-each-ref --format=%(refname:short)",
      "git remote get-url",
      "git clone --quiet",
      "git switch --quiet",
      "bun install --frozen-lockfile",
      "write",
      "leave",
    ]);
    expect(launches).toEqual([]);
    expect(calls.some((call) => call.argv[1] === "worktree")).toBe(false);
    expect(left).toEqual([
      {
        argv: ["claude", "-p", "--session-id", SESSION, "--name", "w-issue-7", "--model", "opus", ...TAIL],
        options: { cwd: CLONE, env: { HOME: "/home/me", PATH: "/bin" }, log: LOG },
      },
    ]);
  });

  test("the clone comes from the main checkout's remote, on the Trunk, outside the main checkout, and its branch is made in it", async () => {
    const { ports, calls } = world();

    await dispatch(ports, API_REQUEST);

    expect(calls.filter((call) => ["clone", "switch"].includes(call.argv[1] ?? ""))).toEqual([
      {
        argv: ["git", "clone", "--quiet", "--branch", "dev", "git@github.com:o/r.git", CLONE],
        options: { cwd: CHECKOUT },
      },
      { argv: ["git", "switch", "--quiet", "--create", "issue/7-add-a-flag"], options: { cwd: CLONE } },
    ]);
    expect(CLONE.startsWith(`${CHECKOUT}/`)).toBe(false);
  });

  test("refuses an issue that already has a clone, naming what to remove, and creates nothing", async () => {
    const { ports, calls, written, left } = world({}, { clone: 0o755 });

    expect(await failureOf(dispatch(ports, API_REQUEST))).toBe(
      `issue #7 already has a clone: ${CLONE}. Remove it first (rm -rf ${CLONE})`,
    );
    expect(calls.some((call) => call.argv[1] === "clone")).toBe(false);
    expect({ written, left }).toEqual({ written: [], left: [] });
  });

  test("the first turn runs at the effort the dispatch names", async () => {
    const { ports, left } = world();

    await dispatch(ports, { ...API_REQUEST, effort: "high" });

    expect(left[0]?.argv.slice(6, 10)).toEqual(["--model", "opus", "--effort", "high"]);
  });

  test("the settings file it writes makes the Worker an Author and an API Worker, sandboxed, on the main checkout's hooks, and names the key's file, never a key", async () => {
    const { ports, written } = world();

    await dispatch(ports, API_REQUEST);

    expect(JSON.parse(written[0]?.text ?? "")).toMatchObject({
      env: { LAB_AUTHOR: "1", GH_TOKEN: "ghp_worker", LAB_API_WORKER: "1", LAB_MAIN_CHECKOUT: CHECKOUT },
      apiKeyHelper: `cat '${KEY}'`,
      hooks: {
        Stop: [
          {
            hooks: [
              {
                command:
                  'cd "$LAB_MAIN_CHECKOUT" && unset BUN_INSTALL_CACHE_DIR && bun "$LAB_MAIN_CHECKOUT"/factory/bin/stop-hook.ts',
              },
            ],
          },
        ],
      },
      sandbox: {
        enabled: true,
        filesystem: { denyRead: ["/home/me"] },
        credentials: {
          files: [
            { path: "/home/me/.api-agent", mode: "deny" },
            { path: "/home/me/.config/software-factory-lab", mode: "deny" },
            { path: CHECKOUT, mode: "deny" },
          ],
        },
      },
      permissions: { blockReadsOutsideWorkingDirectories: true },
    });
    expect(JSON.parse(written[0]?.text ?? "")).toHaveProperty("permissions.deny", expect.arrayContaining(FIRST_DENIES));
    expect(JSON.parse(written[0]?.text ?? "")).not.toHaveProperty("permissions.defaultMode");
  });

  test("neither the launch nor its environment holds a token: the settings go by their path", async () => {
    const { ports, left } = world();

    await dispatch(ports, API_REQUEST);

    expect(JSON.stringify(left)).not.toContain("ghp_worker");
    expect(JSON.stringify(left)).not.toContain("secret");
  });

  test.each([
    [null, `the API key file ${KEY} is missing`],
    [0o644, `the API key file ${KEY} is readable by its group or by others: set its mode to 600`],
  ])("refuses a key file of mode %p before it writes or creates anything", async (keyMode, failure) => {
    const { ports, calls, written, left } = world({}, { keyMode });

    expect(await failureOf(dispatch(ports, API_REQUEST))).toBe(failure);
    expect({ calls, written, left }).toEqual({ calls: [], written: [], left: [] });
  });

  test("refuses Worker settings that do not make an Author before it looks at the key", async () => {
    const { ports, stats, written } = world({}, { settings: '{"env":{"GH_TOKEN":"ghp_worker"}}' });

    expect(await failureOf(dispatch(ports, API_REQUEST))).toBe(
      `the Worker settings file ${SETTINGS}: env.LAB_AUTHOR is not "1"`,
    );
    expect({ stats, written }).toEqual({ stats: [], written: [] });
  });

  test("refuses a main checkout whose settings cannot be read, or hold no hooks, before it creates anything", async () => {
    const missing = world({}, { project: null });

    expect(await failureOf(dispatch(missing.ports, API_REQUEST))).toBe(
      `ENOENT: no such file, open '${PROJECT_SETTINGS}'`,
    );
    expect({ calls: missing.calls, written: missing.written }).toEqual({ calls: [], written: [] });

    const hookless = world({}, { project: "{}" });

    expect(await failureOf(dispatch(hookless.ports, API_REQUEST))).toStartWith(
      "the main checkout's .claude/settings.json: ",
    );
    expect({ calls: hookless.calls, written: hookless.written }).toEqual({ calls: [], written: [] });
  });

  test.each([
    ["an issue the Owner did not write", { "gh issue": { code: 0, stdout: STRANGERS_ISSUE, stderr: "" } }],
    ["an issue that already has a branch", { "git for-each-ref": { code: 0, stdout: "fix/7-old\n", stderr: "" } }],
    ["a clone that cannot be made", { "git clone": { code: 128, stdout: "", stderr: "no route to host" } }],
  ])(
    "a dispatch refused for %s leaves the settings file every running API Worker reads as it was",
    async (_, answers) => {
      const { ports, written, left } = world(answers);

      await failureOf(dispatch(ports, API_REQUEST));

      expect({ written, left }).toEqual({ written: [], left: [] });
    },
  );

  test("installs the clone's dependencies itself, in the clone, before the Worker exists: no hook installs for an API Worker", async () => {
    const { ports, calls, order } = world();

    await dispatch(ports, API_REQUEST);

    const install = calls.find((call) => call.argv[1] === "install");

    expect(install?.argv).toEqual(["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"]);
    expect(install?.options).toEqual({ cwd: CLONE });
    expect(order.indexOf("bun install --frozen-lockfile")).toBeLessThan(order.indexOf("leave"));
  });

  test("removes the clone when the install fails, writes no settings and leaves no turn", async () => {
    const { ports, calls, left, written } = world({
      "bun install": { code: 1, stdout: "", stderr: "lockfile had changes" },
    });

    expect(await failureOf(dispatch(ports, API_REQUEST))).toBe(
      "bun install --frozen-lockfile exited 1: lockfile had changes",
    );
    expect({ left, written }).toEqual({ left: [], written: [] });
    expect(calls.at(-1)).toEqual({ argv: ["rm", "-rf", "--", CLONE], options: { cwd: CHECKOUT } });
  });

  test("a background Worker's clone is installed by Dispatch too, in the clone, before the Worker exists", async () => {
    const { ports, calls, stats } = world();

    expect((await dispatch(ports, REQUEST)).worktree).toBe(CLONE);

    const install = calls.findIndex((call) => call.argv[0] === "bun");

    expect(calls[install]?.options.cwd).toBe(CLONE);
    expect(install).toBeLessThan(calls.findIndex((call) => call.argv[0] === "claude"));
    expect(stats).toEqual([CLONE]);
  });

  test("removes the clone when the settings file cannot be written, and leaves no turn", async () => {
    const { ports, calls, left } = world({}, { writable: false });

    expect(await failureOf(dispatch(ports, API_REQUEST))).toBe(`EACCES: permission denied, open '${API_SETTINGS}'`);
    expect(left).toEqual([]);
    expect(calls.at(-1)).toEqual({ argv: ["rm", "-rf", "--", CLONE], options: { cwd: CHECKOUT } });
  });

  test("looks at the first turn for 10 s: one that still runs, or that ended well, is a launched Worker", async () => {
    const running = world();

    expect((await dispatch(running.ports, API_REQUEST)).session).toBe(SESSION);
    expect(running.sleeps).toEqual([10_000]);
    expect((await dispatch(world({}, { firstTurn: 0 }).ports, API_REQUEST)).session).toBe(SESSION);
  });

  test("a first turn that ends at once with an error, its key refused, fails the dispatch, names the log and removes the clone", async () => {
    const { ports, calls } = world({}, { firstTurn: 1 });

    expect(await failureOf(dispatch(ports, API_REQUEST))).toBe(
      `the API Worker's first turn ended at once with exit 1: ${LOG} holds what it printed`,
    );
    expect(calls.at(-1)).toEqual({ argv: ["rm", "-rf", "--", CLONE], options: { cwd: CHECKOUT } });
  });

  test("removes the clone when the first turn does not start, and says what is left when it cannot", async () => {
    const { ports, calls } = world(
      { "rm -rf": { code: 1, stdout: "", stderr: "Permission denied" } },
      { starts: false },
    );

    const failure = await failureOf(dispatch(ports, API_REQUEST));

    expect(failure).toStartWith("the process did not start: claude -p --session-id");
    expect(failure).toEndWith(
      `. Its clone is left (rm -rf -- ${CLONE} exited 1: Permission denied): remove it with rm -rf ${CLONE}`,
    );
    expect(calls.at(-1)?.argv).toEqual(["rm", "-rf", "--", CLONE]);
  });
});
