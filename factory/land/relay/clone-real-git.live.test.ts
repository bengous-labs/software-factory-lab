import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clonesDirOf } from "../../install/paths.ts";
import { runIsolated } from "../../lib/run.live.ts";
import type { Run } from "../../lib/run.port.ts";
import { FIXTURE_ENV, git as fixtureGit } from "../stop/stop.fixtures.ts";
import { cloneEndOf } from "./clone.live.ts";
import { relayFilesOf } from "./relay-start.live.ts";
import { targetTextOf } from "./wakes.ts";

let root = "";

let home = "";

let checkout = "";

let clone = "";

/** Runs git in `cwd` on a fixture repository, and fails the test on an error. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  const ran = await fixtureGit(cwd, ...args);

  expect({ args, code: ran.code }).toEqual({ args, code: 0 });
}

/** The relay's commands: the real git, on the environment the relay pins, and a listing of sessions that shows none running. */
const realGit: Run = (argv, options) =>
  argv[0] === "claude"
    ? Promise.resolve({ code: 0, stdout: "[]", stderr: "" })
    : runIsolated(argv, { ...options, env: { ...FIXTURE_ENV, ...options.env } });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "relay-clone-git-")));
  home = join(root, "home");
  checkout = join(root, "checkout");
  clone = join(clonesDirOf(home), "issue-7");
  mkdirSync(clonesDirOf(home), { recursive: true });
  mkdirSync(relayFilesOf(checkout, 7).stateDir, { recursive: true });
  writeFileSync(
    relayFilesOf(checkout, 7).session,
    targetTextOf({ session: "S1", headless: { model: null, worktree: clone, api: false } }),
  );

  await git(root, "init", "--quiet", "--bare", "--initial-branch=dev", "remote.git");
  await git(root, "clone", "--quiet", join(root, "remote.git"), clone);
  await git(clone, "switch", "--quiet", "-c", "dev");
  writeFileSync(join(clone, "a.ts"), "a\n");
  await git(clone, "add", "a.ts");
  await git(clone, "commit", "--quiet", "-m", "a");
  await git(clone, "push", "--quiet", "origin", "dev");
  await git(clone, "switch", "--quiet", "-c", "issue/7");
  writeFileSync(join(clone, "a.ts"), "b\n");
  await git(clone, "commit", "--quiet", "-am", "b");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const io = () => ({ run: realGit, checkout, home, pr: 7, watches: () => false });

describe("cloneEndOf, on a clone git reads", () => {
  test("a clone whose every branch is pushed, with a clean tree, is removed", async () => {
    await git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/issue/7");
    await git(clone, "fetch", "--quiet", "origin");

    expect(await cloneEndOf(true, io())).toEqual({ removed: true, clone });
    expect(existsSync(clone)).toBe(false);
  });

  test("a commit no remote branch holds keeps it", async () => {
    expect(await cloneEndOf(true, io())).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it holds 1 commit(s) no remote branch holds`,
    });
  });

  test("a changed file, a new one or a stash keeps a pushed clone", async () => {
    await git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/issue/7");
    await git(clone, "fetch", "--quiet", "origin");
    writeFileSync(join(clone, "a.ts"), "c\n");
    writeFileSync(join(clone, "notes.md"), "n\n");

    expect(await cloneEndOf(true, io())).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it holds 2 uncommitted file(s) or stash(es)`,
    });

    mkdirSync(join(clone, "scratch"));
    writeFileSync(join(clone, "scratch", "one.md"), "1\n");
    writeFileSync(join(clone, "scratch", "two.md"), "2\n");

    expect(await cloneEndOf(true, io())).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it holds 4 uncommitted file(s) or stash(es)`,
    });

    rmSync(join(clone, "notes.md"));
    rmSync(join(clone, "scratch"), { recursive: true });
    await git(clone, "stash", "--quiet");

    expect(await cloneEndOf(true, io())).toEqual({
      removed: false,
      why: `its clone ${clone} stays, as it holds 1 uncommitted file(s) or stash(es)`,
    });
    expect(existsSync(clone)).toBe(true);
  });

  test("a submodule the Worker planted is never entered: its config runs nothing", async () => {
    const nested = join(clone, "sub");
    const marker = join(root, "ran");

    await git(root, "init", "--quiet", "--initial-branch=dev", nested);
    writeFileSync(join(nested, "s.ts"), "s\n");
    await git(nested, "add", "s.ts");
    await git(nested, "commit", "--quiet", "-m", "s");
    await git(clone, "add", "sub");
    await git(clone, "commit", "--quiet", "-m", "sub");
    await git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/issue/7");
    await git(nested, "config", "core.fsmonitor", `touch ${marker}`);
    writeFileSync(join(nested, "s.ts"), "changed\n");

    expect(await cloneEndOf(true, io())).toEqual({ removed: true, clone });
    expect(existsSync(marker)).toBe(false);
  });
});
