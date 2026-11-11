import { describe, expect, test } from "bun:test";

import type { Ran, RunOptions } from "../land-loop/ports/run.ts";
import { dispatch } from "./dispatcher.ts";

const CHECKOUT = "/repo";

const WORKTREE = "/repo/.claude/worktrees/issue-7";

interface Call {
  readonly argv: readonly string[];
  readonly options: RunOptions;
}

function world(answers: Partial<Record<string, Ran>> = {}) {
  const calls: Call[] = [];

  const defaults: ReadonlyArray<readonly [prefix: string, ran: Ran]> = [
    ["gh issue", { code: 0, stdout: '{"title":"Add a flag","url":"https://github.com/o/r/issues/7"}', stderr: "" }],
    ["git fetch", { code: 0, stdout: "", stderr: "" }],
    ["git for-each-ref", { code: 0, stdout: "dev\norigin/dev\n", stderr: "" }],
    ["git worktree list", { code: 0, stdout: "worktree /repo\n", stderr: "" }],
    ["git worktree add", { code: 0, stdout: "", stderr: "" }],
    ["claude --bg", { code: 0, stdout: "claude stop s-123      stop this session\n", stderr: "" }],
  ];

  const run = (argv: readonly string[], options: RunOptions): Promise<Ran> => {
    calls.push({ argv, options });
    const found = defaults.find(([prefix]) => argv.join(" ").startsWith(prefix));

    if (found === undefined) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }

    return Promise.resolve(answers[found[0]] ?? found[1]);
  };

  return { run, calls };
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

const ENV = { HOME: "/home/me", PATH: "/bin", GH_TOKEN: "secret" };

describe("dispatch", () => {
  test("creates the worktree from origin/dev, launches the Worker in the main checkout, and says what it did", async () => {
    const { run, calls } = world();

    const dispatched = await dispatch(run, { issue: 7, model: "opus", checkout: CHECKOUT, env: ENV });

    expect(dispatched).toEqual({
      issue: 7,
      title: "Add a flag",
      worktree: WORKTREE,
      branch: "issue/7-add-a-flag",
      session: "s-123",
    });
    expect(calls.map((call) => call.argv.slice(0, 3).join(" "))).toEqual([
      "gh issue view",
      "git fetch origin",
      "git for-each-ref --format=%(refname:short)",
      "git worktree list",
      "git worktree add",
      "claude --bg --model",
    ]);
    expect(calls[4]?.argv).toEqual(["git", "worktree", "add", "-b", "issue/7-add-a-flag", WORKTREE, "origin/dev"]);

    const launch = calls[5];
    expect(launch?.options.cwd).toBe(CHECKOUT);
    expect(launch?.options.env).toEqual({ HOME: "/home/me", PATH: "/bin" });
    expect(launch?.argv).toEqual([
      "claude",
      "--bg",
      "--model",
      "opus",
      "--settings",
      "/home/me/.config/software-factory-lab/worker-settings.json",
      "--name",
      "w-issue-7",
      `Implement GitHub issue #7 of o/r (read it with: gh issue view 7 --repo o/r). Your worktree exists: first call EnterWorktree with the path ${WORKTREE} and work there; its branch issue/7-add-a-flag starts at origin/dev.`,
    ]);
    expect(launch?.argv.join(" ")).not.toContain("secret");
  });

  test("refuses an issue that already has a branch, and names what to remove", async () => {
    const { run, calls } = world({
      "git for-each-ref": { code: 0, stdout: "fix/7-old\norigin/fix/7-old\n", stderr: "" },
    });

    expect(await failureOf(dispatch(run, { issue: 7, model: "opus", checkout: CHECKOUT, env: ENV }))).toContain(
      "issue #7 already has a branch: fix/7-old, origin/fix/7-old. Remove it first (git branch -D <branch>, git push origin --delete <branch>)",
    );
    expect(calls.some((call) => call.argv[0] === "claude" || call.argv[2] === "add")).toBe(false);
  });

  test("refuses an issue that already has a worktree, and names what to remove", async () => {
    const { run } = world({
      "git worktree list": { code: 0, stdout: `worktree /repo\n\nworktree ${WORKTREE}\n`, stderr: "" },
    });

    expect(await failureOf(dispatch(run, { issue: 7, model: "opus", checkout: CHECKOUT, env: ENV }))).toContain(
      `issue #7 already has a worktree: ${WORKTREE}. Remove it first (git worktree remove ${WORKTREE})`,
    );
  });

  test("fails with what gh printed when the issue cannot be read", async () => {
    const { run } = world({ "gh issue": { code: 1, stdout: "", stderr: "could not find issue" } });

    expect(await failureOf(dispatch(run, { issue: 7, model: "opus", checkout: CHECKOUT, env: ENV }))).toContain(
      "could not find issue",
    );
  });

  test("refuses a run with no HOME, where the Worker settings file lives", async () => {
    const { run } = world();

    expect(await failureOf(dispatch(run, { issue: 7, model: "opus", checkout: CHECKOUT, env: {} }))).toContain(
      "HOME is not set",
    );
  });
});
