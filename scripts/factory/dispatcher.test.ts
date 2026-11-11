import { describe, expect, test } from "bun:test";

import type { Ran, RunOptions } from "../land-loop/ports/run.ts";
import { dispatch } from "./dispatcher.ts";
import type { DispatchPorts } from "./dispatcher.ts";

const CHECKOUT = "/repo";

const WORKTREE = "/repo/.claude/worktrees/issue-7";

const SETTINGS = "/home/me/.config/software-factory-lab/worker-settings.json";

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

const ISSUE = '{"title":"Add a flag","url":"https://github.com/o/r/issues/7","author":{"login":"bengous"}}';

const PROVISIONED = '{"env":{"LAB_AUTHOR":"1","GH_TOKEN":"ghp_worker"}}';

function world(answers: Partial<Record<string, Ran>> = {}, settings: string | null = PROVISIONED) {
  const calls: Call[] = [];

  const defaults: ReadonlyArray<readonly [prefix: string, ran: Ran]> = [
    ["gh issue", { code: 0, stdout: ISSUE, stderr: "" }],
    ["git fetch", { code: 0, stdout: "", stderr: "" }],
    ["git for-each-ref", { code: 0, stdout: "dev\norigin/dev\n", stderr: "" }],
    ["git worktree list", { code: 0, stdout: "worktree /repo\n", stderr: "" }],
    ["git worktree add", { code: 0, stdout: "", stderr: "" }],
    ["git worktree remove", { code: 0, stdout: "", stderr: "" }],
    ["git branch -D", { code: 0, stdout: "", stderr: "" }],
    ["claude --bg", { code: 0, stdout: "claude stop s-123      stop this session\n", stderr: "" }],
  ];

  const answer = (argv: readonly string[], options: RunOptions): Promise<Ran> => {
    calls.push({ argv, options });
    const found = defaults.find(([prefix]) => argv.join(" ").startsWith(prefix));

    if (found === undefined) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }

    return Promise.resolve(answers[found[0]] ?? found[1]);
  };

  const launches: Call[] = [];

  const ports: DispatchPorts = {
    run: answer,
    launch: (argv, options) => {
      launches.push({ argv, options });

      return answer(argv, options);
    },
    readText: (path) =>
      path === SETTINGS && settings !== null
        ? Promise.resolve(settings)
        : Promise.reject(new Error("ENOENT: no such file")),
  };

  return { ports, calls, launches };
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

const REQUEST = { issue: 7, model: "opus", checkout: CHECKOUT, env: ENV };

const commandsOf = (calls: readonly Call[]) => calls.map((call) => call.argv.slice(0, 3).join(" "));

describe("dispatch", () => {
  test("creates the worktree from origin/dev, launches the Worker in the main checkout, and says what it did", async () => {
    const { ports, calls, launches } = world();

    const dispatched = await dispatch(ports, REQUEST);

    expect(dispatched).toEqual({
      issue: 7,
      title: "Add a flag",
      worktree: WORKTREE,
      branch: "issue/7-add-a-flag",
      session: "s-123",
    });
    expect(commandsOf(calls)).toEqual([
      "gh issue view",
      "git fetch --prune",
      "git worktree list",
      "git for-each-ref --format=%(refname:short)",
      "git worktree add",
      "claude --bg --model",
    ]);
    expect(calls[1]?.argv).toEqual(["git", "fetch", "--prune", "origin"]);
    expect(calls[4]?.argv).toEqual(["git", "worktree", "add", "-b", "issue/7-add-a-flag", WORKTREE, "origin/dev"]);
    expect(launches).toHaveLength(1);

    const launch = launches[0];
    expect(launch?.options.cwd).toBe(CHECKOUT);
    expect(launch?.options.env).toEqual({ HOME: "/home/me", PATH: "/bin" });
    expect(launch?.argv).toEqual([
      "claude",
      "--bg",
      "--model",
      "opus",
      "--settings",
      SETTINGS,
      "--name",
      "w-issue-7",
      `Implement GitHub issue #7 of o/r (read it with: gh issue view 7 --repo o/r). Your worktree exists: first call EnterWorktree with the path ${WORKTREE} and work there; its branch issue/7-add-a-flag starts at origin/dev.`,
    ]);
    expect(launch?.argv.join(" ")).not.toContain("secret");
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
    const { ports, calls } = world({}, '{"env":{"GH_TOKEN":"ghp_worker"}}');

    const failure = await failureOf(dispatch(ports, REQUEST));

    expect(failure).toBe(`the Worker settings file ${SETTINGS}: env.LAB_AUTHOR is not "1"`);
    expect(calls).toEqual([]);
  });

  test("refuses a missing Worker settings file", async () => {
    const { ports, calls } = world({}, null);

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      `the Worker settings file ${SETTINGS} cannot be read: ENOENT: no such file`,
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

  test("names the worktree first when one holds the issue's branch, since the branch cannot go before it", async () => {
    const { ports } = world({
      "git worktree list": { code: 0, stdout: `worktree /repo\n\nworktree ${WORKTREE}\n`, stderr: "" },
      "git for-each-ref": { code: 0, stdout: "issue/7-add-a-flag\n", stderr: "" },
    });

    expect(await failureOf(dispatch(ports, REQUEST))).toBe(
      `issue #7 already has a worktree: ${WORKTREE}. Remove it first (git worktree remove ${WORKTREE})`,
    );
  });

  test("removes the worktree and the branch it created when the launch fails", async () => {
    const { ports, calls } = world({ "claude --bg": { code: 1, stdout: "", stderr: "no such model" } });

    expect(await failureOf(dispatch(ports, REQUEST))).toContain("no such model");
    expect(calls.slice(-2).map((call) => call.argv)).toEqual([
      ["git", "worktree", "remove", WORKTREE],
      ["git", "branch", "-D", "issue/7-add-a-flag"],
    ]);
  });

  test("fails with what gh printed when the issue cannot be read", async () => {
    const { ports } = world({ "gh issue": { code: 1, stdout: "", stderr: "could not find issue" } });

    expect(await failureOf(dispatch(ports, REQUEST))).toContain("could not find issue");
  });

  test("refuses a run with no HOME, where the Worker settings file lives", async () => {
    const { ports } = world();

    expect(await failureOf(dispatch(ports, { ...REQUEST, env: {} }))).toContain("HOME is not set");
  });
});
