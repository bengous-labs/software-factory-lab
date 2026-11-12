import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Run } from "../../lib/run.port.ts";
import type { Reader } from "../shared/ask.port.ts";
import { FIXTURE_ENV, fixtureRepo } from "./merge-bot.fixtures.ts";
import { judgeAt } from "./route.live.ts";

/** A `Run` over the fixture's environment, with `base` under the call's own variables. */
const runOver =
  (base: Readonly<Record<string, string>>): Run =>
  async (argv, options) => {
    const child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...FIXTURE_ENV, ...base, ...options.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { code, stdout, stderr };
  };

const fixtureRun = runOver({});

/** A repository whose checkout sits on its first commit, and the head of a PR one commit past it. */
async function prRepo() {
  const { repo, git } = await fixtureRepo("judge-worktree-");

  mkdirSync(join(repo, "app/src"), { recursive: true });
  writeFileSync(join(repo, "app/src/cli.ts"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "a"]);
  writeFileSync(join(repo, "app/src/cli.ts"), "head\n");
  await git(["commit", "-q", "-am", "b"]);
  const head = (await git(["rev-parse", "HEAD"])).text().trim();
  await git(["checkout", "-q", "--detach", "HEAD~1"]);

  const worktrees = async (): Promise<number> =>
    (await git(["worktree", "list", "--porcelain"]))
      .text()
      .split("\n")
      .filter((line) => line.startsWith("worktree ")).length;

  return { checkout: { run: fixtureRun, cwd: repo, head }, worktrees };
}

/** A git that refuses to remove a worktree. */
const refusingRemoval: Run = (argv, options) =>
  argv.includes("remove") ? Promise.resolve({ code: 1, stdout: "", stderr: "locked" }) : fixtureRun(argv, options);

/** A git that cannot even start the `git worktree` command named `verb`: the launch itself fails. */
const unstarted =
  (verb: "remove" | "prune"): Run =>
  (argv, options) =>
    argv.includes(verb) ? Promise.reject(new Error("git did not start")) : fixtureRun(argv, options);

describe("the Routing judge's worktree", () => {
  const JOB = { PATH: "/usr/bin", HOME: "/home/runner", CLAUDE_CODE_OAUTH_TOKEN: "oauth", GH_TOKEN: "app" };

  const ANSWER = {
    routing: { land: "auto", review: "light", secondRound: false, reason: "r", model: "m" },
    tokens: { input: 2, output: 58, cacheRead: 1568, cacheCreation: 6770 },
  } as const;

  const answering = (reader: Reader): Promise<typeof ANSWER> => {
    expect(reader.cwd).not.toBe("");

    return Promise.resolve(ANSWER);
  };

  test("no question makes no worktree and asks nothing", async () => {
    const { checkout, worktrees } = await prRepo();
    const readers: Reader[] = [];

    const answer = await judgeAt({ kind: "none" }, checkout, JOB, (reader) => {
      readers.push(reader);

      return Promise.resolve(ANSWER);
    });

    expect(answer).toBeNull();
    expect(readers).toEqual([]);
    expect(await worktrees()).toBe(1);
  });

  test("the judge reads a worktree of the PR's head under the read guard, with no GitHub token, and the worktree goes after the call", async () => {
    const { checkout, worktrees } = await prRepo();
    const readers: Reader[] = [];
    const seen: string[] = [];

    const answer = await judgeAt({ kind: "ask" }, checkout, JOB, async (reader) => {
      readers.push(reader);
      seen.push(
        readFileSync(join(reader.cwd, "app/src/cli.ts"), "utf8"),
        String(await worktrees()),
        String(existsSync(reader.env.CLAUDE_CONFIG_DIR ?? "")),
        reader.guard("Read", { file_path: "app/src/cli.ts" }).kind,
        reader.guard("Read", { file_path: join(checkout.cwd, "app/src/cli.ts") }).kind,
        reader.guard("Read", { file_path: ".git" }).kind,
      );

      return ANSWER;
    });

    const [reader] = readers;

    expect(answer).toEqual(ANSWER);
    expect(seen).toEqual(["head\n", "2", "true", "allow", "deny", "deny"]);
    expect(reader?.cwd).not.toBe(checkout.cwd);
    expect(Object.keys(reader?.env ?? {}).toSorted()).toEqual([
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "HOME",
      "PATH",
    ]);
    expect(reader?.guard("Write", {})).toEqual({ kind: "deny", reason: "the tool Write is not admitted here" });
    expect(existsSync(reader?.cwd ?? checkout.cwd)).toBe(false);
    expect(existsSync(reader?.env.CLAUDE_CONFIG_DIR ?? checkout.cwd)).toBe(false);
    expect(existsSync(dirname(reader?.cwd ?? checkout.cwd))).toBe(false);
    expect(await worktrees()).toBe(1);
  });

  test("a failed call answers the safe side with its own error, even when the removal fails too, and leaves no worktree", async () => {
    const { checkout, worktrees } = await prRepo();
    const roots: string[] = [];

    const failing = (reader: Reader): Promise<never> => {
      roots.push(reader.cwd);

      return Promise.reject(new Error("the judge broke"));
    };

    expect(await judgeAt({ kind: "ask" }, checkout, JOB, failing)).toMatchObject({
      routing: { review: "deep", secondRound: true, reason: "the Routing judge failed: the judge broke" },
      tokens: null,
    });
    expect(existsSync(roots[0] ?? checkout.cwd)).toBe(false);
    expect(await worktrees()).toBe(1);

    expect(await judgeAt({ kind: "ask" }, { ...checkout, run: refusingRemoval }, JOB, failing)).toMatchObject({
      routing: { reason: "the Routing judge failed: the judge broke" },
    });
    expect(await worktrees()).toBe(1);
  });

  test("a removal that fails after the judge answered keeps the answer, and the worktree is pruned", async () => {
    const { checkout, worktrees } = await prRepo();

    expect(await judgeAt({ kind: "ask" }, { ...checkout, run: refusingRemoval }, JOB, answering)).toEqual(ANSWER);
    expect(await worktrees()).toBe(1);
  });

  test("a removal that cannot even start answers the safe side with that error, whatever the judge answered", async () => {
    const { checkout, worktrees } = await prRepo();

    expect(await judgeAt({ kind: "ask" }, { ...checkout, run: unstarted("remove") }, JOB, answering)).toMatchObject({
      routing: { review: "deep", secondRound: true, reason: "the Routing judge failed: git did not start" },
      tokens: null,
    });
    expect(await worktrees()).toBe(1);
  });

  test("a prune that cannot even start is the one failure that leaves the call", async () => {
    const { checkout } = await prRepo();

    expect(judgeAt({ kind: "ask" }, { ...checkout, run: unstarted("prune") }, JOB, answering)).rejects.toThrow(
      "git did not start",
    );
  });

  test("a worktree or an environment that cannot be made answers the safe side, so the Sweep goes on", async () => {
    const { checkout, worktrees } = await prRepo();

    expect(
      await judgeAt({ kind: "ask" }, checkout, { ...JOB, CLAUDE_CODE_OAUTH_TOKEN: undefined }, answering),
    ).toMatchObject({
      routing: {
        review: "deep",
        secondRound: true,
        reason: "the Routing judge failed: CLAUDE_CODE_OAUTH_TOKEN is unset",
      },
      tokens: null,
    });
    expect(await worktrees()).toBe(1);

    const unknown = await judgeAt({ kind: "ask" }, { ...checkout, head: "f".repeat(40) }, JOB, answering);

    expect(unknown).toMatchObject({ routing: { review: "deep", secondRound: true }, tokens: null });
    expect(unknown?.routing.reason).toStartWith("the Routing judge failed: git worktree add exited");
  });

  test("the checkout runs no filter driver of the runner's system or global git config, LFS included, and no hook", async () => {
    const { repo, git } = await fixtureRepo("judge-filters-");
    const marks = mkdtempSync(join(tmpdir(), "judge-marks-"));
    const globalConfig = join(marks, "gitconfig");
    const systemConfig = join(marks, "system-gitconfig");
    const hooks = join(marks, "hooks");

    const filter = (name: string): string =>
      `[filter "${name}"]\n\tsmudge = sh -c 'touch ${join(marks, `${name}-ran`)}; cat'\n\trequired = true\n`;

    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${join(marks, "hook-ran")}\n`, { mode: 0o755 });
    writeFileSync(globalConfig, filter("evil"));
    writeFileSync(systemConfig, filter("lfs"));
    await git(["config", "core.hooksPath", hooks]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await git(["add", "."]);
    await git(["commit", "-q", "--no-verify", "-m", "a"]);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n*.bin filter=lfs\n");
    writeFileSync(join(repo, "a.txt"), "b\n");
    writeFileSync(join(repo, "b.bin"), "c\n");
    await git(["add", "."]);
    await git(["commit", "-q", "--no-verify", "-m", "b"]);
    const head = (await git(["rev-parse", "HEAD"])).text().trim();

    const checkout = {
      run: runOver({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: systemConfig }),
      cwd: repo,
      head,
    };

    expect(await judgeAt({ kind: "ask" }, checkout, JOB, answering)).toEqual(ANSWER);
    expect(existsSync(join(marks, "evil-ran"))).toBe(false);
    expect(existsSync(join(marks, "lfs-ran"))).toBe(false);
    expect(existsSync(join(marks, "hook-ran"))).toBe(false);
  });
});
